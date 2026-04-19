import type { DispatchResult } from "./tools/types";

// Pure helpers for classifying a confirm-route tool dispatch. Split
// out of `src/app/api/chat/confirm/[messageId]/route.ts` so the
// Push 7 fix (structured-refusal masks success) can be unit-tested
// without standing up the full Next route + Prisma.
//
// Two distinct error sources must be classified:
//
//   1. Dispatch-layer failure — `dispatch(...)` returns
//      `{ok: false, error: "..."}`. Reasons include unknown_tool,
//      invalid_input, needs_confirmation (destructive without
//      allowDestructive), handler_error:* (uncaught handler throw).
//
//   2. Handler structured refusal — `dispatch(...)` returns
//      `{ok: true, result: {output: {error: "code", summary?: "..."}}}`.
//      The handler returned a well-formed output, but the output
//      announces refusal (e.g. status_not_sendable, no_ready_messages).
//
// Before Push 7 fix, the confirm route treated `result.ok === true`
// as HTTP success unconditionally. A structured refusal like
// `status_not_sendable` was then painted in the emerald "Sent" UI
// state and logged as `ok: true` — a lie in both surfaces. The fix
// inspects `output.error` and flips the effective outcome when
// found; `classifyOutcome` captures that logic.

// Handler-refusal error codes that are safe to release the
// single-use claim on. Every one of these is a guard that returns
// BEFORE `sendCampaign()` begins its per-invitee fan-out. Any other
// error (including dispatch-layer throws surfaced as
// `handler_error:*`) must keep the claim in place — a throw inside
// the fan-out could have left partial state and retrying would
// double-send.
//
// Sourced from two places that must stay in sync:
//   - Preflight guards in `src/lib/ai/tools/send_campaign.ts` that
//     refuse before fan-out: `forbidden`, `not_found`,
//     `status_not_sendable`, `send_in_flight`.
//   - Blocker codes from `src/lib/ai/tools/send-blockers.ts::
//     computeBlockers` that `send_campaign` re-enforces at confirm
//     time: `no_invitees`, `no_ready_messages`, `no_email_template`,
//     `no_sms_template`.
export const RELEASABLE_REFUSALS = new Set([
  "forbidden",
  "not_found",
  "status_not_sendable",
  "send_in_flight",
  "no_invitees",
  "no_ready_messages",
  "no_email_template",
  "no_sms_template",
]);

export function isReleasableRefusal(code: string | null | undefined): boolean {
  return typeof code === "string" && RELEASABLE_REFUSALS.has(code);
}

// P7 — releasable-refusal whitelist for the import confirm flow.
//
// Parallel to `RELEASABLE_REFUSALS` above. Every code in this set is
// a guard inside `commit_import` that returns BEFORE the planner
// runs its `createMany` — none of them could have committed partial
// state, so it's safe to release the single-use anchor and let the
// operator retry.
//
// Sourced from the refusal surface of `src/lib/ai/tools/commit_import.ts`:
//   - `forbidden`                  — editor role gate failed
//   - `not_found`                  — ingest not under operator scope
//   - `campaign_not_found`         — invitees campaign not in scope
//   - `no_campaign_for_invitees`   — invitees target missing campaign_id
//   - `file_not_extracted`         — ingest has no extracted text
//   - `nothing_to_commit`          — planner found zero committable rows
//
// NOT included (intentionally): dispatch-layer errors (handler_error:*,
// needs_confirmation) keep the claim like on the send path. And any
// refusal emitted by a future planner-inside-transaction code path
// would NOT belong here without verifying it returns before the write
// — same discipline as the send whitelist.
export const RELEASABLE_IMPORT_REFUSALS = new Set([
  "forbidden",
  "not_found",
  "campaign_not_found",
  "no_campaign_for_invitees",
  "file_not_extracted",
  "nothing_to_commit",
]);

export function isReleasableImportRefusal(
  code: string | null | undefined,
): boolean {
  return typeof code === "string" && RELEASABLE_IMPORT_REFUSALS.has(code);
}

// Overload of classifyOutcome that uses the import whitelist instead
// of the send whitelist. The rest of the classification logic is
// identical — only `shouldReleaseClaim` differs. We could parameterise
// classifyOutcome itself on the whitelist, but a second named entry
// point keeps the two confirm flows honest: each flow imports its
// matching classifier and there's no way to accidentally release on a
// whitelist that doesn't apply to its handler's refusal surface.
export function classifyImportOutcome(result: DispatchResult): Classification {
  const base = classifyOutcome(result);
  const shouldReleaseClaim =
    !base.effectiveOk && isReleasableImportRefusal(base.structuredError);
  return { ...base, shouldReleaseClaim };
}

export type Classification = {
  // True only when the handler reached a real send path. A
  // structured refusal (handler returned `output.error`) is false
  // here even though `dispatch` returned ok.
  effectiveOk: boolean;
  // The handler's declared error code, if the output carries one.
  // Null otherwise.
  structuredError: string | null;
  // The dispatcher's error string, if dispatch itself failed.
  // Null otherwise.
  dispatchError: string | null;
  // The error the caller should surface — handler's structured
  // error takes priority, then dispatch error, then null on success.
  effectiveError: string | null;
  // Convenience: whether this outcome should release the single-use
  // claim. Only releasable refusals AND only when effectiveOk is
  // false.
  shouldReleaseClaim: boolean;
  // The handler's summary string, if it returned one. Surfaced into
  // the assistant transcript row for operator visibility on both
  // success and refusal paths.
  handlerSummary: string | null;
  // Raw output from the handler, for callers that want to forward
  // it to the client on the success path.
  output: unknown;
};

// Classify a `DispatchResult` into the effective outcome shape used
// by the confirm route. Pure — no side effects, no I/O.
export function classifyOutcome(result: DispatchResult): Classification {
  const output = result.ok ? result.result.output : null;

  let structuredError: string | null = null;
  let handlerSummary: string | null = null;
  if (result.ok && output !== null && typeof output === "object") {
    const rec = output as Record<string, unknown>;
    if ("error" in rec && typeof rec.error === "string") {
      structuredError = rec.error;
    }
    if ("summary" in rec && typeof rec.summary === "string") {
      handlerSummary = rec.summary;
    }
  }

  const dispatchError: string | null = result.ok ? null : result.error;
  const effectiveOk = result.ok && structuredError === null;
  const effectiveError = structuredError ?? dispatchError ?? null;
  const shouldReleaseClaim =
    !effectiveOk && isReleasableRefusal(structuredError);

  return {
    effectiveOk,
    structuredError,
    dispatchError,
    effectiveError,
    shouldReleaseClaim,
    handlerSummary,
    output,
  };
}
