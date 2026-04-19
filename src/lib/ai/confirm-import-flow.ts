import type { DispatchResult, ToolCtx } from "./tools/types";
import { classifyImportOutcome } from "./confirm-classify";

// P7 — pure core of the import arm of `/api/chat/confirm/[messageId]`.
//
// Parallel to `confirm-flow.ts::runConfirmSend`. Same contract:
//   - single-use anchor, claimed atomically by the port
//   - handler is the destructive `commit_import` tool, dispatched with
//     `allowDestructive: true`
//   - structured refusals on the releasable whitelist release the
//     claim; dispatch-throws or "real" commit errors keep it
//   - audit, transcript, terminal-state widget write happen in that
//     order so every surface agrees on what happened
//
// Why a second module rather than generalising `confirm-flow.ts`:
//   - The outcome shape differs — send reports `{email, sms, skipped,
//     failed}`, import reports `{created, existingSkipped,
//     duplicatesInFile, invalid, errors}`. Mashing both into one
//     generic type would either leak union branches into every reader
//     or introduce "which field is meaningful" ambiguity for the
//     transcript summary.
//   - The whitelists differ — `RELEASABLE_REFUSALS` vs
//     `RELEASABLE_IMPORT_REFUSALS`. Each confirm flow importing its
//     matching classifier is what keeps those two sets from silently
//     cross-pollinating.
//   - The widget key formula differs (confirm.send.<campaign_id> vs
//     confirm.import.<target>.<ingestId>). The port seam hides this
//     from the core, but the outcome marker binding in the route is
//     where the two shapes visibly diverge.
//
// Everything else (claim ordering, audit-before-persist, swallowed
// widget write errors) is the same contract `runConfirmSend` documents.

export type ConfirmRow = {
  id: string;
  sessionId: string;
  confirmedAt: Date | null;
};

// Terminal outcome persisted onto the `confirm_import` widget after
// the commit dispatch returns. `submitting` is client-local (see
// `confirm-flow.ts::ConfirmSendOutcome` note) — the DB only ever sees
// a terminal state here.
//
// `result` on `done` mirrors the shape `validateImportResult` pins on
// the widget props: `created` / `existingSkipped` (rows that matched
// an existing DB key) / `duplicatesInFile` (within-file dupes
// surfaced ONLY on the commit path — the preview can't distinguish
// these) / `invalid` / `errors` (driver-level skip; happy path is 0).
// Every counter is non-negative, non-NaN — coerced in the flow below.
export type ConfirmImportOutcome =
  | {
      state: "done";
      result: {
        created: number;
        existingSkipped: number;
        duplicatesInFile: number;
        invalid: number;
        errors: number;
      };
      summary?: string;
    }
  | {
      state: "error";
      error: string;
      summary?: string;
    };

export type ConfirmImportPort = {
  // Atomic single-use claim. Same contract as `ConfirmPort::claim`
  // in confirm-flow.ts — a `confirmedAt IS NULL` predicate on the
  // anchor row, one winner per race.
  claim: () => Promise<{ count: number }>;
  // Unconditional release — undoes the claim. Called only on
  // releasable-refusal paths (see RELEASABLE_IMPORT_REFUSALS).
  release: () => Promise<void>;
  // Dispatch the destructive commit_import. Production binding
  // closes over `allowDestructive: true`; only this seam sets that
  // flag for the import path.
  dispatchCommit: (input: unknown, ctx: ToolCtx) => Promise<DispatchResult>;
  // Persist the operator-visible transcript row. Same plain
  // role="assistant" shape the send flow uses — see
  // confirm-flow.ts::persistTranscript for the "why not role=tool"
  // rationale (transcript replay would fabricate a tool_use the
  // model never made).
  persistTranscript: (args: {
    sessionId: string;
    content: string;
    isError: boolean;
  }) => Promise<void>;
  // Audit the attempted confirm. `data.ok` reflects EFFECTIVE
  // outcome (structured refusal lands as `ok: false`). The kind the
  // route binds to is `ai.confirm.commit_import` — matches the
  // `ai.confirm.send_campaign` convention (kind = ai.confirm.<tool>).
  auditConfirm: (args: {
    sessionId: string;
    data: Record<string, unknown>;
  }) => Promise<void>;
  // Audit pre-dispatch denials at this layer — the two
  // already_confirmed paths (fast-path and race-path). The kind the
  // route binds to is `ai.denied.commit_import`.
  auditDenied: (args: {
    sessionId: string;
    data: Record<string, unknown>;
  }) => Promise<void>;
  // Write the post-dispatch terminal state onto the `confirm_import`
  // widget row. Called exactly once per winning claim, AFTER audit +
  // transcript so those durable records are complete even if this
  // write fails. Swallowed errors — the operator already has their
  // outcome in the response body and transcript; a missed widget
  // update shows up as the pre-action card on next reload and the
  // single-use anchor prevents a second commit.
  markConfirmImportOutcome: (outcome: ConfirmImportOutcome) => Promise<void>;
};

export type ConfirmResponse = {
  status: number;
  body: Record<string, unknown>;
};

// Run the full confirm-import flow against the provided port. Mirror
// of `runConfirmSend` — same step ordering, same port seam, same
// swallowed-widget-write rule. Never throws.
export async function runConfirmImport(
  row: ConfirmRow,
  messageId: string,
  parsedInput: unknown,
  ctx: ToolCtx,
  port: ConfirmPort,
): Promise<ConfirmResponse> {
  // Fast-path already_confirmed. See `runConfirmSend` for the
  // rationale — not race-safe, but the atomic claim below is the
  // real guard. This just avoids the dispatch cost on refresh-and-
  // re-click.
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

  const claim = await port.claim();
  if (claim.count === 0) {
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

  // We own the claim. From here on, any exit path that didn't
  // commit MUST release via the RELEASABLE_IMPORT_REFUSALS
  // whitelist — every other refusal keeps the claim (same
  // discipline the send path uses for partial-state safety).
  const result = await port.dispatchCommit(parsedInput, ctx);

  const {
    effectiveOk,
    effectiveError,
    shouldReleaseClaim,
    handlerSummary,
    output,
  } = classifyImportOutcome(result);

  if (shouldReleaseClaim) {
    await port.release();
  }

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
  // commit_import handler's summary (it already reads like "Imported
  // N rows from "foo.csv" → contacts. Skipped: K …"). On failure,
  // surface the error code + handler summary so the transcript gives
  // the operator something actionable.
  const summary = effectiveOk
    ? (handlerSummary ??
      (typeof output === "string" ? output : "Import complete."))
    : `Import refused: ${effectiveError ?? "unknown"}${handlerSummary ? ` — ${handlerSummary}` : ""}`;

  await port.persistTranscript({
    sessionId: row.sessionId,
    content: summary,
    isError: !effectiveOk,
  });

  // Build the terminal outcome for the widget write. The
  // commit_import handler puts the five counters directly on its
  // output; coerce defensively so the validator's `>= 0`
  // non-NaN invariants hold even if a handler bug surfaces junk.
  let outcome: ConfirmImportOutcome;
  if (effectiveOk) {
    const rec =
      output !== null && typeof output === "object"
        ? (output as Record<string, unknown>)
        : {};
    outcome = {
      state: "done",
      result: {
        created: asFiniteNonNegInt(rec.created),
        existingSkipped: asFiniteNonNegInt(rec.existingSkipped),
        duplicatesInFile: asFiniteNonNegInt(rec.duplicatesInFile),
        invalid: asFiniteNonNegInt(rec.invalid),
        errors: asFiniteNonNegInt(rec.errors),
      },
      summary,
    };
  } else {
    outcome = {
      state: "error",
      error: effectiveError ?? "unknown",
      summary,
    };
  }

  try {
    await port.markConfirmImportOutcome(outcome);
  } catch {
    // intentionally swallowed — see ConfirmImportPort::markConfirmImportOutcome
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

// Coerce a handler-output field to a non-negative finite integer.
// Zeros on missing / non-numeric / negative / NaN / Infinity /
// non-integer. The counters on commit_import's happy path are all
// non-negative integers by construction (they come from a createMany
// count or a filter length), but a pathological structured-refusal
// surface could slip junk through and tank the widget write. Coerce
// once here so the terminal-state persist always lands a valid blob.
function asFiniteNonNegInt(v: unknown): number {
  if (typeof v !== "number") return 0;
  if (!Number.isFinite(v)) return 0;
  if (!Number.isInteger(v)) return 0;
  if (v < 0) return 0;
  return v;
}

// Re-export the port type under the module-local name used above so
// callers can `import type { ConfirmPort } from
// "@/lib/ai/confirm-import-flow"` if they prefer. The type is
// `ConfirmImportPort` everywhere else; this alias exists purely so
// the `runConfirmImport` signature reads symmetrically with
// `runConfirmSend(... port: ConfirmPort)`.
export type ConfirmPort = ConfirmImportPort;
