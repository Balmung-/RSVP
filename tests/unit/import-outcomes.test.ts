import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveProposeImportCounters,
  deriveCommitImportResult,
  shouldRefuseNothingToCommit,
  type ProposeImportExpected,
  type CommitImportResult,
} from "../../src/lib/ai/tools/import-outcomes";
import type { PlannerReport } from "../../src/lib/importPlanner";

// P14-C — pins the three pure derivations `propose_import` +
// `commit_import` now delegate to. Before the extraction, these
// transformations lived inline in the tool handlers and pulled in
// prisma + the planner — no unit-level test could exercise the fold
// logic, the blocker threshold, or the errors clamp in isolation.
//
// The regression surface these protect is operator-visible:
//
//   - `expected.existingSkipped` fold: preview merges
//     `duplicatesExisting + duplicatesWithin` into ONE counter. A
//     regression that picks only one side halves the visible count.
//   - `blockers` array ordering + contents: `nothing_to_commit` is
//     the only preview-time blocker today; adding or renaming one
//     must force a test update here.
//   - `state` ternary: flipping "blocked" / "ready" paints the wrong
//     button UX and lets operators Confirm a blocked commit.
//   - `nothing_to_commit` two-conjunct threshold: dropping the
//     `willCreate === 0` conjunct would release the claim on a
//     partial-write driver-skip.
//   - `errors = Math.max(0, willCreate - created)` clamp: removing
//     the floor leaks a negative counter on future planner bugs.
//   - `duplicatesInFile` vs. `existingSkipped` split: commit keeps
//     them separate; a "harmonize with preview" refactor that folds
//     them into one would silently lose the in-file-dupe signal.
//
// Cross-helper invariant also pinned: when a planner report has
// `created === willCreate` (happy path), the preview's
// `expected.newRows` and the commit's `result.created` MUST be equal.
// That's the preview/commit parity contract the whole confirm gate
// exists to uphold — and it's now observable at the helper seam.

// ---- helpers ----

// Build a PlannerReport with sensible defaults. Every field
// overrideable so each test targets one transformation branch.
function makeReport(overrides: Partial<PlannerReport> = {}): PlannerReport {
  return {
    total: 0,
    willCreate: 0,
    created: 0,
    duplicatesWithin: 0,
    duplicatesExisting: 0,
    invalid: 0,
    capped: false,
    ...overrides,
  };
}

// ---- (1) deriveProposeImportCounters ----

test("deriveProposeImportCounters: expected.newRows equals willCreate", () => {
  // Preview's `expected.newRows` MUST equal the planner's willCreate —
  // this is the promise the confirm button is anchored on. A refactor
  // that calculates newRows some other way (e.g. total - invalid)
  // would drift from the commit's `created`.
  const out = deriveProposeImportCounters(
    makeReport({ willCreate: 7, total: 10 }),
  );
  assert.equal(out.expected.newRows, 7);
});

test("deriveProposeImportCounters: expected.existingSkipped folds duplicatesExisting + duplicatesWithin", () => {
  // The fold is the whole reason preview has a different `existingSkipped`
  // than commit — preview rolls in-file and existing-DB duplicates
  // together. A regression picking only one side would halve the visible
  // count on the preview card.
  const out = deriveProposeImportCounters(
    makeReport({ duplicatesExisting: 3, duplicatesWithin: 5 }),
  );
  assert.equal(out.expected.existingSkipped, 8);
});

test("deriveProposeImportCounters: expected.conflicts is ALWAYS 0", () => {
  // The planner's dedupe is key-identity, not a merge with field-
  // level conflict detection, so `conflicts` has no source of truth
  // and is always 0. Pinning this against a "pull conflicts from
  // report.something" refactor that would leak planner-internal
  // state to the widget.
  const out = deriveProposeImportCounters(
    makeReport({ willCreate: 3, duplicatesExisting: 2, invalid: 1 }),
  );
  assert.equal(out.expected.conflicts, 0);
});

test("deriveProposeImportCounters: expected.invalid equals report.invalid", () => {
  const out = deriveProposeImportCounters(makeReport({ invalid: 4 }));
  assert.equal(out.expected.invalid, 4);
});

test("deriveProposeImportCounters: expected has EXACTLY four fields (shape drift guard)", () => {
  // `validateConfirmImport` rejects a widget with unknown props on
  // the `expected` block. Pinning the shape here catches a regression
  // that adds a 5th field at the helper level before the widget
  // validator does.
  const out = deriveProposeImportCounters(makeReport({ willCreate: 1 }));
  const keys = Object.keys(out.expected).sort();
  assert.deepEqual(keys, ["conflicts", "existingSkipped", "invalid", "newRows"]);
});

test("deriveProposeImportCounters: willCreate > 0 → blockers is empty, state is 'ready'", () => {
  const out = deriveProposeImportCounters(
    makeReport({ willCreate: 5, total: 5 }),
  );
  assert.deepEqual(out.blockers, []);
  assert.equal(out.state, "ready");
});

test("deriveProposeImportCounters: willCreate === 0 → blockers = ['nothing_to_commit'], state = 'blocked'", () => {
  // Everything-skipped preview. Operator should see a blocked card
  // with exactly the `nothing_to_commit` reason. Any drift in the
  // blocker string would break the ops-facing audit stream grep on
  // blocker reasons.
  const out = deriveProposeImportCounters(
    makeReport({ willCreate: 0, duplicatesExisting: 3, invalid: 2 }),
  );
  assert.deepEqual(out.blockers, ["nothing_to_commit"]);
  assert.equal(out.state, "blocked");
});

test("deriveProposeImportCounters: willCreate === 0 still folds duplicates into existingSkipped", () => {
  // Blocked state shouldn't zero out the operator-facing "why" counters.
  // If the operator sees "blocked: nothing_to_commit" they should still
  // see the breakdown that led there.
  const out = deriveProposeImportCounters(
    makeReport({
      willCreate: 0,
      duplicatesExisting: 4,
      duplicatesWithin: 2,
      invalid: 3,
    }),
  );
  assert.equal(out.expected.existingSkipped, 6);
  assert.equal(out.expected.invalid, 3);
});

test("deriveProposeImportCounters: state ternary is NOT inverted — blockers non-empty means blocked", () => {
  // Guard against `blockers.length > 0 ? "ready" : "blocked"` — a
  // plausible one-character typo that would paint the confirm button
  // on a blocked preview.
  const out = deriveProposeImportCounters(makeReport({ willCreate: 0 }));
  assert.equal(out.state, "blocked");
  assert.notEqual(out.state, "ready");
});

// ---- (2) deriveCommitImportResult ----

test("deriveCommitImportResult: created equals report.created (NOT willCreate)", () => {
  // On commit, `created` is the ACTUAL write count, which may diverge
  // from `willCreate` if a driver-level skip happened. A regression
  // that reports willCreate here would paint a terminal widget that
  // over-counts the actual rows written.
  const out = deriveCommitImportResult(
    makeReport({ willCreate: 10, created: 8 }),
  );
  assert.equal(out.created, 8);
});

test("deriveCommitImportResult: existingSkipped ONLY counts duplicatesExisting (NOT within)", () => {
  // This is the preview/commit asymmetry that matters most — preview
  // folds both, commit splits them. A "let's match preview" refactor
  // would collapse `duplicatesInFile` into `existingSkipped`,
  // silently losing the in-file-dupe signal on the terminal card.
  const out = deriveCommitImportResult(
    makeReport({ duplicatesExisting: 3, duplicatesWithin: 5 }),
  );
  assert.equal(out.existingSkipped, 3);
});

test("deriveCommitImportResult: duplicatesInFile maps to report.duplicatesWithin", () => {
  // The distinct commit-side counter. Pins the name mapping — a
  // rename of `duplicatesWithin` in the planner without updating this
  // mapping would flip the counters.
  const out = deriveCommitImportResult(makeReport({ duplicatesWithin: 5 }));
  assert.equal(out.duplicatesInFile, 5);
});

test("deriveCommitImportResult: result has EXACTLY five fields (shape drift guard)", () => {
  // `validateImportResult` pins the five-field terminal contract.
  // This test catches a helper-level addition before validator.
  const out = deriveCommitImportResult(makeReport({ created: 1 }));
  const keys = Object.keys(out).sort();
  assert.deepEqual(keys, [
    "created",
    "duplicatesInFile",
    "errors",
    "existingSkipped",
    "invalid",
  ]);
});

test("deriveCommitImportResult: errors = Math.max(0, willCreate - created)", () => {
  // Happy-path case: driver-skipped 2 rows.
  const out = deriveCommitImportResult(
    makeReport({ willCreate: 10, created: 8 }),
  );
  assert.equal(out.errors, 2);
});

test("deriveCommitImportResult: errors clamped to 0 when created > willCreate", () => {
  // Defence-in-depth: the planner doesn't over-report today, but a
  // future planner bug where created > willCreate would leak a
  // negative errors counter without the Math.max clamp.
  const out = deriveCommitImportResult(
    makeReport({ willCreate: 5, created: 10 }),
  );
  assert.equal(out.errors, 0);
});

test("deriveCommitImportResult: errors = 0 in the identity happy path", () => {
  // Same counter in and out, no clamp needed — `willCreate === created`
  // means every staged row landed.
  const out = deriveCommitImportResult(
    makeReport({ willCreate: 7, created: 7 }),
  );
  assert.equal(out.errors, 0);
});

test("deriveCommitImportResult: invalid passes through from report.invalid", () => {
  const out = deriveCommitImportResult(makeReport({ invalid: 3 }));
  assert.equal(out.invalid, 3);
});

// ---- (3) shouldRefuseNothingToCommit ----

test("shouldRefuseNothingToCommit: true when BOTH created === 0 AND willCreate === 0", () => {
  // The releasable-refusal gate. Both conjuncts load-bearing.
  assert.equal(
    shouldRefuseNothingToCommit(makeReport({ willCreate: 0, created: 0 })),
    true,
  );
});

test("shouldRefuseNothingToCommit: false when willCreate > 0 (even if created === 0)", () => {
  // The critical distinguishing case. `willCreate > 0 && created === 0`
  // means the planner STAGED rows but the driver skipped all of them
  // — that's a partial-write-then-skip scenario. Releasing the claim
  // here would allow a re-confirm that could replay the planner and
  // double-write the previously-skipped rows if driver behaviour
  // changes.
  assert.equal(
    shouldRefuseNothingToCommit(makeReport({ willCreate: 5, created: 0 })),
    false,
  );
});

test("shouldRefuseNothingToCommit: false when created > 0 (even if willCreate === 0)", () => {
  // Pathological case that shouldn't occur (created > willCreate
  // implies the driver INVENTED rows), but the conjunct makes the
  // correct call: don't release the claim.
  assert.equal(
    shouldRefuseNothingToCommit(makeReport({ willCreate: 0, created: 3 })),
    false,
  );
});

test("shouldRefuseNothingToCommit: false on a happy-path commit (both > 0)", () => {
  assert.equal(
    shouldRefuseNothingToCommit(makeReport({ willCreate: 5, created: 5 })),
    false,
  );
});

test("shouldRefuseNothingToCommit: other counters (invalid, dupes) do NOT affect the gate", () => {
  // All-invalid or all-dupe files still route through this gate
  // via willCreate === 0 — the gate doesn't look at invalid /
  // duplicates directly. Pinning this so a regression that adds
  // `&& invalid === 0` wouldn't sneak through.
  assert.equal(
    shouldRefuseNothingToCommit(
      makeReport({
        willCreate: 0,
        created: 0,
        invalid: 5,
        duplicatesExisting: 3,
        duplicatesWithin: 2,
      }),
    ),
    true,
  );
});

// ---- (4) cross-helper preview/commit parity invariant ----

test("preview/commit parity: expected.newRows === result.created when willCreate === created", () => {
  // The whole reason the confirm gate exists is to close the
  // preview/commit trust gap — the operator clicks Confirm on a
  // PREVIEW expecting the commit to land those exact numbers. When
  // DB state hasn't changed between propose and commit (the normal
  // case), `willCreate === created` and THIS invariant must hold.
  //
  // Pinning it at the helper seam means a future refactor that
  // calculates one side differently (e.g. preview uses `total -
  // invalid` instead of `willCreate`) would fail THIS test before
  // it ever ships to operators.
  const report = makeReport({
    willCreate: 5,
    created: 5,
    duplicatesExisting: 2,
    duplicatesWithin: 1,
    invalid: 1,
    total: 9,
  });
  const preview = deriveProposeImportCounters(report);
  const commit = deriveCommitImportResult(report);
  assert.equal(preview.expected.newRows, commit.created);
});

test("preview/commit parity: expected.invalid === result.invalid always", () => {
  // Invalid count is state-independent — it's a count of rows the
  // planner couldn't parse / validate, which doesn't depend on DB
  // state. Preview and commit MUST agree on it regardless of whether
  // the write succeeded.
  const report = makeReport({ willCreate: 4, created: 4, invalid: 2 });
  const preview = deriveProposeImportCounters(report);
  const commit = deriveCommitImportResult(report);
  assert.equal(preview.expected.invalid, commit.invalid);
});

test("preview/commit parity: expected.existingSkipped ≥ result.existingSkipped (preview folds extra)", () => {
  // Inequality is the right shape here because preview folds
  // `duplicatesWithin` INTO existingSkipped, while commit splits
  // them. So preview.existingSkipped = commit.existingSkipped +
  // commit.duplicatesInFile. Pinning the fold relation keeps the two
  // shapes in a documented arithmetic contract.
  const report = makeReport({
    willCreate: 3,
    created: 3,
    duplicatesExisting: 4,
    duplicatesWithin: 2,
  });
  const preview = deriveProposeImportCounters(report);
  const commit = deriveCommitImportResult(report);
  assert.equal(
    preview.expected.existingSkipped,
    commit.existingSkipped + commit.duplicatesInFile,
  );
});

// ---- (5) type-signature drift guards ----

test("types: ProposeImportExpected has all and only the pinned fields (compile-time + runtime)", () => {
  // A literal object that satisfies the type — if the type ever
  // grows a new required field, this test fails to compile.
  const expected: ProposeImportExpected = {
    newRows: 1,
    existingSkipped: 2,
    conflicts: 0,
    invalid: 0,
  };
  assert.equal(typeof expected.newRows, "number");
  assert.equal(typeof expected.existingSkipped, "number");
  assert.equal(typeof expected.conflicts, "number");
  assert.equal(typeof expected.invalid, "number");
});

test("types: CommitImportResult has all and only the pinned fields (compile-time + runtime)", () => {
  const result: CommitImportResult = {
    created: 0,
    existingSkipped: 0,
    duplicatesInFile: 0,
    invalid: 0,
    errors: 0,
  };
  assert.equal(typeof result.created, "number");
  assert.equal(typeof result.duplicatesInFile, "number");
  assert.equal(typeof result.errors, "number");
});
