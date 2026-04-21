import { test } from "node:test";
import assert from "node:assert/strict";

import type { MemoryWithProvenance } from "../../src/lib/memory/server";
import {
  describeMemoryProvenance,
  groupMemoriesByTeam,
  resolveTeamNameForUi,
  UNKNOWN_TEAM_LABEL_UI,
} from "../../src/lib/memory/ui";

// P16-E — pure UI helpers for the operator memory surface.
//
// These are the shaping side of the memories page: given the
// rows fetched by `listMemoriesForTeamsWithProvenance`, produce
// the team groupings + the per-memory provenance string the
// page renders.
//
// Invariants pinned here:
//   - Grouping PRESERVES the caller's teamId order (critical for
//     both non-admin "home team first" and admin "alphabetical"
//     semantics — both depend on the caller choosing the order,
//     not the helper).
//   - Teams with zero surviving memories are DROPPED (no empty
//     sections in the rendered page).
//   - Memories whose teamId isn't in the caller's order list
//     are DROPPED (defense: if the caller hands a narrower
//     scope than the rows cover, the helper doesn't leak
//     memories from teams the caller didn't ask for).
//   - Provenance wording is the exact UI string — drift would
//     show up as a visible text change on the page.
//   - Team-name fallback label matches the chat-recall renderer
//     label (cross-surface consistency).

// ---- Fixtures -------------------------------------------------

function mem(overrides: Partial<MemoryWithProvenance> = {}): MemoryWithProvenance {
  return {
    id: "mem-1",
    teamId: "team-a",
    kind: "fact",
    body: "test memory body",
    sourceSessionId: null,
    sourceMessageId: null,
    createdByUserId: null,
    createdAt: new Date("2026-04-01T12:00:00Z"),
    updatedAt: new Date("2026-04-01T12:00:00Z"),
    createdByUser: null,
    sourceSession: null,
    ...overrides,
  } as MemoryWithProvenance;
}

// ---- groupMemoriesByTeam --------------------------------------

test("groupMemoriesByTeam: happy path — groups by teamId preserving input order", () => {
  const memories = [
    mem({ id: "m1", teamId: "team-a" }),
    mem({ id: "m2", teamId: "team-b" }),
    mem({ id: "m3", teamId: "team-a" }),
  ];
  const out = groupMemoriesByTeam(memories, ["team-a", "team-b"]);
  assert.equal(out.length, 2);
  assert.equal(out[0].teamId, "team-a");
  assert.equal(out[0].memories.length, 2);
  assert.deepEqual(
    out[0].memories.map((m) => m.id),
    ["m1", "m3"],
  );
  assert.equal(out[1].teamId, "team-b");
  assert.equal(out[1].memories.length, 1);
});

test("groupMemoriesByTeam: preserves input teamId order (NOT alpha-sort)", () => {
  // Critical for non-admins: teamIdsForUser returns membership
  // order ("home" team first). An alpha-sort here would flip
  // that and surprise the operator.
  const memories = [
    mem({ id: "m1", teamId: "team-z" }),
    mem({ id: "m2", teamId: "team-a" }),
  ];
  const out = groupMemoriesByTeam(memories, ["team-z", "team-a"]);
  assert.deepEqual(
    out.map((g) => g.teamId),
    ["team-z", "team-a"],
  );
});

test("groupMemoriesByTeam: drops teams with zero surviving memories", () => {
  // Input order has 3 teams; only 2 have memories. Result has 2
  // groups (no empty section for team-c).
  const memories = [
    mem({ id: "m1", teamId: "team-a" }),
    mem({ id: "m2", teamId: "team-b" }),
  ];
  const out = groupMemoriesByTeam(memories, ["team-a", "team-b", "team-c"]);
  assert.deepEqual(
    out.map((g) => g.teamId),
    ["team-a", "team-b"],
  );
});

test("groupMemoriesByTeam: drops memories for teamIds not in caller's order list", () => {
  // Defense: if the memories fetch somehow includes a teamId
  // the caller didn't ask for (shouldn't happen with the
  // tenant-gated query, but belt-and-braces), the grouper
  // silently drops them rather than rendering a rogue section.
  const memories = [
    mem({ id: "m1", teamId: "team-a" }),
    mem({ id: "m2", teamId: "team-unexpected" }),
    mem({ id: "m3", teamId: "team-b" }),
  ];
  const out = groupMemoriesByTeam(memories, ["team-a", "team-b"]);
  assert.deepEqual(
    out.flatMap((g) => g.memories.map((m) => m.id)),
    ["m1", "m3"],
  );
});

test("groupMemoriesByTeam: preserves per-team memory order (no re-sort)", () => {
  // The DB query already orders by updatedAt desc; this helper
  // must not re-sort silently (e.g. by id, or alphabetical).
  const memories = [
    mem({ id: "m-newer", teamId: "team-a", updatedAt: new Date("2026-04-02") }),
    mem({ id: "m-older", teamId: "team-a", updatedAt: new Date("2026-04-01") }),
  ];
  const out = groupMemoriesByTeam(memories, ["team-a"]);
  assert.deepEqual(
    out[0].memories.map((m) => m.id),
    ["m-newer", "m-older"],
  );
});

test("groupMemoriesByTeam: empty memories array → empty result", () => {
  assert.deepEqual(groupMemoriesByTeam([], ["team-a"]), []);
});

test("groupMemoriesByTeam: empty teamIdOrder → empty result", () => {
  const memories = [mem({ teamId: "team-a" })];
  assert.deepEqual(groupMemoriesByTeam(memories, []), []);
});

test("groupMemoriesByTeam: non-array inputs treated as empty (defensive)", () => {
  const memories = [mem({ teamId: "team-a" })];
  assert.deepEqual(
    groupMemoriesByTeam(null as unknown as MemoryWithProvenance[], ["team-a"]),
    [],
  );
  assert.deepEqual(groupMemoriesByTeam(memories, null as unknown as string[]), []);
});

test("groupMemoriesByTeam: non-object memory entries dropped defensively", () => {
  const bad = [
    null as unknown as MemoryWithProvenance,
    mem({ id: "good", teamId: "team-a" }),
    "oops" as unknown as MemoryWithProvenance,
  ];
  const out = groupMemoriesByTeam(bad, ["team-a"]);
  assert.equal(out[0].memories.length, 1);
  assert.equal(out[0].memories[0].id, "good");
});

test("groupMemoriesByTeam: empty-string teamId in order list skipped", () => {
  const memories = [mem({ id: "m1", teamId: "team-a" })];
  const out = groupMemoriesByTeam(memories, ["", "team-a"]);
  assert.deepEqual(
    out.map((g) => g.teamId),
    ["team-a"],
  );
});

// ---- resolveTeamNameForUi ------------------------------------

test("resolveTeamNameForUi: happy path — returns the mapped name", () => {
  const map = new Map<string, string | null>([["team-a", "Alpha Team"]]);
  assert.equal(resolveTeamNameForUi("team-a", map), "Alpha Team");
});

test("resolveTeamNameForUi: trims whitespace from mapped name", () => {
  const map = new Map<string, string | null>([["team-a", "  Alpha Team  "]]);
  assert.equal(resolveTeamNameForUi("team-a", map), "Alpha Team");
});

test("resolveTeamNameForUi: missing id → stable placeholder (no teamId leak)", () => {
  // Matches chat-recall's UNKNOWN_TEAM_LABEL — the operator's
  // page and the model's recall view use the SAME placeholder
  // when a team row is missing. Different strings here would
  // fragment the mental model.
  const map = new Map<string, string | null>();
  assert.equal(
    resolveTeamNameForUi("team-gone", map),
    UNKNOWN_TEAM_LABEL_UI,
  );
});

test("resolveTeamNameForUi: null name → placeholder", () => {
  const map = new Map<string, string | null>([["team-a", null]]);
  assert.equal(resolveTeamNameForUi("team-a", map), UNKNOWN_TEAM_LABEL_UI);
});

test("resolveTeamNameForUi: whitespace-only name → placeholder", () => {
  const map = new Map<string, string | null>([["team-a", "   "]]);
  assert.equal(resolveTeamNameForUi("team-a", map), UNKNOWN_TEAM_LABEL_UI);
});

test("resolveTeamNameForUi: placeholder does NOT leak teamId", () => {
  // Explicit pin: the fallback string must NOT include the
  // teamId. Leaking cuids in the UI would tie page copy to DB
  // shape.
  const label = resolveTeamNameForUi("team-secret-id-abc123", new Map());
  assert.equal(label.includes("team-secret-id-abc123"), false);
});

// ---- describeMemoryProvenance --------------------------------

test("describeMemoryProvenance: full shape — 'Added by X · From session Y'", () => {
  const m = mem({
    createdByUser: { id: "u1", email: "a@b.com", fullName: "Alice Operator" },
    sourceSession: { id: "s1", title: "Eid campaign setup" },
  });
  assert.equal(
    describeMemoryProvenance(m),
    "Added by Alice Operator · From session Eid campaign setup",
  );
});

test("describeMemoryProvenance: fullName missing → falls back to email", () => {
  const m = mem({
    createdByUser: { id: "u1", email: "alice@einai.co", fullName: null },
    sourceSession: null,
  });
  assert.equal(describeMemoryProvenance(m), "Added by alice@einai.co");
});

test("describeMemoryProvenance: both fullName and email missing → no 'Added by' clause", () => {
  // If the row somehow has an empty User object (e.g. a type
  // drift in the future), we omit the clause rather than render
  // "Added by " with nothing after.
  const m = mem({
    createdByUser: { id: "u1", email: "", fullName: "" },
    sourceSession: { id: "s1", title: "Session 1" },
  });
  assert.equal(describeMemoryProvenance(m), "From session Session 1");
});

test("describeMemoryProvenance: sourceSession title missing → falls back to short id", () => {
  const m = mem({
    createdByUser: null,
    sourceSession: { id: "ckxyz987654321abcd", title: null },
  });
  // Short id is the first 8 chars — gives operator something
  // identifiable without dumping the full cuid.
  assert.equal(describeMemoryProvenance(m), "From session ckxyz987");
});

test("describeMemoryProvenance: whitespace-only title → falls back to short id", () => {
  const m = mem({
    createdByUser: null,
    sourceSession: { id: "ckxyz987654321abcd", title: "   " },
  });
  assert.equal(describeMemoryProvenance(m), "From session ckxyz987");
});

test("describeMemoryProvenance: no createdByUser and no sourceSession → null", () => {
  // Caller renders the null branch as "No author recorded" with
  // a muted style — distinct from a partial-info branch.
  assert.equal(describeMemoryProvenance(mem()), null);
});

test("describeMemoryProvenance: malformed input → null (defensive)", () => {
  assert.equal(
    describeMemoryProvenance(null as unknown as MemoryWithProvenance),
    null,
  );
  assert.equal(
    describeMemoryProvenance(undefined as unknown as MemoryWithProvenance),
    null,
  );
});

test("describeMemoryProvenance: uses middle-dot separator ' · ' (admin-UI convention)", () => {
  // The approvals page uses " · " between clauses for consistency.
  // If this drifts to " | " or " - ", the memories page looks
  // out of family on the operator surface.
  const m = mem({
    createdByUser: { id: "u1", email: "a@b", fullName: "A" },
    sourceSession: { id: "s1", title: "T" },
  });
  const out = describeMemoryProvenance(m) ?? "";
  assert.ok(
    out.includes(" · "),
    `expected ' · ' separator, got: ${out}`,
  );
});

test("describeMemoryProvenance: trims fullName + title (no accidental leading/trailing space)", () => {
  const m = mem({
    createdByUser: { id: "u1", email: "", fullName: "  Alice  " },
    sourceSession: { id: "s1", title: "  Session  " },
  });
  assert.equal(describeMemoryProvenance(m), "Added by Alice · From session Session");
});
