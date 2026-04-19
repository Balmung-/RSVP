import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildIngestOwnershipWhere,
  type IngestAccessCtx,
} from "../../src/lib/ai/tools/ingestAccess";

// P6-fix — pins the ownership gate shared by summarize_file and
// review_file_import. Both tools accept a raw ingestId and would
// otherwise return extracted file content to anyone who learned the
// id; this helper's WHERE clause is the one thing keeping one
// operator's uploads from leaking to another. A regression here is
// a data-leak regression, so the helper is tested directly rather
// than implicitly via Prisma.
//
// The shape assertions intentionally mirror the Prisma relation-
// filter form (`fileUpload: { uploadedBy: <id> }`) because swapping
// to a post-fetch check would change the error semantics (now a
// wrong-owner hit is "not found", not "forbidden") — and "not
// found" is what prevents probing for other operators' ingest ids.

function ctx(overrides: Partial<IngestAccessCtx> = {}): IngestAccessCtx {
  return {
    user: { id: "user_editor_1" },
    isAdmin: false,
    ...overrides,
  };
}

test("buildIngestOwnershipWhere: non-admin gets id + uploadedBy relation filter", () => {
  const where = buildIngestOwnershipWhere("ing_1", ctx());
  assert.deepEqual(where, {
    id: "ing_1",
    fileUpload: { uploadedBy: "user_editor_1" },
  });
});

test("buildIngestOwnershipWhere: admin bypasses the uploadedBy relation filter", () => {
  const where = buildIngestOwnershipWhere("ing_1", ctx({ isAdmin: true }));
  assert.deepEqual(where, { id: "ing_1" });
});

test("buildIngestOwnershipWhere: non-admin scoping uses the caller's id verbatim", () => {
  // Catches the "hardcoded user id" class of regression — the gate
  // must always interpolate from ctx.user.id, never from a constant.
  const where = buildIngestOwnershipWhere(
    "ing_xyz",
    ctx({ user: { id: "user_editor_42" } }),
  );
  assert.deepEqual(where, {
    id: "ing_xyz",
    fileUpload: { uploadedBy: "user_editor_42" },
  });
});

test("buildIngestOwnershipWhere: isAdmin=false with different user id yields different clause than admin", () => {
  // Sanity: admin/non-admin paths are not accidentally the same
  // object (would imply the gate is a no-op).
  const nonAdmin = buildIngestOwnershipWhere("ing_1", ctx());
  const admin = buildIngestOwnershipWhere("ing_1", ctx({ isAdmin: true }));
  assert.notDeepEqual(nonAdmin, admin);
  // Non-admin must include the relation filter; admin must not.
  assert.ok("fileUpload" in nonAdmin);
  assert.ok(!("fileUpload" in admin));
});

test("buildIngestOwnershipWhere: does NOT include uploadedBy at top level (would filter FileIngest rows by a column that doesn't exist)", () => {
  // Regression guard: the FileIngest model does not own uploadedBy;
  // it lives on the joined FileUpload row. A flat where-clause
  // would be silently wrong (no matching rows, confusing prod
  // behaviour). This pins the relation-filter form.
  const where = buildIngestOwnershipWhere("ing_1", ctx()) as Record<string, unknown>;
  assert.equal("uploadedBy" in where, false);
});
