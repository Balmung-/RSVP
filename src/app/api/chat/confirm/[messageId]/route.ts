import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/ratelimit";
import { prisma } from "@/lib/db";
import { logAction } from "@/lib/audit";
import { buildToolCtx } from "@/lib/ai/ctx";
import { dispatch } from "@/lib/ai/tools";

// The confirmation endpoint for destructive AI actions.
//
// Flow:
//   1. During a chat turn, the model calls `propose_send`. The tool
//      handler computes the preview and emits a `confirm_send`
//      directive; the chat route persists the tool row AND threads
//      that row's id into the directive envelope as `messageId`.
//   2. <ConfirmSend/> renders with the messageId and a button that
//      POSTs here.
//   3. We atomically claim the anchor row (`confirmedAt: null` →
//      now), then re-dispatch `send_campaign` with
//      `allowDestructive: true`, using the input stored on that
//      messageId row (never the client's POST body — see "trust
//      model" below).
//   4. On success we persist the summary as a new role="assistant"
//      ChatMessage so the transcript stays coherent; audit
//      `ai.confirm.send_campaign`. The client morphs the card
//      in place from the JSON response.
//   5. On a structured-refusal path (status_not_sendable /
//      send_in_flight / forbidden / not_found — all of which
//      refuse BEFORE any send fan-out), we release the claim so
//      the operator can retry. On a dispatch-throw or a real send,
//      the claim stays — retrying would either re-send partial
//      state (bad) or duplicate a completed send (worse).
//
// Trust model — why the POST takes no body:
//   - The operator's click authorizes EXECUTING the proposal, not
//     redefining it. The campaign_id / channel / only_unsent were
//     the ones the model resolved, persisted, and rendered in the
//     card the operator read. Accepting them again from the client
//     would open a swap-the-target attack: click "Send" on preview A,
//     intercept the POST, swap to campaign B in the body, and the
//     route would happily send B. Reading straight from the stored
//     toolInput closes that.
//   - messageId in the URL is the authorization anchor: ownership
//     is enforced via a session-join (see the `where` below), not
//     via a separately-supplied user id.
//
// Idempotency — why the anchor is single-use (Push 7 fix):
//   - Without a server-side gate, a repeat POST against the same
//     messageId (retry after transient error, browser back/forward,
//     forged request, or a future client that rehydrates stale
//     directives) would re-dispatch `send_campaign` and really re-
//     send. The ConfirmSend "button hidden after success" is local
//     React state only and cannot defend against this.
//   - The atomic claim via
//     `updateMany({where: {id, confirmedAt: null}, data: {confirmedAt: now}})`
//     is race-safe: two concurrent clicks see ONE winner (count=1)
//     and ONE loser (count=0 → already_confirmed audit + 409).
//   - On a refusal-that-did-not-send, we release the claim. Only
//     the four `send_campaign` handler refusals
//     (forbidden / not_found / status_not_sendable / send_in_flight)
//     qualify — every one of those returns BEFORE the sendCampaign
//     fan-out in src/lib/campaigns.ts begins touching providers.
//     Dispatch-throws (`result.ok === false`) do NOT release: a
//     throw inside sendCampaign could have left partial state.
//
// Success vs structured-refusal — why we inspect tool output (Push 7 fix):
//   - `dispatch` returns `{ok: true, result: {output: {...}}}` for
//     ANY path the handler reaches (including
//     `return {output: {error: "status_not_sendable", ...}}`).
//     Naively treating `result.ok === true` as HTTP success would
//     land a structured refusal in the emerald "Sent" UI state and
//     in the audit log as `ok: true` — a lie in both surfaces.
//   - We inspect the output for an `error` field and flip the
//     effective outcome (HTTP contract, audit, persisted
//     `isError`) to failure in that case. Dispatch-layer failures
//     (`result.ok === false`) are also failures. Everything else
//     is a real success.
//
// Audit shape:
//   - `ai.confirm.send_campaign` on attempted dispatch. `data.ok`
//     reflects the EFFECTIVE outcome (not just whether dispatch
//     returned), so a structured refusal records `ok: false` with
//     the handler's error as `data.error`.
//   - `ai.denied.send_campaign` on pre-dispatch denials at this
//     route layer (stale id, wrong tool, corrupt input, anchor was
//     itself an error, anchor already confirmed). These are
//     things the dispatcher never sees, so they need a separate
//     audit kind.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Handler-refusal error codes that are safe to release the
// single-use claim on. Every one of these is a guard that returns
// BEFORE send_campaign hands off to sendCampaign()'s fan-out — so
// retrying cannot double-send. Any other error (including a
// dispatch-layer throw bubbling up as handler_error:*) keeps the
// claim in place.
//
// Blocker codes (`no_*`) are sourced from `src/lib/ai/tools/
// send-blockers.ts::computeBlockers` — the same helper
// propose_send uses to surface blockers to the ConfirmSend
// directive. send_campaign re-checks that helper at confirm time
// and refuses with the first non-status blocker as the error
// code; all of those refusals happen before sendCampaign's
// fan-out, hence releasable.
const RELEASABLE_REFUSALS = new Set([
  "forbidden",
  "not_found",
  "status_not_sendable",
  "send_in_flight",
  "no_invitees",
  "no_ready_messages",
  "no_email_template",
  "no_sms_template",
]);

export async function POST(
  _req: Request,
  { params }: { params: { messageId: string } },
) {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  // Share the chat bucket. Operators who hammer Confirm share the
  // same burst budget as their chat turns — both end up doing a
  // handler dispatch, so the cost profile matches.
  const rl = rateLimit(`chat:${me.id}`, { capacity: 8, refillPerSec: 0.3 });
  if (!rl.ok) {
    return NextResponse.json(
      { ok: false, error: "rate_limited", retryAfterMs: rl.retryAfterMs },
      { status: 429 },
    );
  }

  const messageId = params.messageId;
  if (typeof messageId !== "string" || messageId.length === 0) {
    return NextResponse.json(
      { ok: false, error: "bad_message_id" },
      { status: 400 },
    );
  }

  // Ownership check via session join. A row belonging to a different
  // user's session collapses to `not_found` — not `forbidden` — so
  // an attacker can't probe for valid message ids.
  const row = await prisma.chatMessage.findFirst({
    where: {
      id: messageId,
      role: "tool",
      session: { userId: me.id },
    },
    select: {
      id: true,
      sessionId: true,
      toolName: true,
      toolInput: true,
      isError: true,
      confirmedAt: true,
    },
  });
  if (!row) {
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404 },
    );
  }

  // Only propose_send rows are valid confirmation anchors. Future
  // destructive previews (e.g. propose_archive) will add their own
  // allow-list entry here.
  if (row.toolName !== "propose_send") {
    await logAction({
      kind: "ai.denied.send_campaign",
      refType: "ChatSession",
      refId: row.sessionId,
      actorId: me.id,
      data: {
        via: "confirm",
        reason: "wrong_tool",
        messageId,
        toolName: row.toolName,
      },
    });
    return NextResponse.json(
      { ok: false, error: "wrong_tool" },
      { status: 400 },
    );
  }

  // If the anchor row ITSELF was an error (e.g. propose_send
  // returned `forbidden` or `not_found`), there's no coherent
  // destructive action to confirm — something likely went wrong on
  // the UI side letting the button render at all. Refuse loudly
  // rather than re-dispatching blind.
  if (row.isError) {
    await logAction({
      kind: "ai.denied.send_campaign",
      refType: "ChatSession",
      refId: row.sessionId,
      actorId: me.id,
      data: { via: "confirm", reason: "anchor_was_error", messageId },
    });
    return NextResponse.json(
      { ok: false, error: "anchor_was_error" },
      { status: 400 },
    );
  }

  // Fast-path already_confirmed check. Not race-safe on its own —
  // two parallel clicks can both see confirmedAt=null here — but
  // the atomic claim below is the real guard. This just yields a
  // faster 409 on the common "refreshed the tab, clicked again"
  // case without needing to compute ctx / parse input.
  if (row.confirmedAt) {
    await logAction({
      kind: "ai.denied.send_campaign",
      refType: "ChatSession",
      refId: row.sessionId,
      actorId: me.id,
      data: {
        via: "confirm",
        reason: "already_confirmed",
        messageId,
        confirmedAt: row.confirmedAt.toISOString(),
      },
    });
    return NextResponse.json(
      { ok: false, error: "already_confirmed" },
      { status: 409 },
    );
  }

  // Recover the propose_send input. Its shape is a SUPERSET-compatible
  // pass-through for send_campaign (both tools accept campaign_id +
  // optional channel + optional only_unsent), so we forward verbatim
  // and let send_campaign's validate() reject anything unexpected.
  let parsedInput: unknown = {};
  if (row.toolInput) {
    try {
      parsedInput = JSON.parse(row.toolInput);
    } catch {
      await logAction({
        kind: "ai.denied.send_campaign",
        refType: "ChatSession",
        refId: row.sessionId,
        actorId: me.id,
        data: { via: "confirm", reason: "corrupt_input", messageId },
      });
      return NextResponse.json(
        { ok: false, error: "corrupt_input" },
        { status: 400 },
      );
    }
  }

  // Atomic single-use claim. The `confirmedAt: null` predicate is
  // what makes this race-safe — two parallel clicks race on the
  // same row, exactly one wins (count=1), the other gets
  // already_confirmed. Stamp the time now rather than post-
  // dispatch so any subsequent arrivals see it immediately.
  const claim = await prisma.chatMessage.updateMany({
    where: { id: row.id, confirmedAt: null },
    data: { confirmedAt: new Date() },
  });
  if (claim.count === 0) {
    // Lost the race. Either a concurrent POST claimed between our
    // findFirst and this updateMany, or the fast-path check above
    // missed due to replica lag. Either way the other request is
    // authoritative; surface already_confirmed.
    await logAction({
      kind: "ai.denied.send_campaign",
      refType: "ChatSession",
      refId: row.sessionId,
      actorId: me.id,
      data: {
        via: "confirm",
        reason: "already_confirmed",
        messageId,
        raced: true,
      },
    });
    return NextResponse.json(
      { ok: false, error: "already_confirmed" },
      { status: 409 },
    );
  }

  // We own the claim. From here on, any exit path that doesn't
  // actually send MUST release the claim (see RELEASABLE_REFUSALS).
  const ctx = await buildToolCtx(me);
  const result = await dispatch("send_campaign", parsedInput, ctx, {
    allowDestructive: true,
  });

  // Classify the outcome. `result.ok` only tells us whether
  // dispatch reached the handler — a structured refusal
  // (`return {output: {error: "..."}}`) still lands under
  // `result.ok === true`. We flip to effective failure when the
  // handler's output carries an error field.
  const output = result.ok ? result.result.output : null;
  const structuredError: string | null =
    result.ok &&
    typeof output === "object" &&
    output !== null &&
    "error" in output &&
    typeof (output as Record<string, unknown>).error === "string"
      ? String((output as Record<string, unknown>).error)
      : null;
  const dispatchError: string | null = result.ok ? null : result.error;
  const effectiveOk = result.ok && !structuredError;
  const effectiveError: string | null =
    structuredError ?? dispatchError ?? null;

  // Release the claim only on a refusal that couldn't have sent
  // anything. See RELEASABLE_REFUSALS for the whitelist rationale.
  // Dispatch-throws (`handler_error:*`) keep the claim because the
  // throw could have happened inside sendCampaign's per-invitee
  // loop with partial state.
  if (
    !effectiveOk &&
    structuredError &&
    RELEASABLE_REFUSALS.has(structuredError)
  ) {
    await prisma.chatMessage.updateMany({
      where: { id: row.id },
      data: { confirmedAt: null },
    });
  }

  // Audit reflects the EFFECTIVE outcome. A structured refusal
  // lands as ok:false with the handler error, so the audit stream
  // can be scanned for real sends vs refused attempts by a single
  // data.ok filter.
  await logAction({
    kind: "ai.confirm.send_campaign",
    refType: "ChatSession",
    refId: row.sessionId,
    actorId: me.id,
    data: {
      via: "confirm",
      ok: effectiveOk,
      error: effectiveOk ? null : effectiveError,
      messageId,
      sessionId: row.sessionId,
    },
  });

  // Summary text for the transcript row. On success, prefer the
  // handler's summary (it carries "Sent N: E email, S sms" already).
  // On failure, surface the error code + any handler summary so
  // the operator reads something actionable in the transcript.
  const handlerSummary: string | null =
    output &&
    typeof output === "object" &&
    typeof (output as Record<string, unknown>).summary === "string"
      ? String((output as Record<string, unknown>).summary)
      : null;
  const summary = effectiveOk
    ? (handlerSummary ??
      (typeof output === "string" ? output : "Send complete."))
    : `Send refused: ${effectiveError ?? "unknown"}${handlerSummary ? ` — ${handlerSummary}` : ""}`;

  // Persist as a plain assistant text turn. Why not role="tool"?
  // Because rebuildMessages groups trailing role="tool" rows into
  // the PRECEDING assistant turn's tool_use blocks (see
  // src/lib/ai/transcript.ts) — and no assistant turn here actually
  // called send_campaign. A tool row would fabricate a tool_use the
  // model never made and derail replay. role="assistant" with plain
  // text slots in cleanly after the tool-result pseudo-turn emitted
  // for propose_send, preserving user/assistant alternation.
  //
  // We persist on BOTH paths — the operator's transcript should
  // show that they clicked and what happened.
  await prisma.chatMessage.create({
    data: {
      sessionId: row.sessionId,
      role: "assistant",
      content: summary,
      isError: !effectiveOk,
    },
  });

  if (!effectiveOk) {
    return NextResponse.json(
      { ok: false, error: effectiveError, summary },
      { status: 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    result: output,
    summary,
  });
}
