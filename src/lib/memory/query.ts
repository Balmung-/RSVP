import type { Prisma } from "@prisma/client";
import { DEFAULT_MEMORY_POLICY, type MemoryPolicy } from "./policy";

// P16-A — read seam for durable memory.
//
// `buildMemoryListQuery(teamId, opts)` returns a pure Prisma
// FindManyArgs shape for the hot read path: "give me the last N
// memories for this team, most-recent-first". Everything the
// query does is pinned HERE so there is exactly one place a
// future change to tenant scoping, ordering, or limit clamping
// can leak into the live read path.
//
// Why separate from `listMemoriesForTeam`:
//   - This function is pure (no DB). Unit tests assert the exact
//     where/orderBy/take shape without needing a live Postgres.
//   - The DB-calling wrapper (`listMemoriesForTeam`) is a thin
//     `prisma.memory.findMany(buildMemoryListQuery(...))` —
//     trivial to read, trivial to swap, and can't silently
//     diverge from the tested builder.
//   - Future slices (P16-C's retrieval ranking, P16-D's prompt
//     injection) will consume the builder directly so they reuse
//     the same policy-clamped shape without re-implementing the
//     clamp.
//
// Tenant safety invariant: the `where` clause has exactly one
// filter — `teamId` — and no code path in this module lets the
// caller widen it or drop it. The only way to leak across teams
// is to pass a different teamId, which is a caller-auth decision,
// not a builder one.

export type MemoryListOptions = {
  // Explicit caller-supplied limit. Clamped by the policy's
  // `listMaxLimit` (upper bound) and 1 (lower bound). When
  // omitted, the policy's `listDefaultLimit` is used.
  limit?: number;

  // Policy override. Defaults to DEFAULT_MEMORY_POLICY. P16-B's
  // write seam and P16-C's retrieval seam will both read from a
  // single env-derived policy; the parameter is here so tests
  // can vary the clamp without mutating the module-level
  // default.
  policy?: MemoryPolicy;
};

// Clamps a value to [min, max]. Semantics chosen so a caller
// accidentally passing a non-integer doesn't turn into
// `take: undefined` (which Prisma reads as "no limit").
//
//   - NaN             -> min   (bug at call site; conservative)
//   - -Infinity       -> min   (same)
//   - Infinity        -> max   (caller asked for "unbounded",
//                               policy enforces the cap)
//   - value < min     -> min
//   - value > max     -> max
//   - fractional      -> Math.floor(value) (Prisma's `take` must
//                                           be an integer)
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return Math.floor(value);
}

export function buildMemoryListQuery(
  teamId: string,
  opts: MemoryListOptions = {},
): Prisma.MemoryFindManyArgs {
  // Explicit fail-loud rather than silent return of []: a
  // caller without a teamId is a bug at the call site, not a
  // valid query. We'd rather a noisy throw during dev than a
  // quiet query that could, in a future refactor, be
  // interpreted as "return everything".
  if (!teamId) {
    throw new Error("buildMemoryListQuery: teamId is required");
  }
  const policy = opts.policy ?? DEFAULT_MEMORY_POLICY;
  const requested = opts.limit ?? policy.listDefaultLimit;
  const take = clamp(requested, 1, policy.listMaxLimit);
  return {
    where: { teamId },
    orderBy: { updatedAt: "desc" },
    take,
  };
}
