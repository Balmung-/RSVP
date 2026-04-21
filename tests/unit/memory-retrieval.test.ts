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
//     take clamp (which P16-C.1 made an OVERFETCH of the final
//     user-facing limit — see the "take overfetches" group of
//     pins below).
//   - `rankMemoriesForRecall(rows, opts)` — the post-fetch
//     shaping step. Pins stable ordering, body-level dedup,
//     and clamping independent of the DB path.
//
// Both are pure. The server-only wrapper `recallMemoriesForTeam`
// is a 2-line composition over these functions; its boundary
// behavior is implicit in the coverage here, with one explicit
// end-to-end regression pin (the "backfill" test at the bottom).

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

test("buildMemoryRecallQuery: happy path — teamId-gated where + stable order + overfetched take", () => {
  const q = buildMemoryRecallQuery("team-abc");
  assert.deepEqual(q.where, { teamId: "team-abc" });
  // Deterministic ordering: updatedAt desc with id desc as the
  // tie-breaker so rows with equal updatedAt still come back in
  // the same order across processes.
  assert.deepEqual(q.orderBy, [
    { updatedAt: "desc" },
    { id: "desc" },
  ]);
  // P16-C.1 — `take` OVERFETCHES the user's final limit so the
  // ranker has dedup headroom. At default policy:
  //   userLimit = recallDefaultLimit = 10
  //   take = min(recallScanMaxLimit=100, 10 * 4) = 40
  // A future factor/cap retune must update this number
  // deliberately; a silent change would flip the overfetch
  // guarantee.
  assert.equal(q.take, 40);
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

test("buildMemoryRecallQuery: caller-supplied limit drives overfetched take (limit × factor)", () => {
  // P16-C.1 — the caller's `limit` is the USER-FACING cap (what
  // the ranker will ultimately deliver). The builder multiplies
  // it by the overfetch factor to pick the DB `take`, giving the
  // ranker dedup headroom. For limit=5: take = min(100, 5 * 4) = 20.
  const q = buildMemoryRecallQuery("team-abc", { limit: 5 });
  assert.equal(q.take, 20);
});

test("buildMemoryRecallQuery: limit above recallMaxLimit clamps user-side, then take hits recallScanMaxLimit", () => {
  // Two guardrails compose here:
  //   1. User limit first clamps to policy.recallMaxLimit (25).
  //   2. Overfetch = 25 * 4 = 100, which also equals
  //      policy.recallScanMaxLimit — at default policy, max user
  //      limit exactly saturates the scan budget.
  // A caller passing an absurd limit thus gets `take: 100` (the
  // hard DB scan ceiling), never more.
  const q = buildMemoryRecallQuery("team-abc", { limit: 100_000 });
  assert.equal(q.take, DEFAULT_MEMORY_POLICY.recallScanMaxLimit);
});

test("buildMemoryRecallQuery: limit is clamped to 1 user-side, then overfetched (0 and negatives)", () => {
  // User limit floors to 1 (zero/negatives collapse). Overfetch
  // then multiplies: 1 * 4 = 4 rows fetched from the DB so the
  // ranker has some dedup room even for a 1-row final output.
  assert.equal(buildMemoryRecallQuery("team-abc", { limit: 0 }).take, 4);
  assert.equal(buildMemoryRecallQuery("team-abc", { limit: -10 }).take, 4);
});

test("buildMemoryRecallQuery: NaN / Infinity collapse user-side, then overfetch (never undefined)", () => {
  // `take: undefined` in Prisma = "no limit" = fetch everything.
  // Same clamp philosophy as the list builder — non-finite user
  // limits collapse to 1 / recallMax BEFORE the overfetch, so
  // the DB never sees `take: NaN` / `take: undefined`.
  //   NaN       -> userLimit=1 -> take=4
  //   Infinity  -> userLimit=25 -> take=100 (scanMax)
  assert.equal(buildMemoryRecallQuery("team-abc", { limit: Number.NaN }).take, 4);
  assert.equal(
    buildMemoryRecallQuery("team-abc", { limit: Number.POSITIVE_INFINITY }).take,
    DEFAULT_MEMORY_POLICY.recallScanMaxLimit,
  );
});

test("buildMemoryRecallQuery: fractional limits floor user-side, then overfetch", () => {
  // 7.9 -> userLimit floors to 7 -> take = 7 * 4 = 28.
  // Prisma's `take` must be an integer; flooring here prevents
  // `take: 31.6` from reaching the DB layer.
  const q = buildMemoryRecallQuery("team-abc", { limit: 7.9 });
  assert.equal(q.take, 28);
});

test("buildMemoryRecallQuery: take is ALWAYS >= userLimit (overfetch invariant)", () => {
  // Core regression pin for the P16-C.1 blocker: the DB `take`
  // must never be smaller than the user's final limit, or the
  // ranker would under-fill even when no duplicates exist. This
  // holds for every user limit in [1, recallMaxLimit].
  for (let limit = 1; limit <= DEFAULT_MEMORY_POLICY.recallMaxLimit; limit++) {
    const q = buildMemoryRecallQuery("team-abc", { limit });
    assert.ok(
      (q.take as number) >= limit,
      `take (${q.take}) must be >= userLimit (${limit}) to guarantee the ranker can fill the final output`,
    );
  }
});

test("buildMemoryRecallQuery: take is NEVER > recallScanMaxLimit (DB payload cap)", () => {
  // The complementary invariant: the overfetch is CAPPED so no
  // retune of recallMaxLimit or the overfetch factor can make
  // the builder scan an unbounded number of rows. Pin at the
  // highest reasonable user limit.
  const q = buildMemoryRecallQuery("team-abc", { limit: Number.POSITIVE_INFINITY });
  assert.ok(
    (q.take as number) <= DEFAULT_MEMORY_POLICY.recallScanMaxLimit,
    `take (${q.take}) must never exceed recallScanMaxLimit (${DEFAULT_MEMORY_POLICY.recallScanMaxLimit})`,
  );
});

test("buildMemoryRecallQuery: custom policy recall bounds honored end-to-end", () => {
  const custom: MemoryPolicy = {
    ...DEFAULT_MEMORY_POLICY,
    recallDefaultLimit: 3,
    recallMaxLimit: 5,
    // P16-C.1 — scan cap moves with the user-facing caps. Set
    // tight enough that the upper-bound test below exercises the
    // scanMax clamp path.
    recallScanMaxLimit: 20,
  };
  // Default: userLimit=3, take = min(20, 3*4) = 12
  const qDefault = buildMemoryRecallQuery("team-abc", { policy: custom });
  assert.equal(qDefault.take, 12);
  // Over-max: userLimit clamps to recallMaxLimit=5, take =
  // min(20, 5*4) = 20 (exactly the scan cap).
  const qClamped = buildMemoryRecallQuery("team-abc", {
    limit: 100,
    policy: custom,
  });
  assert.equal(qClamped.take, 20);
});

test("buildMemoryRecallQuery: policy invariant — recallMax ≤ recallScanMax ≤ listMax", () => {
  // Sanity pin: recall feeds the model's prompt context (token-
  // budgeted) and the scan budget (DB payload-budgeted); both
  // must stay bounded by the wider list path. A future policy
  // retune that flips any of these orderings trips this before
  // the invariant quietly breaks in production.
  assert.ok(
    DEFAULT_MEMORY_POLICY.recallDefaultLimit < DEFAULT_MEMORY_POLICY.listDefaultLimit,
    "recallDefaultLimit must stay below listDefaultLimit",
  );
  assert.ok(
    DEFAULT_MEMORY_POLICY.recallMaxLimit < DEFAULT_MEMORY_POLICY.listMaxLimit,
    "recallMaxLimit must stay below listMaxLimit",
  );
  // P16-C.1 invariants:
  assert.ok(
    DEFAULT_MEMORY_POLICY.recallMaxLimit <= DEFAULT_MEMORY_POLICY.recallScanMaxLimit,
    "recallMaxLimit must be <= recallScanMaxLimit (the scan must cover at least the final limit)",
  );
  assert.ok(
    DEFAULT_MEMORY_POLICY.recallScanMaxLimit <= DEFAULT_MEMORY_POLICY.listMaxLimit,
    "recallScanMaxLimit must be <= listMaxLimit (list path is the wide-read ceiling)",
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

test("rankMemoriesForRecall: backfills from input — duplicates at head don't starve later uniques", () => {
  // P16-C.1 — the ranker's own contribution to the backfill
  // guarantee. Given enough unique rows in its input, it keeps
  // pulling uniques past the duplicate head until it hits the
  // user's limit. 4 dupes of "fact A" at the top, then 5 distinct
  // facts. User asks for limit=5. Output: 1 ("fact A") + 4
  // distinct = 5 rows (the distinct facts B..E are 4 items, plus
  // A is 1 → total 5, exactly the limit).
  const rows = [
    mem({ id: "1", body: "fact A", updatedAt: new Date(2026, 3, 21, 10, 9) }),
    mem({ id: "2", body: "fact A", updatedAt: new Date(2026, 3, 21, 10, 8) }),
    mem({ id: "3", body: "fact A", updatedAt: new Date(2026, 3, 21, 10, 7) }),
    mem({ id: "4", body: "fact A", updatedAt: new Date(2026, 3, 21, 10, 6) }),
    mem({ id: "5", body: "fact B", updatedAt: new Date(2026, 3, 21, 10, 5) }),
    mem({ id: "6", body: "fact C", updatedAt: new Date(2026, 3, 21, 10, 4) }),
    mem({ id: "7", body: "fact D", updatedAt: new Date(2026, 3, 21, 10, 3) }),
    mem({ id: "8", body: "fact E", updatedAt: new Date(2026, 3, 21, 10, 2) }),
  ];
  const out = rankMemoriesForRecall(rows, { limit: 5 });
  assert.equal(
    out.length,
    5,
    "ranker MUST backfill past the duplicate head up to the user limit when uniques exist",
  );
  assert.deepEqual(
    out.map((r) => r.id),
    ["1", "5", "6", "7", "8"],
    "most-recent duplicate of A survives; later uniques fill up in recency order",
  );
});

test("rankMemoriesForRecall: output falls short of limit ONLY when input lacks enough uniques (ranker is pure over its input)", () => {
  // Complement to the backfill test. The ranker is a pure
  // function — it can only draw from what it was given. If the
  // input itself has fewer unique bodies than the limit, the
  // output is necessarily shorter. Ensuring ENOUGH uniques reach
  // the ranker is the BUILDER's job (overfetch), pinned in the
  // P16-C.1 end-to-end test below.
  const rows = [
    mem({ id: "1", body: "fact A", updatedAt: new Date(2026, 3, 21, 10, 9) }),
    mem({ id: "2", body: "fact A", updatedAt: new Date(2026, 3, 21, 10, 8) }),
    mem({ id: "3", body: "fact A", updatedAt: new Date(2026, 3, 21, 10, 7) }),
    mem({ id: "4", body: "fact A", updatedAt: new Date(2026, 3, 21, 10, 6) }),
    mem({ id: "5", body: "fact B", updatedAt: new Date(2026, 3, 21, 10, 5) }),
  ];
  const out = rankMemoriesForRecall(rows, { limit: 5 });
  assert.equal(out.length, 2, "only 2 unique bodies exist in input; ranker returns both");
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

// ============================================================
// end-to-end (builder + ranker) — P16-C.1 regression pin
// ============================================================

test("P16-C.1 regression: duplicate head in the scan window does NOT starve the final recall", () => {
  // This is the pin for the blocker GPT flagged on `4020f17`:
  // if the builder's DB `take` equals the user's final limit,
  // a cluster of duplicate writes at the head of the team's
  // newest-N window will crowd out later uniques, and the prompt
  // path returns far fewer memories than requested.
  //
  // Scenario: 30 rows in the team, newest-first. The top 8 share
  // one body ("hot fact" — operator edited it in a burst); the
  // next 25 are distinct.
  //
  // User requests limit=10.
  //
  // OLD (broken) behavior: builder take = 10. DB returns rows
  // 0-9 = 8 dupes + 2 uniques. Ranker dedups to 1 + 2 = 3 rows.
  // User wanted 10, got 3. BROKEN.
  //
  // NEW behavior: builder take = min(100, 10 * 4) = 40. DB
  // returns rows 0-29 (only 30 exist). Ranker dedups to 1 + 25
  // uniques = 26 candidates, then caps to 10. User gets 10.
  const hotDupes = Array.from({ length: 8 }, (_, i) =>
    mem({
      id: `dup-${i}`,
      body: "team prefers morning campaign sends",
      updatedAt: new Date(2026, 3, 21, 11, 59 - i),
    }),
  );
  const uniques = Array.from({ length: 25 }, (_, i) =>
    mem({
      id: `uniq-${String(i).padStart(2, "0")}`,
      body: `unique fact ${i}`,
      updatedAt: new Date(2026, 3, 21, 10, 59 - i),
    }),
  );
  // Pre-sorted newest-first, matching the builder's orderBy.
  const dbContents = [...hotDupes, ...uniques];

  // Simulate the server wrapper: builder decides `take`, DB
  // returns that many rows in orderBy order, ranker shapes.
  const q = buildMemoryRecallQuery("team-abc", { limit: 10 });
  const fetched = dbContents.slice(0, q.take as number);
  const out = rankMemoriesForRecall(fetched, { limit: 10 });

  assert.equal(
    out.length,
    10,
    "duplicate head MUST NOT starve the recall when uniques exist below — user asked for 10, must receive 10",
  );
  // First row is the most-recent duplicate of the hot fact.
  // The remaining 9 are the 9 newest uniques, in recency order.
  assert.equal(out[0].id, "dup-0", "newest duplicate of the hot fact survives");
  assert.deepEqual(
    out.slice(1).map((r) => r.id),
    [
      "uniq-00",
      "uniq-01",
      "uniq-02",
      "uniq-03",
      "uniq-04",
      "uniq-05",
      "uniq-06",
      "uniq-07",
      "uniq-08",
    ],
    "9 newest uniques fill the rest in recency order",
  );
});
