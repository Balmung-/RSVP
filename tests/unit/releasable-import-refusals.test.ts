import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RELEASABLE_IMPORT_REFUSALS,
  isReleasableImportRefusal,
  classifyImportOutcome,
} from "../../src/lib/ai/confirm-classify";
import type { DispatchResult } from "../../src/lib/ai/tools/types";

// P7 — pins the releasable-refusals whitelist for the import arm of
// the confirm flow. Parallel to `releasable-refusals.test.ts` for
// send. These six codes are the ONLY `commit_import` refusals safe
// to release the single-use claim on — each one returns BEFORE the
// planner's `createMany` runs, so retrying cannot double-commit.
//
// Sources that must stay in sync with this list:
//   - `src/lib/ai/tools/commit_import.ts` preflight guards:
//     forbidden, not_found, campaign_not_found,
//     no_campaign_for_invitees, file_not_extracted
//   - The `nothing_to_commit` early-exit path in commit_import that
//     surfaces when the planner returns `created === 0 &&
//     willCreate === 0` (structured error, NOT an exception)
//
// If a future edit adds a new refusal to commit_import, the author
// must consciously decide whether it's safe to release (i.e. whether
// it can ever fire AFTER a partial write) and update this test + the
// constant together. A refusal added inside a transaction or after
// the createMany call is NOT releasable and must stay off this list.

const EXPECTED_RELEASABLE = [
  "forbidden",
  "not_found",
  "campaign_not_found",
  "no_campaign_for_invitees",
  "file_not_extracted",
  "nothing_to_commit",
] as const;

test("RELEASABLE_IMPORT_REFUSALS matches the pinned whitelist exactly", () => {
  assert.equal(
    RELEASABLE_IMPORT_REFUSALS.size,
    EXPECTED_RELEASABLE.length,
    `RELEASABLE_IMPORT_REFUSALS size drifted — added a new refusal? review whether it's safe to release (could it fire AFTER the createMany?), then update this test and the constant together`,
  );
  for (const code of EXPECTED_RELEASABLE) {
    assert.ok(
      RELEASABLE_IMPORT_REFUSALS.has(code),
      `RELEASABLE_IMPORT_REFUSALS missing expected code: ${code}`,
    );
  }
});

test("isReleasableImportRefusal recognises every whitelisted code", () => {
  for (const code of EXPECTED_RELEASABLE) {
    assert.equal(
      isReleasableImportRefusal(code),
      true,
      `expected ${code} to be releasable`,
    );
  }
});

test("isReleasableImportRefusal rejects dispatch-throw strings", () => {
  // Dispatch-layer throws surface as `handler_error:*` strings. Even
  // though they look refusal-shaped, they MUST NOT release the claim
  // because the throw could have been inside the planner after
  // partial writes.
  assert.equal(
    isReleasableImportRefusal("handler_error:Error: boom"),
    false,
  );
  assert.equal(isReleasableImportRefusal("unknown_tool:foo"), false);
  assert.equal(
    isReleasableImportRefusal("invalid_input:expected_object"),
    false,
  );
  assert.equal(isReleasableImportRefusal("needs_confirmation"), false);
});

test("isReleasableImportRefusal is null/undefined-safe", () => {
  assert.equal(isReleasableImportRefusal(null), false);
  assert.equal(isReleasableImportRefusal(undefined), false);
  assert.equal(isReleasableImportRefusal(""), false);
});

test("isReleasableImportRefusal rejects the send-flow-only codes", () => {
  // Cross-pollination guard — the send whitelist has codes like
  // `status_not_sendable` and `send_in_flight` that have no meaning
  // on the import path. Classifying an import refusal against the
  // wrong whitelist would either leak the claim or hold it for
  // ransom; both named classifiers existing is what keeps the two
  // sets honest.
  assert.equal(isReleasableImportRefusal("status_not_sendable"), false);
  assert.equal(isReleasableImportRefusal("send_in_flight"), false);
  assert.equal(isReleasableImportRefusal("no_invitees"), false);
  assert.equal(isReleasableImportRefusal("no_ready_messages"), false);
  assert.equal(isReleasableImportRefusal("no_email_template"), false);
});

test("classifyImportOutcome: structured refusal in whitelist triggers release", () => {
  const result: DispatchResult = {
    ok: true,
    result: {
      output: {
        error: "nothing_to_commit",
        summary: "Refused: no rows would be created.",
      },
    },
  };
  const c = classifyImportOutcome(result);
  assert.equal(c.effectiveOk, false);
  assert.equal(c.structuredError, "nothing_to_commit");
  assert.equal(c.effectiveError, "nothing_to_commit");
  assert.equal(c.shouldReleaseClaim, true);
  assert.equal(c.handlerSummary, "Refused: no rows would be created.");
});

test("classifyImportOutcome: structured refusal outside whitelist keeps claim", () => {
  // A hypothetical commit_import refusal not in
  // RELEASABLE_IMPORT_REFUSALS (e.g. one added in a future patch
  // that fires AFTER a partial write) — must still flip to failure,
  // but the claim stays held.
  const result: DispatchResult = {
    ok: true,
    result: { output: { error: "partial_write_rollback_failed" } },
  };
  const c = classifyImportOutcome(result);
  assert.equal(c.effectiveOk, false);
  assert.equal(c.structuredError, "partial_write_rollback_failed");
  assert.equal(c.shouldReleaseClaim, false);
});

test("classifyImportOutcome: dispatch throw does NOT release the claim", () => {
  // Same discipline as the send flow: a dispatch-layer throw could
  // have happened inside the planner's `createMany` with some rows
  // persisted. Retrying would risk double-insert; keep the claim.
  const result: DispatchResult = {
    ok: false,
    error: "handler_error:Error: db_connection_reset",
  };
  const c = classifyImportOutcome(result);
  assert.equal(c.effectiveOk, false);
  assert.equal(c.shouldReleaseClaim, false);
  assert.equal(c.effectiveError, "handler_error:Error: db_connection_reset");
});

test("classifyImportOutcome: a real success keeps claim and reports ok", () => {
  const result: DispatchResult = {
    ok: true,
    result: {
      output: {
        ok: true,
        ingestId: "ing_1",
        target: "contacts",
        created: 3,
        summary: "Imported 3 rows from \"foo.csv\" → contacts.",
      },
    },
  };
  const c = classifyImportOutcome(result);
  assert.equal(c.effectiveOk, true);
  assert.equal(c.structuredError, null);
  assert.equal(c.shouldReleaseClaim, false);
  assert.equal(c.handlerSummary, "Imported 3 rows from \"foo.csv\" → contacts.");
});
