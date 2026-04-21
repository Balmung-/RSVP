import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MEMORY_POLICY,
  buildMemoryRecallQuery,
  rankMemoriesForRecall,
  type MemoryPolicy,
} from "../../src/lib/memory";

// P16-C — pure retrieval / ranking seam for durable memory.
//
// Two tested surfaces:
//   - `buildMemoryRecallQuery(teamId, opts)` — the Prisma query
//     shape for the recall path. Pins tenant safety, kind
//     gating, deterministic ordering, and the recall-specific
//     limit clamp.
//   - `rankMemoriesForRecall(rows, opts)` — the post-fetch
//     shaping step. Pins stable ordering, body-level dedup,
//     and clamping independent of the DB path.
//
// Both are pure. The server-only wrapper `recallMemoriesForTeam`
// is a 2-line composition over these functions; its boundary
// behavior is implicit in the coverage here.

// ---- fixtures ----

// Builds a MemoryRecord-shaped object. The Prisma type has Date
// fields; we use real Date instances so the ranker's
// `updatedAt.getTime()` call works. `createdAt` is always equal
// to `updatedAt` here — the recall path doesn't care about
// createdAt, but the schema requires both.
type TestMemory = {
  id: string;
  teamId: string;
  kind: string;
  body: string;
  sourceSessionId: string | null;
  sourceMessageId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function mem(overrides: Partial<TestMemory>): TestMemory {
  const base: TestMemory = {
    id: "mem-default",
    teamId: "team-abc",
    kind: "fact",
    body: "default body",
    sourceSessionId: null,
    sourceMessageId: null,
    createdByUserId: null,
    createdAt: new Date("2026-04-21T10:00:00Z"),
    updatedAt: new Date("2026-04-21T10:00:00Z"),
  };
  return { ...base, ...overrides };
}

// ============================================================
// buildMemoryRecallQuery
// ============================================================

test("buildMemoryRecallQuery: happy path — teamId-gated where + stable order + default limit", () => {
  const q = buildMemoryRecallQuery("team-abc");
  assert.deepEqual(q.where, { teamId: "team-abc" });
  // Deterministic ordering: updatedAt desc with id desc as the
  // tie-breaker so rows with equal updatedAt still come back in
  // the same order across processes.
  assert.deepEqual(q.orderBy, [
    { updatedAt: "desc" },
    { id: "desc" },
  ]);
  assert.equal(q.take, DEFAULT_MEMORY_POLICY.recallDefaultLimit);
});

test("buildMemoryRecallQuery: where clause has EXACTLY teamId when no kinds (tenant-safety pin)", () => {
  // Mirrors the `buildMemoryListQuery` tenant-safety invariant:
  // the where clause's keys are pinned so a future accidental
  // widening (e.g. an `OR: [...]` to fix a filter bug) trips this
  // test before it ships.
  const q = buildMemoryRecallQuery("team-abc");
  const whereKeys = Object.keys(q.where ?? {}).sort();
  assert.deepEqual(whereKeys, ["teamId"]);
});

test("buildMemoryRecallQuery: where keys are EXACTLY (teamId, kind) when kinds present", () => {
  const q = buildMemoryRecallQuery("team-abc", { kinds: ["fact"] });
  const whereKeys = Object.keys(q.where ?? {}).sort();
  assert.deepEqual(whereKeys, ["kind", "teamId"]);
  // Kind clause is always the `in` form (stable across single
  // and multi-kind cases) so downstream query loggers / ranking
  // helpers never need to branch on the clause shape.
  const whereAny = q.where as { kind?: unknown } | undefined;
  assert.deepEqual(whereAny?.kind, { in: ["fact"] });
});

test("buildMemoryRecallQuery: duplicate kinds in input are deduplicated in the clause", () => {
  // Harmless-but-wasteful duplicates (e.g. a caller built the
  // kinds array by concatenating two filter sources). The
  // builder collapses to a unique set so the DB-side `in` clause
  // isn't padded.
  const q = buildMemoryRecallQuery("team-abc", {
    kinds: ["fact", "fact", "fact"],
  });
  const whereAny = q.where as { kind?: { in: unknown } } | undefined;
  assert.deepEqual(whereAny?.kind, { in: ["fact"] });
});

test("buildMemoryRecallQuery: missing teamId throws (no silent empty-where)", () => {
  // Same invariant as buildMemoryListQuery: a caller without a
  // teamId is a call-site bug, not a valid query.
  assert.throws(
    () => buildMemoryRecallQuery(""),
    /teamId is required/,
  );
  assert.throws(
    () => buildMemoryRecallQuery(undefined as unknown as string),
    /teamId is required/,
  );
});

test("buildMemoryRecallQuery: empty kinds array throws (ambiguous intent)", () => {
  // `kinds: []` has two plausible meanings — "filter to no kinds"
  // (return nothing) vs "no filter" (match all kinds). Both are
  // likely caller bugs. Callers wanting "all kinds" must OMIT
  // the field entirely; the validator failing loudly here
  // surfaces the mistake at dev time.
  assert.throws(
    () => buildMemoryRecallQuery("team-abc", { kinds: [] }),
    /kinds must be non-empty/,
  );
});

test("buildMemoryRecallQuery: kinds not an array throws", () => {
  assert.throws(
    () => buildMemoryRecallQuery("team-abc", {
      kinds: "fact" as unknown as string[],
    }),
    /kinds must be an array/,
  );
});

test("buildMemoryRecallQuery: unknown kind throws (closed set invariant)", () => {
  // The MEMORY_KINDS set is closed at the validator (P16-B);
  // the retrieval builder re-enforces it here so a caller can't
  // smuggle an unknown kind through the recall path either.
  // Silent narrowing would be worse than a loud throw: an empty
  // result from an unknown kind would look like "no memories
  // match" when the real issue is a typo.
  assert.throws(
    () => buildMemoryRecallQuery("team-abc", { kinds: ["preference"] }),
    /unknown kind "preference"/,
  );
  assert.throws(
    () => buildMemoryRecallQuery("team-abc", { kinds: ["fact", "bogus"] }),
    /unknown kind "bogus"/,
  );
});

test("buildMemoryRecallQuery: caller-supplied limit is honored within bounds", () => {
  const q = buildMemoryRecallQuery("team-abc", { limit: 5 });
  assert.equal(q.take, 5);
});

test("buildMemoryRecallQuery: limit is clamped to policy.recallMaxLimit (upper bound)", () => {
  const q = buildMemoryRecallQuery("team-abc", { limit: 100_000 });
  assert.equal(q.take, DEFAULT_MEMORY_POLICY.recallMaxLimit);
});

test("buildMemoryRecallQuery: limit is clamped to 1 (lower bound, 0 and negatives)", () => {
  assert.equal(buildMemoryRecallQuery("team-abc", { limit: 0 }).take, 1);
  assert.equal(buildMemoryRecallQuery("team-abc", { limit: -10 }).take, 1);
});

test("buildMemoryRecallQuery: NaN / Infinity collapse to bounds (not undefined)", () => {
  // `take: undefined` in Prisma = "no limit" = fetch everything.
  // Same clamp philosophy as the list builder.
  assert.equal(buildMemoryRecallQuery("team-abc", { limit: Number.NaN }).take, 1);
  assert.equal(
    buildMemoryRecallQuery("team-abc", { limit: Number.POSITIVE_INFINITY }).take,
    DEFAULT_MEMORY_POLICY.recallMaxLimit,
  );
});

test("buildMemoryRecallQuery: fractional limits floor to integers", () => {
  const q = buildMemoryRecallQuery("team-abc", { limit: 7.9 });
  assert.equal(q.take, 7);
});

test("buildMemoryRecallQuery: custom policy recall bounds honored end-to-end", () => {
  const custom: MemoryPolicy = {
    ...DEFAULT_MEMORY_POLICY,
    recallDefaultLimit: 3,
    recallMaxLimit: 5,
  };
  // Default uses custom.recallDefaultLimit
  const qDefault = buildMemoryRecallQuery("team-abc", { policy: custom });
  assert.equal(qDefault.take, 3);
  // Over-max uses custom.recallMaxLimit
  const qClamped = buildMemoryRecallQuery("team-abc", {
    limit: 100,
    policy: custom,
  });
  assert.equal(qClamped.take, 5);
});

test("buildMemoryRecallQuery: recall bounds are STRICTLY SMALLER than list bounds (prompt-budget guard)", () => {
  // Sanity pin: recall feeds the model's prompt context, which is
  // token-budgeted. If a future policy retune makes recallMax >=
  // listMax the "smaller cap for recall" invariant silently flips
  // and the prompt path would accept far more memory rows than
  // intended.
  assert.ok(
    DEFAULT_MEMORY_POLICY.recallDefaultLimit < DEFAULT_MEMORY_POLICY.listDefaultLimit,
    "recallDefaultLimit must stay below listDefaultLimit",
  );
  assert.ok(
    DEFAULT_MEMORY_POLICY.recallMaxLimit < DEFAULT_MEMORY_POLICY.listMaxLimit,
    "recallMaxLimit must stay below listMaxLimit",
  );
});

// ============================================================
// rankMemoriesForRecall
// ============================================================

test("rankMemoriesForRecall: empty rows -> []", () => {
  assert.deepEqual(rankMemoriesForRecall([]), []);
});

test("rankMemoriesForRecall: non-array input returns [] (defensive)", () => {
  // Defensive because a buggy caller dropping `null` or
  // `undefined` into the recall path shouldn't crash the prompt
  // builder. The pure validator returns []; the server wrapper
  // above is type-safe so in practice this branch is unreachable,
  // but pinning it prevents a future refactor from throwing here.
  assert.deepEqual(
    rankMemoriesForRecall(null as unknown as never[]),
    [],
  );
  assert.deepEqual(
    rankMemoriesForRecall(undefined as unknown as never[]),
    [],
  );
});

test("rankMemoriesForRecall: already-sorted rows pass through (modulo limit)", () => {
  const rows = [
    mem({ id: "c", body: "third", updatedAt: new Date("2026-04-21T10:00:00Z") }),
    mem({ id: "b", body: "second", updatedAt: new Date("2026-04-21T09:00:00Z") }),
    mem({ id: "a", body: "first", updatedAt: new Date("2026-04-21T08:00:00Z") }),
  ];
  const out = rankMemoriesForRecall(rows);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((r) => r.id), ["c", "b", "a"]);
});

test("rankMemoriesForRecall: out-of-order rows are sorted by updatedAt desc", () => {
  // Caller (or a mock in a future P16-D test) might pass
  // arbitrary ordering. The ranker re-sorts so the DB's orderBy
  // isn't load-bearing for correctness — only for performance.
  const rows = [
    mem({ id: "a", body: "oldest", updatedAt: new Date("2026-04-21T08:00:00Z") }),
    mem({ id: "c", body: "newest", updatedAt: new Date("2026-04-21T10:00:00Z") }),
    mem({ id: "b", body: "middle", updatedAt: new Date("2026-04-21T09:00:00Z") }),
  ];
  const out = rankMemoriesForRecall(rows);
  assert.deepEqual(out.map((r) => r.id), ["c", "b", "a"]);
});

test("rankMemoriesForRecall: ties on updatedAt broken by id desc", () => {
  // Deterministic tie-breaker. Cuids are roughly time-ordered
  // so id desc tracks "newer record wins", matching updatedAt's
  // intent.
  const ts = new Date("2026-04-21T10:00:00Z");
  const rows = [
    mem({ id: "mem-a", body: "a", updatedAt: ts }),
    mem({ id: "mem-c", body: "c", updatedAt: ts }),
    mem({ id: "mem-b", body: "b", updatedAt: ts }),
  ];
  const out = rankMemoriesForRecall(rows);
  assert.deepEqual(out.map((r) => r.id), ["mem-c", "mem-b", "mem-a"]);
});

test("rankMemoriesForRecall: dedup by body — first occurrence (most recent) wins", () => {
  // Two rows with the same body, different provenance + different
  // updatedAt. The MOST RECENT should survive — matching the "hot
  // fact" intent of recall. The kept row's provenance is preserved
  // verbatim (not merged with the older row).
  const rows = [
    mem({
      id: "new",
      body: "team prefers morning sends",
      updatedAt: new Date("2026-04-21T10:00:00Z"),
      sourceSessionId: "sess-new",
    }),
    mem({
      id: "old",
      body: "team prefers morning sends",
      updatedAt: new Date("2026-04-20T10:00:00Z"),
      sourceSessionId: "sess-old",
    }),
  ];
  const out = rankMemoriesForRecall(rows);
  assert.equal(out.length, 1, "duplicate body collapses to one row");
  assert.equal(out[0].id, "new", "most recent duplicate wins");
  assert.equal(
    out[0].sourceSessionId,
    "sess-new",
    "kept row's provenance preserved (not merged)",
  );
});

test("rankMemoriesForRecall: dedup normalises whitespace (internal + leading/trailing)", () => {
  // "team  prefers morning" (two spaces) and "team prefers morning"
  // (one space) are the same fact. Leading/trailing whitespace is
  // trimmed for the dedup key too. The STORED body is still
  // whatever was in the winning row — normalisation is only for
  // the comparison key.
  const rows = [
    mem({
      id: "recent",
      body: "  team prefers  morning  ",
      updatedAt: new Date("2026-04-21T10:00:00Z"),
    }),
    mem({
      id: "older",
      body: "team prefers morning",
      updatedAt: new Date("2026-04-20T10:00:00Z"),
    }),
  ];
  const out = rankMemoriesForRecall(rows);
  assert.equal(out.length, 1);
  // The winning row's body is preserved AS-IS (not normalised).
  // Display-layer trimming is a caller concern.
  assert.equal(out[0].body, "  team prefers  morning  ");
});

test("rankMemoriesForRecall: limit defaults to policy.recallDefaultLimit", () => {
  // Build 15 distinct memories (more than the default 10). Only
  // the default should come back.
  const rows = Array.from({ length: 15 }, (_, i) =>
    mem({
      id: `mem-${String(i).padStart(2, "0")}`,
      body: `fact ${i}`,
      updatedAt: new Date(`2026-04-21T${String(10 + i).padStart(2, "0")}:00:00Z`),
    }),
  );
  const out = rankMemoriesForRecall(rows);
  assert.equal(out.length, DEFAULT_MEMORY_POLICY.recallDefaultLimit);
});

test("rankMemoriesForRecall: caller-supplied limit is honored", () => {
  const rows = Array.from({ length: 10 }, (_, i) =>
    mem({
      id: `mem-${i}`,
      body: `fact ${i}`,
      updatedAt: new Date(`2026-04-21T${String(10 + i).padStart(2, "0")}:00:00Z`),
    }),
  );
  const out = rankMemoriesForRecall(rows, { limit: 3 });
  assert.equal(out.length, 3);
});

test("rankMemoriesForRecall: limit clamped to policy.recallMaxLimit (upper bound)", () => {
  const rows = Array.from({ length: 50 }, (_, i) =>
    mem({
      id: `mem-${String(i).padStart(2, "0")}`,
      body: `fact ${i}`,
      updatedAt: new Date(2026, 3, 21, 10, i, 0),
    }),
  );
  const out = rankMemoriesForRecall(rows, { limit: 100 });
  assert.equal(out.length, DEFAULT_MEMORY_POLICY.recallMaxLimit);
});

test("rankMemoriesForRecall: limit clamped to 1 (lower bound)", () => {
  const rows = Array.from({ length: 5 }, (_, i) =>
    mem({ id: `m-${i}`, body: `f${i}`, updatedAt: new Date(2026, 3, 21, 10, i) }),
  );
  assert.equal(rankMemoriesForRecall(rows, { limit: 0 }).length, 1);
  assert.equal(rankMemoriesForRecall(rows, { limit: -5 }).length, 1);
});

test("rankMemoriesForRecall: NaN / Infinity clamp to bounds", () => {
  const rows = Array.from({ length: 50 }, (_, i) =>
    mem({ id: `m-${i}`, body: `f${i}`, updatedAt: new Date(2026, 3, 21, 10, i) }),
  );
  assert.equal(rankMemoriesForRecall(rows, { limit: Number.NaN }).length, 1);
  assert.equal(
    rankMemoriesForRecall(rows, { limit: Number.POSITIVE_INFINITY }).length,
    DEFAULT_MEMORY_POLICY.recallMaxLimit,
  );
});

test("rankMemoriesForRecall: dedup can reduce output below limit (no backfilling)", () => {
  // Recall limit 5, but 4 of the 10 rows are dupes. The ranker
  // does NOT fetch more to compensate — it returns up to `limit`,
  // but may return fewer if dedup trims. Matches the contract
  // "up to N" rather than "exactly N".
  const rows = [
    mem({ id: "1", body: "fact A", updatedAt: new Date(2026, 3, 21, 10, 9) }),
    mem({ id: "2", body: "fact A", updatedAt: new Date(2026, 3, 21, 10, 8) }),
    mem({ id: "3", body: "fact A", updatedAt: new Date(2026, 3, 21, 10, 7) }),
    mem({ id: "4", body: "fact A", updatedAt: new Date(2026, 3, 21, 10, 6) }),
    mem({ id: "5", body: "fact B", updatedAt: new Date(2026, 3, 21, 10, 5) }),
  ];
  const out = rankMemoriesForRecall(rows, { limit: 5 });
  assert.equal(out.length, 2, "dedup reduces 5 rows (4 dupes) to 2 unique facts");
  assert.deepEqual(
    out.map((r) => r.id),
    ["1", "5"],
    "first occurrence of each body survives in recency order",
  );
});

test("rankMemoriesForRecall: does not mutate the input array", () => {
  // The helper sorts a COPY — caller's array is untouched.
  const rows = [
    mem({ id: "a", body: "a", updatedAt: new Date(2026, 3, 21, 8) }),
    mem({ id: "c", body: "c", updatedAt: new Date(2026, 3, 21, 10) }),
    mem({ id: "b", body: "b", updatedAt: new Date(2026, 3, 21, 9) }),
  ];
  const before = rows.map((r) => r.id);
  rankMemoriesForRecall(rows);
  const after = rows.map((r) => r.id);
  assert.deepEqual(after, before, "input order unchanged");
});

test("rankMemoriesForRecall: custom policy recallDefaultLimit + recallMaxLimit honored", () => {
  const custom: MemoryPolicy = {
    ...DEFAULT_MEMORY_POLICY,
    recallDefaultLimit: 2,
    recallMaxLimit: 3,
  };
  const rows = Array.from({ length: 10 }, (_, i) =>
    mem({
      id: `m-${i}`,
      body: `unique body ${i}`,
      updatedAt: new Date(2026, 3, 21, 10, i),
    }),
  );
  // Default -> 2
  assert.equal(rankMemoriesForRecall(rows, { policy: custom }).length, 2);
  // Explicit over-max -> clamped to custom.recallMaxLimit
  assert.equal(
    rankMemoriesForRecall(rows, { policy: custom, limit: 100 }).length,
    3,
  );
});
