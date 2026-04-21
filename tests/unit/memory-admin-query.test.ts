import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildMemoriesWithProvenanceQuery,
  buildMemoryDeleteWhere,
} from "../../src/lib/memory/admin-query";
import { DEFAULT_MEMORY_POLICY } from "../../src/lib/memory/policy";

// P16-E — pure query-shape builders for the operator memory UI.
//
// These builders are the tenant-safety chokepoint for the UI
// read path and the destructive write path. The live server-edge
// wrappers (`listMemoriesForTeamsWithProvenance`,
// `deleteMemoryForTeam`) consume these shapes directly — any
// widening here would leak in prod, so the invariants get pinned
// at the shape layer:
//
//   - DELETE where: exactly `{ id, teamId }`, both required. A
//     where with only `id` would be a tenant leak (any user
//     could delete any memory row if they knew the id).
//   - LIST args: empty / non-string / all-empty input short-
//     circuits to `null`. An empty `IN ()` query or a missing
//     `where.teamId` would return cross-tenant rows.
//   - LIST include: exact relation + field shape. A silent
//     widening to full user rows would leak columns the UI
//     doesn't use (e.g. passwordHash via `include: { createdByUser: true }`).
//
// Non-invariants (deliberately NOT pinned here):
//   - Caller-supplied limit / pagination. P16-E ships without
//     paging; when it lands, the clamp goes here and this file
//     grows a limit-clamp suite.
//   - Kind filter. The operator UI doesn't filter by kind today
//     (validator closed-set = "fact" only); a future kind
//     filter would extend the where and get pinned here.

// ---- buildMemoryDeleteWhere -----------------------------------

test("buildMemoryDeleteWhere: happy path returns exactly { id, teamId }", () => {
  const w = buildMemoryDeleteWhere("mem-123", "team-abc");
  assert.deepEqual(w, { id: "mem-123", teamId: "team-abc" });
});

test("buildMemoryDeleteWhere: shape has EXACTLY two keys (tenant-safety pin)", () => {
  // If this fails, someone dropped `teamId` from the where and
  // left the builder returning just `{ id }` — which would let
  // any authenticated user delete any memory they could guess
  // the id of. Shape is pinned, not just key presence.
  const w = buildMemoryDeleteWhere("mem-123", "team-abc");
  const keys = Object.keys(w).sort();
  assert.deepEqual(keys, ["id", "teamId"]);
});

test("buildMemoryDeleteWhere: missing id throws (no silent empty-id pass)", () => {
  // Prisma.deleteMany({ where: { id: "", teamId: "x" } }) would
  // match zero rows and silently return count: 0 — looks like a
  // successful no-op from the caller's perspective. Better to
  // throw at the shape layer: a caller without an id is a bug
  // at the form handler / action, not a valid request.
  assert.throws(() => buildMemoryDeleteWhere("", "team-abc"), /id is required/);
  assert.throws(
    () => buildMemoryDeleteWhere(undefined as unknown as string, "team-abc"),
    /id is required/,
  );
});

test("buildMemoryDeleteWhere: missing teamId throws (tenant-safety pin)", () => {
  // THIS is the load-bearing throw: a delete without a teamId
  // has no tenant gate. If someone accidentally removes the
  // teamId check, this trips loud instead of letting a
  // cross-tenant delete through.
  assert.throws(() => buildMemoryDeleteWhere("mem-123", ""), /teamId is required/);
  assert.throws(
    () => buildMemoryDeleteWhere("mem-123", undefined as unknown as string),
    /teamId is required/,
  );
});

test("buildMemoryDeleteWhere: non-string inputs throw (shape discipline)", () => {
  assert.throws(
    () => buildMemoryDeleteWhere(42 as unknown as string, "team-abc"),
    /id is required/,
  );
  assert.throws(
    () => buildMemoryDeleteWhere("mem-123", 42 as unknown as string),
    /teamId is required/,
  );
});

// ---- buildMemoriesWithProvenanceQuery -------------------------

test("buildMemoriesWithProvenanceQuery: happy path returns full shape", () => {
  const q = buildMemoriesWithProvenanceQuery(["team-a", "team-b"]);
  assert.ok(q, "expected query args, not null");
  assert.deepEqual(q.where, { teamId: { in: ["team-a", "team-b"] } });
  assert.deepEqual(q.orderBy, { updatedAt: "desc" });
  assert.equal(q.take, DEFAULT_MEMORY_POLICY.adminListMaxLimit);
  assert.deepEqual(q.include, {
    createdByUser: {
      select: { id: true, email: true, fullName: true },
    },
    sourceSession: {
      select: { id: true, title: true },
    },
  });
});

test("buildMemoriesWithProvenanceQuery: take is derived from DEFAULT_MEMORY_POLICY.adminListMaxLimit (no literal)", () => {
  // P17-A.AUDIT-4 — the whole point of the cap is that the
  // policy constant is the single source of truth. If a future
  // edit hardcodes the cap to `500` the coupling breaks silently
  // the first time the policy bumps. Reference through the
  // policy explicitly here.
  const q = buildMemoriesWithProvenanceQuery(["team-a"]);
  assert.ok(q);
  assert.equal(typeof q.take, "number");
  assert.equal(q.take, DEFAULT_MEMORY_POLICY.adminListMaxLimit);
  // And the cap is a positive integer. An off-by-one or a
  // policy drift to zero would render the page blank while
  // passing the "cap exists" smoke.
  assert.ok(q.take! > 0, "cap must be positive");
});

test("buildMemoriesWithProvenanceQuery: where has EXACTLY teamId filter (tenant-pin)", () => {
  // If a future change adds a second filter (say, `archivedAt:
  // null`), the test needs explicit update. No silent widening.
  const q = buildMemoriesWithProvenanceQuery(["team-a"]);
  assert.ok(q);
  const whereKeys = Object.keys(q.where ?? {});
  assert.deepEqual(whereKeys, ["teamId"]);
});

test("buildMemoriesWithProvenanceQuery: empty array returns null (no-op short-circuit)", () => {
  // `where: { teamId: { in: [] } }` is a pointless round-trip
  // that returns nothing; `where: {}` is a CROSS-TENANT LEAK
  // that returns everything. Returning null makes the caller
  // skip the query entirely — neither danger can occur.
  assert.equal(buildMemoriesWithProvenanceQuery([]), null);
});

test("buildMemoriesWithProvenanceQuery: non-array input returns null", () => {
  assert.equal(
    buildMemoriesWithProvenanceQuery(null as unknown as string[]),
    null,
  );
  assert.equal(
    buildMemoriesWithProvenanceQuery(undefined as unknown as string[]),
    null,
  );
  assert.equal(
    buildMemoriesWithProvenanceQuery("team-a" as unknown as string[]),
    null,
  );
});

test("buildMemoriesWithProvenanceQuery: all-empty-string input returns null", () => {
  // A list of ["", "", ""] reduces to zero real teamIds and must
  // NOT fall through to `where: { teamId: { in: [] } }` or
  // `where: {}`.
  const q = buildMemoriesWithProvenanceQuery(["", "", ""]);
  assert.equal(q, null);
});

test("buildMemoriesWithProvenanceQuery: filters empty strings from input", () => {
  // If a caller accidentally passes a mix of valid ids and
  // empty strings (e.g. a bad map over partially-resolved team
  // rows), the builder strips the bad entries rather than
  // failing.
  const q = buildMemoriesWithProvenanceQuery(["team-a", "", "team-b"]);
  assert.ok(q);
  assert.deepEqual(q.where, { teamId: { in: ["team-a", "team-b"] } });
});

test("buildMemoriesWithProvenanceQuery: deduplicates duplicate teamIds (idempotent IN)", () => {
  // If a caller passes the same teamId twice (e.g. admin +
  // membership merges produced a dupe), the IN list gets a
  // single entry — keeps the query plan stable and the
  // response rows unchanged.
  const q = buildMemoriesWithProvenanceQuery(["team-a", "team-b", "team-a"]);
  assert.ok(q);
  assert.deepEqual(q.where, { teamId: { in: ["team-a", "team-b"] } });
});

test("buildMemoriesWithProvenanceQuery: include select is narrowed (no widening)", () => {
  // Defense against `include: { createdByUser: true }` drift.
  // Widening would pull every User column (including passwordHash)
  // into the response. The narrow `select` pins the exact fields.
  const q = buildMemoriesWithProvenanceQuery(["team-a"]);
  assert.ok(q);
  const include = q.include as Record<string, unknown>;
  const createdBy = include.createdByUser as {
    select: Record<string, boolean>;
  };
  const sourceSession = include.sourceSession as {
    select: Record<string, boolean>;
  };
  assert.deepEqual(Object.keys(createdBy.select).sort(), [
    "email",
    "fullName",
    "id",
  ]);
  assert.deepEqual(Object.keys(sourceSession.select).sort(), ["id", "title"]);
});

test("buildMemoriesWithProvenanceQuery: ordering is updatedAt desc (hot-list semantics)", () => {
  // If a future refactor silently switches to createdAt or to
  // ascending order, the operator's view would jump around —
  // a fresh edit to an old memory should land at the top.
  const q = buildMemoriesWithProvenanceQuery(["team-a"]);
  assert.ok(q);
  assert.deepEqual(q.orderBy, { updatedAt: "desc" });
});
