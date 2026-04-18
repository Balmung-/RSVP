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
//   3. We re-dispatch `send_campaign` with `allowDestructive: true`,
//      using the input stored on that messageId row (never the
//      client's POST body — see "trust model" below).
//   4. On success we persist the summary as a new role="assistant"
//      ChatMessage so the transcript stays coherent; audit
//      `ai.confirm.send_campaign`. The client morphs the card
//      in place from the JSON response.
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
// Audit shape:
//   - `ai.confirm.send_campaign` on attempted dispatch (ok or not),
//     mirroring the `ai.tool.*` convention. `data.via = "confirm"`
//     distinguishes operator-confirmed sends from any future
//     direct-dispatch path.
//   - `ai.denied.send_campaign` on pre-dispatch denials at this
//     route layer (stale id, wrong tool, corrupt input). These are
//     things the dispatcher never sees, so they need a separate
//     audit kind. Handler-level refusals (forbidden, not_found,
//     status_not_sendable, send_in_flight) land under
//     `ai.confirm.send_campaign` with `ok=false`.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

  const ctx = await buildToolCtx(me);
  const result = await dispatch("send_campaign", parsedInput, ctx, {
    allowDestructive: true,
  });

  // Audit before persisting the assistant row so the confirm event
  // lands even if the transcript write fails (logAction swallows its
  // own errors; the ChatMessage.create below could still throw).
  await logAction({
    kind: "ai.confirm.send_campaign",
    refType: "ChatSession",
    refId: row.sessionId,
    actorId: me.id,
    data: {
      via: "confirm",
      ok: result.ok,
      error: result.ok ? null : result.error,
      messageId,
      sessionId: row.sessionId,
    },
  });

  if (!result.ok) {
    // Dispatch-layer failures (shouldn't happen post-gate but possible
    // if the tool throws before it can return a structured output).
    return NextResponse.json(
      { ok: false, error: result.error },
      { status: 400 },
    );
  }

  const output = result.result.output;
  // Guarded boolean — a bare `x && typeof === "object" && "error" in x`
  // reduces to `""` when `output` is the empty string, which
  // Prisma's `Boolean` field rejects at the type layer. Force a
  // concrete boolean.
  const isStructuredError: boolean =
    typeof output === "object" && output !== null && "error" in output;

  const summary =
    typeof output === "string"
      ? output
      : typeof (output as Record<string, unknown>).summary === "string"
        ? String((output as Record<string, unknown>).summary)
        : "Send complete.";

  // Persist as a plain assistant text turn. Why not role="tool"?
  // Because rebuildMessages groups trailing role="tool" rows into the
  // PRECEDING assistant turn's tool_use blocks (see
  // src/lib/ai/transcript.ts) — and no assistant turn here actually
  // called send_campaign. A tool row would fabricate a tool_use the
  // model never made and derail replay. role="assistant" with plain
  // text slots in cleanly after the tool-result pseudo-turn emitted
  // for propose_send, preserving user/assistant alternation.
  //
  // On handler-level refusal (forbidden / status_not_sendable / etc.)
  // we STILL persist — the operator's transcript should show that
  // they clicked and what happened.
  await prisma.chatMessage.create({
    data: {
      sessionId: row.sessionId,
      role: "assistant",
      content: summary,
      isError: isStructuredError,
    },
  });

  return NextResponse.json({
    ok: true,
    result: output,
    summary,
  });
}
