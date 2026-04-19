import type { DispatchResult, ToolCtx } from "./tools/types";
import { classifyOutcome } from "./confirm-classify";

// Pure core of the `/api/chat/confirm/[messageId]` route. The route
// proper still owns auth, rate limiting, row lookup, and the
// pre-claim pre-checks (wrong_tool, anchor_was_error, corrupt input)
// — those all happen BEFORE any destructive action is even
// considered and each has its own 4xx path that's not part of the
// claim contract. Everything FROM the already_confirmed fast-path
// through the HTTP response is owned here.
//
// Why extract this? Two reasons:
//   1. The Push 7 single-use anchor — "second POST with the same
//      messageId returns 409 already_confirmed" — is the highest-
//      risk destructive-path regression in the whole surface. A DB
//      dependency in the test would require a committed test DB
//      harness; by taking prisma, dispatch, and the logger as a
//      port, the flow is testable with fakes that simulate the
//      atomic claim semantics. See
//      `tests/unit/confirm-single-use.test.ts`.
//   2. Keeps the route thin. All the business logic — ordering of
//      claim/dispatch/release/audit/persist, the summary text, the
//      status codes — lives in one place that can be read straight
//      through.
//
// IMPORTANT — port contract. Callers must ensure `claim()` is
// ATOMIC with respect to the `confirmedAt IS NULL` predicate: two
// concurrent callers see exactly one winner (`count: 1`) and one
// loser (`count: 0`). The production implementation uses
// `prisma.chatMessage.updateMany({where: {id, confirmedAt: null},
// data: {confirmedAt: now}})`, which Postgres executes as a single
// row-locking UPDATE. Any other implementation (application-level
// read-then-write, for instance) would break the guarantee — this
// helper assumes the port honours it.

export type ConfirmRow = {
  id: string;
  sessionId: string;
  confirmedAt: Date | null;
};

export type ConfirmPort = {
  // Atomic single-use claim. Equivalent to a conditional update with
  // a `confirmedAt IS NULL` predicate: returns `{count: 1}` if this
  // call won the claim, `{count: 0}` if another caller beat it (or
  // the anchor was already confirmed).
  claim: () => Promise<{ count: number }>;
  // Unconditional release — undoes the claim so the operator can
  // retry. Only called on releasable-refusal paths.
  release: () => Promise<void>;
  // Dispatch the destructive send_campaign. Production implementation
  // closes over the tool name plus `allowDestructive: true`.
  dispatchSend: (input: unknown, ctx: ToolCtx) => Promise<DispatchResult>;
  // Persist the operator-visible transcript row (success or failure).
  persistTranscript: (args: {
    sessionId: string;
    content: string;
    isError: boolean;
  }) => Promise<void>;
  // Audit the attempted confirm. `data.ok` reflects EFFECTIVE outcome
  // (structured refusal lands as `ok: false`), so the audit stream
  // can be scanned for real sends by a single filter.
  auditConfirm: (args: {
    sessionId: string;
    data: Record<string, unknown>;
  }) => Promise<void>;
  // Audit pre-dispatch denials at this layer — specifically the two
  // already_confirmed paths (fast-path and race-path). The
  // pre-claim denials (wrong_tool, anchor_was_error, corrupt_input)
  // are audited by the route itself before runConfirmSend is called.
  auditDenied: (args: {
    sessionId: string;
    data: Record<string, unknown>;
  }) => Promise<void>;
};

export type ConfirmResponse = {
  status: number;
  body: Record<string, unknown>;
};

// Run the full confirm-send flow against the provided port. Returns
// the HTTP status + body for the route to serialise with
// NextResponse.json. Never throws — all errors from the dispatcher
// are surfaced as structured responses via classifyOutcome.
export async function runConfirmSend(
  row: ConfirmRow,
  messageId: string,
  parsedInput: unknown,
  ctx: ToolCtx,
  port: ConfirmPort,
): Promise<ConfirmResponse> {
  // Fast-path already_confirmed check. Not race-safe on its own —
  // two parallel clicks can both see confirmedAt=null here — but the
  // atomic claim below is the real guard. This just yields a faster
  // 409 on the common "refreshed the tab, clicked again" case
  // without doing a dispatch.
  if (row.confirmedAt) {
    await port.auditDenied({
      sessionId: row.sessionId,
      data: {
        via: "confirm",
        reason: "already_confirmed",
        messageId,
        confirmedAt: row.confirmedAt.toISOString(),
      },
    });
    return {
      status: 409,
      body: { ok: false, error: "already_confirmed" },
    };
  }

  // Atomic single-use claim. The port's `confirmedAt IS NULL`
  // predicate is what makes this race-safe: two parallel clicks
  // race on the same row, exactly one wins (count=1), the other
  // gets already_confirmed.
  const claim = await port.claim();
  if (claim.count === 0) {
    // Lost the race. Another POST claimed between our row lookup
    // and this claim; surface already_confirmed.
    await port.auditDenied({
      sessionId: row.sessionId,
      data: {
        via: "confirm",
        reason: "already_confirmed",
        messageId,
        raced: true,
      },
    });
    return {
      status: 409,
      body: { ok: false, error: "already_confirmed" },
    };
  }

  // We own the claim. From here on, any exit path that doesn't
  // actually send MUST release the claim — see
  // shouldReleaseClaim below and RELEASABLE_REFUSALS in
  // confirm-classify.ts for the whitelist rationale.
  const result = await port.dispatchSend(parsedInput, ctx);

  // `result.ok` only tells us whether dispatch reached the handler
  // — a structured refusal (`return {output: {error: "..."}}`) still
  // lands under `result.ok === true`. classifyOutcome flips to
  // effective failure when the handler's output carries an error
  // field, and tells us whether this outcome is safe to release the
  // claim on.
  const {
    effectiveOk,
    effectiveError,
    shouldReleaseClaim,
    handlerSummary,
    output,
  } = classifyOutcome(result);

  // Release the claim only on a refusal that couldn't have sent
  // anything (dispatch-throws keep the claim because the throw
  // could have happened inside sendCampaign's per-invitee loop
  // with partial state).
  if (shouldReleaseClaim) {
    await port.release();
  }

  // Audit reflects the EFFECTIVE outcome.
  await port.auditConfirm({
    sessionId: row.sessionId,
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
  // On failure, surface the error code + any handler summary so the
  // operator reads something actionable in the transcript.
  const summary = effectiveOk
    ? (handlerSummary ??
      (typeof output === "string" ? output : "Send complete."))
    : `Send refused: ${effectiveError ?? "unknown"}${handlerSummary ? ` — ${handlerSummary}` : ""}`;

  // Persist on BOTH paths — the operator's transcript should show
  // that they clicked and what happened.
  await port.persistTranscript({
    sessionId: row.sessionId,
    content: summary,
    isError: !effectiveOk,
  });

  if (!effectiveOk) {
    return {
      status: 400,
      body: { ok: false, error: effectiveError, summary },
    };
  }

  return {
    status: 200,
    body: { ok: true, result: output, summary },
  };
}
