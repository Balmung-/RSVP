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

// W5 — the terminal outcome the route persists onto the confirm_send
// widget's props after dispatch. The client's local React state
// already flipped to "done"/"error" on the JSON response; this write
// is what makes the state survive a reload. `submitting` is NEVER
// passed here — it's a client-local transient that the DB never
// sees. See `validateConfirmSend` in `widget-validate.ts` for the
// invariants enforced at the boundary.
export type ConfirmSendOutcome =
  | {
      state: "done";
      // P13-D.2 — `whatsapp` is an additive counter. `send_campaign`'s
      // handler always returns it (0 on two-channel sends), so the
      // outcome writer persists a uniform four-counter shape regardless
      // of the caller's chosen channel. Matches `validateConfirmSendResult`
      // in `widget-validate.ts:370-384`.
      result: {
        email: number;
        sms: number;
        whatsapp: number;
        skipped: number;
        failed: number;
      };
      summary?: string;
    }
  | {
      state: "error";
      error: string;
      summary?: string;
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
  // W5 — write the post-dispatch terminal state onto the
  // `confirm_send` widget row. Called exactly once per winning claim,
  // AFTER `auditConfirm` / `persistTranscript` so the audit + replay
  // record is complete even if this write fails. Implementations read
  // the existing widget row, merge state/result/error/summary into
  // its props, and upsert; see the route binding for the reference
  // implementation. Errors here are swallowed by the flow — the
  // operator already got their outcome in the JSON response, and a
  // missed widget update shows up as a pre-action card on next
  // reload rather than breaking the response.
  markConfirmSendOutcome: (outcome: ConfirmSendOutcome) => Promise<void>;
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

  // W5 — persist the terminal state onto the confirm_send widget.
  // The client's JSON response already told the local UI to flip;
  // this write makes that flip survive a reload. We compute the
  // outcome shape from the same `output` + `effectiveError` the
  // audit/transcript used, so the three surfaces (audit row,
  // transcript row, widget row) agree on what happened.
  //
  // On success the send_campaign handler returns counters directly on
  // its output ({email, sms, skipped, failed}); coerce defensively
  // (0 if missing/non-finite) because the validator rejects NaN.
  // On failure we persist the error code that went into the audit —
  // same surface the operator saw in the response body.
  let outcome: ConfirmSendOutcome;
  if (effectiveOk) {
    const rec =
      output !== null && typeof output === "object"
        ? (output as Record<string, unknown>)
        : {};
    outcome = {
      state: "done",
      result: {
        email: asFiniteNumber(rec.email),
        sms: asFiniteNumber(rec.sms),
        // P13-D.2 — additive counter. `rec.whatsapp` is present on
        // every `send_campaign` success response; coerce defensively
        // (0 when missing) so an older transcript replay or a dispatch
        // path that somehow omits the field still persists a valid
        // blob the widget validator accepts.
        whatsapp: asFiniteNumber(rec.whatsapp),
        skipped: asFiniteNumber(rec.skipped),
        failed: asFiniteNumber(rec.failed),
      },
      summary,
    };
  } else {
    outcome = {
      state: "error",
      // `effectiveError` is the same code the audit recorded; default
      // to "unknown" on the pathological null case so the validator's
      // non-empty-string invariant holds.
      error: effectiveError ?? "unknown",
      summary,
    };
  }
  // Swallow write errors: the operator already has their outcome in
  // the response body + transcript; a widget row write failure is
  // recoverable (the next reload sees the prior `ready`/`blocked`
  // state and the action is idempotent via the single-use anchor).
  // Logging stays at the route level where the logger context lives.
  try {
    await port.markConfirmSendOutcome(outcome);
  } catch {
    // intentionally no-op
  }

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

// Coerce a handler-output field to a finite number, defaulting to 0
// for missing / non-numeric / NaN / Infinity. The send_campaign
// handler produces finite integers on the happy path, but a future
// handler bug or structured refusal wrapped in a success envelope
// could surface junk — the validator would then reject the widget
// write and we'd lose the state transition. Coerce once here so the
// write always lands.
function asFiniteNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
