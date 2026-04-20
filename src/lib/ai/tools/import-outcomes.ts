// Pure derivations from a `PlannerReport` into the operator-visible
// shapes that `propose_import` and `commit_import` emit. Extracted
// from the two handlers to make the data-shape logic testable without
// spinning up prisma / the Next runtime / the planner itself.
//
// Three helpers, each narrowly scoped:
//
//   1. `deriveProposeImportCounters(report)` — the preview widget's
//      `expected` fold, `blockers` array, and `state` string. What the
//      operator sees on a `confirm_import` card before clicking Confirm.
//   2. `deriveCommitImportResult(report)` — the destructive completion
//      shape (`result` field) with the commit-only `duplicatesInFile`
//      distinction and the `errors` driver-skip ceiling.
//   3. `shouldRefuseNothingToCommit(report)` — the single-bool gate
//      that turns a planner report where nothing will land into a
//      releasable `nothing_to_commit` refusal before the commit even
//      tries to write.
//
// The regression surface these protect (all invisible to the planner
// itself, because the planner's own tests only pin counter arithmetic):
//
//   - `existingSkipped` fold drift — preview folds `duplicatesExisting
//     + duplicatesWithin` into one operator-facing number because the
//     widget only surfaces ONE "existing/duplicate" counter. Commit
//     SPLITS them because that's the only place the distinction is
//     meaningful. A "harmonization" that picks one side and applies
//     it to the other would either under-count preview (confusing)
//     or collapse commit's duplicatesInFile into existingSkipped
//     (silently losing within-file duplicates as a metric).
//
//   - `nothing_to_commit` threshold drift — the conjunct is
//     `created === 0 && willCreate === 0`, NOT just `created === 0`.
//     `willCreate === 0` is the "planner staged nothing" signal;
//     `created === 0` without it could mean a driver-level skip after
//     `willCreate > 0` was staged. Simplifying to just `created === 0`
//     would flag a partial-write-followed-by-skip as nothing_to_commit,
//     which would then release the claim on the confirm path — a
//     release-the-claim-after-partial-write bug.
//
//   - `errors` clamp — `Math.max(0, willCreate - created)` prevents a
//     negative value if the planner ever over-reports `created` (it
//     doesn't today; defence-in-depth). A regression removing the
//     clamp would leak a negative `errors` to the widget.
//
//   - `state` derivation — `blockers.length > 0 ? "blocked" : "ready"`.
//     A flipped ternary would paint operators the wrong state (confirm
//     button renders on "ready"). Subtle UI regression.
//
// Intentionally does NOT cover:
//
//   - The role / ownership / campaign / file-status gates that run
//     BEFORE the planner. Those interleave with prisma and are covered
//     at the route level or via releasable-refusals.
//   - The summary-line formatters. Those are cosmetic and the branches
//     are covered incidentally by the derivation tests (capped,
//     blockers, skippedTotal).
//   - The widget props shape. That's validated by `validateWidgetProps`
//     in widget-validate.ts at emission time — a shape regression fails
//     LOUDLY at dispatch, not silently like a counter drift.

import type { PlannerReport } from "@/lib/importPlanner";

// ---- preview-side derivation ----

// The shape the `confirm_import` widget consumes for its `expected`
// counter block. Four fields exactly — `validateConfirmImport`
// requires this closed set.
export type ProposeImportExpected = {
  newRows: number;
  existingSkipped: number;
  conflicts: number;
  invalid: number;
};

// Full preview-derivation output. `blockers` is an ordered array of
// string codes the widget renders in sequence; today's only
// preview-time blocker is `nothing_to_commit`, but the return type
// keeps the array shape so adding a second blocker is a one-line
// change here + a new test case, not a shape refactor.
export type ProposeImportCounters = {
  expected: ProposeImportExpected;
  blockers: string[];
  state: "ready" | "blocked";
};

export function deriveProposeImportCounters(
  report: PlannerReport,
): ProposeImportCounters {
  // `nothing_to_commit` on willCreate === 0. In preview mode `created`
  // is always 0 (the planner short-circuits the write), so the
  // threshold can't use the stricter conjunct that commit uses. The
  // willCreate condition alone correctly captures "planner staged
  // zero rows".
  const blockers: string[] = [];
  if (report.willCreate === 0) {
    blockers.push("nothing_to_commit");
  }

  // existingSkipped FOLDS duplicatesExisting + duplicatesWithin here —
  // the widget only surfaces one "existing/duplicate" counter on the
  // preview card. Commit surfaces them separately (see
  // deriveCommitImportResult) because that's where the distinction
  // matters (ops filtering on "how many in-file dupes did I just
  // commit" needs the split).
  const expected: ProposeImportExpected = {
    newRows: report.willCreate,
    existingSkipped: report.duplicatesExisting + report.duplicatesWithin,
    conflicts: 0,
    invalid: report.invalid,
  };

  const state: "ready" | "blocked" =
    blockers.length > 0 ? "blocked" : "ready";

  return { expected, blockers, state };
}

// ---- commit-side derivation ----

// The five-field completion shape matching `validateImportResult`'s
// terminal-state contract: created, existingSkipped, duplicatesInFile,
// invalid, errors. Unlike the preview `expected` shape, this one
// distinguishes `existingSkipped` (matched existing DB key) from
// `duplicatesInFile` (collided with another row in the same file).
export type CommitImportResult = {
  created: number;
  existingSkipped: number;
  duplicatesInFile: number;
  invalid: number;
  errors: number;
};

export function deriveCommitImportResult(
  report: PlannerReport,
): CommitImportResult {
  // `errors` ceiling. `willCreate - created` could theoretically be
  // negative if the planner ever over-reports `created`. Today's
  // planner doesn't, but clamping here keeps the widget's counter
  // field non-negative even under a future planner bug.
  const errors = Math.max(0, report.willCreate - report.created);
  return {
    created: report.created,
    existingSkipped: report.duplicatesExisting,
    duplicatesInFile: report.duplicatesWithin,
    invalid: report.invalid,
    errors,
  };
}

// ---- nothing-to-commit refusal gate ----

// True when the commit should short-circuit with a releasable
// `nothing_to_commit` refusal BEFORE the createMany tries to write.
// Both conjuncts are load-bearing:
//   - `created === 0` means no rows landed
//   - `willCreate === 0` means the planner staged zero rows to try
// Dropping `willCreate === 0` would fold "partial write where driver
// skipped everything" into this branch, which would then route through
// RELEASABLE_IMPORT_REFUSALS and release the claim — potentially
// allowing a re-confirm that would replay the partial-write.
export function shouldRefuseNothingToCommit(report: PlannerReport): boolean {
  return report.created === 0 && report.willCreate === 0;
}
