import type { Memory as PrismaMemory, Prisma } from "@prisma/client";
import { DEFAULT_MEMORY_POLICY, type MemoryPolicy } from "./policy";
import { MEMORY_KINDS, type MemoryKind } from "./validate";

// P16-C — pure retrieval/ranking seam for durable memory.
//
// Two pure functions, exercised end-to-end at `recallMemoriesForTeam`
// (server.ts):
//
//   buildMemoryRecallQuery(teamId, opts) -> Prisma.MemoryFindManyArgs
//     Shape of the DB query. Filters by teamId (required) + an
//     optional kind allow-list, orders deterministically, and
//     picks a `take` that OVERFETCHES beyond the user's final
//     recall limit so the ranker's post-fetch dedup has headroom
//     to backfill (P16-C.1 — see the take computation below).
//     This is where tenant safety and the hard DoS guard live;
//     the ranker below cannot widen either.
//
//   rankMemoriesForRecall(rows, opts) -> MemoryRecord[]
//     Post-fetch shaping. Stable-sorts by updatedAt desc (tie
//     broken by id desc — cuid is time-ordered, so this is
//     deterministic across processes), deduplicates by
//     trimmed body, and clamps to the final recall limit.
//     Separating this from the query keeps the ranking policy
//     unit-testable without a live Postgres.
//
// P16-C.1 — overfetch invariant:
//   The builder's DB `take` is NOT the user-facing recall limit.
//   Instead: `take = min(recallScanMaxLimit, userLimit *
//   RECALL_OVERFETCH_FACTOR)`. Why:
//
//   If the builder's take equaled the user's final limit, a
//   cluster of duplicate writes at the head of the scan window
//   (e.g. the operator edits the same hot fact five times in a
//   row) would starve the final output — dedup collapses them to
//   one row, and no later uniques get a chance because they were
//   never fetched. 4x overfetch means three duplicates per
//   delivered row are tolerated before we fall short; the scan
//   max caps the worst-case payload.
//
// Why this lives alongside — not inside — `query.ts`:
//   `buildMemoryListQuery` feeds the operator UI (P16-E) where
//   callers want wide, paginated views. `buildMemoryRecallQuery`
//   feeds the prompt-injection path (P16-D) where callers want a
//   tight, deduplicated, token-budgeted set. They share some
//   shape (teamId-gated where clause, updatedAt desc ordering)
//   but they're governed by different policy knobs
//   (`listDefaultLimit`/`listMaxLimit` vs `recallDefaultLimit`/
//   `recallMaxLimit`). Merging them would force every later
//   caller to know which "mode" they want via a boolean flag;
//   keeping them split makes the intent obvious at the import
//   site.
//
// Tenant safety invariant (mirrors query.ts):
//   The `where` clause always contains `teamId` as a filter.
//   When `kinds` is supplied, it adds `kind: { in: [...] }` — a
//   SECOND filter, not a replacement. A missing teamId throws
//   loudly rather than returning `where: {}` which Prisma would
//   interpret as "every memory in every tenant".

// Type-only alias for the Prisma Memory row. Mirrors the
// barrel's `MemoryRecord` export — kept local here (not imported
// from the barrel) to avoid a circular `index.ts -> retrieval.ts
// -> index.ts` graph. Because `import type` above is erased at
// compile time, this module stays pure: importing it does NOT
// instantiate the Prisma client.
type MemoryRecord = PrismaMemory;

// ---- builder ----

export type MemoryRecallOptions = {
  // Optional allow-list of kinds. When omitted, no kind filter is
  // applied (recall across all kinds for the team). When present,
  // EVERY element must be a member of `MEMORY_KINDS` — an unknown
  // kind throws rather than being silently dropped, because a
  // caller with a typo deserves a loud error, not a quietly
  // narrowed query.
  //
  // An EMPTY array is ALSO rejected: "no kinds allowed" is
  // ambiguous ("filter to nothing" vs "no filter"), and both
  // interpretations are likely caller bugs. Callers who want "all
  // kinds" should omit the field entirely.
  kinds?: readonly string[];

  // Caller-supplied row count. Clamped to
  // [1, policy.recallMaxLimit]. When omitted,
  // `policy.recallDefaultLimit` is used. Same clamp semantics as
  // `buildMemoryListQuery` (NaN -> min, Infinity -> max,
  // fractional -> floor) so recall can't produce `take: undefined`
  // (which Prisma reads as "no limit").
  limit?: number;

  // Policy override — same rationale as the list builder. Tests
  // vary the clamp without mutating the module-level default; a
  // future operator-configured policy can be threaded through
  // without reshaping call sites.
  policy?: MemoryPolicy;
};

// Same clamp semantics as `buildMemoryListQuery`. Duplicated on
// purpose: the recall path has its OWN policy bounds
// (`recallMaxLimit` is strictly smaller than `listMaxLimit`), and
// sharing a helper would tempt a refactor that threads the
// bounds through a single function — which is exactly how a
// recall caller would accidentally pick up the larger list bound.
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return Math.floor(value);
}

// P16-C.1 — overfetch multiplier for the builder's DB `take`.
//
// Rationale: the recall path must deliver `userLimit` UNIQUE rows
// when enough uniques exist, even if the newest N positions in
// the team's memory log contain duplicate bodies (e.g. an
// operator editing the same hot fact in a burst). A 4x overfetch
// means three duplicates per delivered row are absorbed before
// the output can fall short of `userLimit`. The absolute DB
// payload is still bounded by `policy.recallScanMaxLimit`, so the
// DoS guard at the scan seam is unchanged.
//
// Kept as a module constant rather than a policy knob because:
//   - callers tune the user-facing caps (default/max limit) but
//     never the dedup-headroom ratio;
//   - policy inflation is worse than a named constant for a
//     value that's tightly coupled to the dedup semantics;
//   - at default policy (recallMax=25, scanMax=100), 25 * 4 =
//     100 consumes exactly the scan budget — the factor is
//     calibrated to the shipped caps.
const RECALL_OVERFETCH_FACTOR = 4;

export function buildMemoryRecallQuery(
  teamId: string,
  opts: MemoryRecallOptions = {},
): Prisma.MemoryFindManyArgs {
  // Explicit fail-loud on missing teamId — same philosophy as
  // `buildMemoryListQuery`. A caller without a teamId is a bug at
  // the call site, not a valid recall.
  if (!teamId) {
    throw new Error("buildMemoryRecallQuery: teamId is required");
  }

  const policy = opts.policy ?? DEFAULT_MEMORY_POLICY;
  // First, normalise the user's requested limit via the same
  // clamp the ranker will apply. This keeps the "user-facing
  // cap" number a single, testable value — used here only to
  // compute the overfetch; the ranker will clamp the same input
  // again on its side so its behavior is independent of builder
  // internals.
  const userLimit = clamp(
    opts.limit ?? policy.recallDefaultLimit,
    1,
    policy.recallMaxLimit,
  );
  // Overfetch the DB read so post-fetch dedup can backfill when
  // the newest window contains duplicates. Bounded by
  // `recallScanMaxLimit` — a hard payload ceiling so a future
  // policy retune can't accidentally let the builder scan
  // unbounded rows. See RECALL_OVERFETCH_FACTOR above.
  const take = Math.min(
    policy.recallScanMaxLimit,
    userLimit * RECALL_OVERFETCH_FACTOR,
  );

  // Kind filter shaping.
  //
  // When absent: no `kind` clause on `where`. When present: validate
  // that every element is a MemoryKind, deduplicate (harmless if a
  // caller passed duplicates), then add `kind: { in: [...] }`. The
  // `in` form is stable across single-kind and multi-kind cases so
  // the shape doesn't branch in the downstream query logger.
  let kindClause: { kind: { in: MemoryKind[] } } | null = null;
  if (opts.kinds !== undefined) {
    if (!Array.isArray(opts.kinds)) {
      throw new Error("buildMemoryRecallQuery: kinds must be an array");
    }
    if (opts.kinds.length === 0) {
      // Empty array is a caller bug — "no kinds allowed" is
      // ambiguous. Callers who want ALL kinds omit the field.
      throw new Error(
        "buildMemoryRecallQuery: kinds must be non-empty (omit to match all kinds)",
      );
    }
    const seen = new Set<MemoryKind>();
    for (const k of opts.kinds) {
      if (!(MEMORY_KINDS as readonly string[]).includes(k)) {
        throw new Error(
          `buildMemoryRecallQuery: unknown kind "${k}" — must be a member of MEMORY_KINDS`,
        );
      }
      seen.add(k as MemoryKind);
    }
    kindClause = { kind: { in: Array.from(seen) } };
  }

  // Deterministic secondary ordering.
  //
  // Prisma's default with a single `updatedAt desc` leaves ties
  // (two memories updated in the same millisecond, which happens
  // under load) unordered. We add `id desc` as a secondary key so
  // the same query always returns rows in the same order across
  // processes. `id` is a cuid — roughly time-ordered — so desc
  // here means "newer record wins the tie", matching updatedAt's
  // intent.
  const orderBy: Prisma.MemoryOrderByWithRelationInput[] = [
    { updatedAt: "desc" },
    { id: "desc" },
  ];

  return {
    where: kindClause
      ? { teamId, kind: kindClause.kind }
      : { teamId },
    orderBy,
    take,
  };
}

// ---- ranker ----

export type MemoryRankOptions = {
  limit?: number;
  policy?: MemoryPolicy;
};

// Normalises body for dedup-key purposes: trim leading/trailing
// whitespace AND collapse internal whitespace runs to a single
// space. Preserves the ORIGINAL body on the returned row (the
// dedup key doesn't escape this function). This is defensive
// because the validator enforces "body stored verbatim" but
// doesn't normalise for comparison — two memories written with
// "hello  world" (two spaces) and "hello world" (one space) are
// materially the same fact.
function dedupKey(body: string): string {
  return body.trim().replace(/\s+/g, " ");
}

// Stable comparator: updatedAt desc (newer first), tie broken by
// id desc. Returns negative when `a` should come first. The
// comparator is pure — no side effects on the input rows.
function byRecency(a: MemoryRecord, b: MemoryRecord): number {
  const aMs = a.updatedAt.getTime();
  const bMs = b.updatedAt.getTime();
  if (aMs !== bMs) return bMs - aMs;
  // Tie on timestamp — fall back to id desc. String compare is
  // fine here; cuids are monotonic enough that desc-by-string
  // tracks desc-by-creation.
  if (a.id < b.id) return 1;
  if (a.id > b.id) return -1;
  return 0;
}

export function rankMemoriesForRecall(
  rows: readonly MemoryRecord[],
  opts: MemoryRankOptions = {},
): MemoryRecord[] {
  // Defensive: a caller passing a non-array shouldn't crash the
  // prompt path. Treat as empty.
  if (!Array.isArray(rows)) return [];

  const policy = opts.policy ?? DEFAULT_MEMORY_POLICY;
  const requested = opts.limit ?? policy.recallDefaultLimit;
  const limit = clamp(requested, 1, policy.recallMaxLimit);

  // Copy before sorting — don't mutate the caller's array. Sort
  // is O(n log n) which is fine; when called via the server
  // wrapper, n is bounded by the builder's `take`
  // (≤ recallScanMaxLimit — 100 today).
  const sorted = rows.slice().sort(byRecency);

  // Dedup: first occurrence wins (which is the most recent by
  // sort order). We trim + normalise whitespace for the dedup
  // key; the row itself is passed through unchanged.
  const seen = new Set<string>();
  const out: MemoryRecord[] = [];
  for (const row of sorted) {
    if (out.length >= limit) break;
    const key = dedupKey(row.body);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
