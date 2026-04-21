import type { Prisma } from "@prisma/client";
import { DEFAULT_MEMORY_POLICY } from "./policy";

// P16-E — pure query-shape builders for the operator memory UI.
//
// Same split pattern as `query.ts`: the Prisma shape is assembled
// here (pure, unit-testable) and the DB call lives in `server.ts`
// (`prisma.memory.findMany(buildMemoriesWithProvenanceQuery(...))`,
// `prisma.memory.deleteMany({ where: buildMemoryDeleteWhere(...) })`).
// That way the tenant-safety invariants — "delete requires BOTH
// id AND teamId", "list requires a non-empty teamIds array" — are
// pinned at the shape layer without needing a live Postgres to
// exercise them.
//
// Why a separate file from `query.ts`:
//   - `query.ts` owns the HOT chat-recall read shape (narrow,
//     cache-friendly, single-team, no relations). The policy and
//     ordering there are tuned for the recall path.
//   - This file owns the OPERATOR SURFACE shape: multi-team,
//     relation-included (createdByUser + sourceSession), no
//     caller-supplied limit because the page doesn't yet paginate.
//   - Splitting them means a change to one surface doesn't
//     accidentally widen the other. Two builders with two tests is
//     cheaper than one helper with a mode flag.
//
// Tenant-safety invariants (pinned by the admin-query tests):
//
//   1. DELETE: the where MUST carry both `id` AND `teamId`. A
//      where with only `id` would let any authenticated user
//      delete any memory if they guessed an id — the teamId pair
//      is what makes the operation tenant-safe. `deleteMany`
//      (not `delete`) on the server side means a mismatched pair
//      matches zero rows rather than throwing P2025; combined,
//      the two give a clean "wrong team or already gone, same
//      fail-closed outcome".
//
//   2. LIST: the where MUST carry a non-empty `teamId IN [...]`
//      filter. An empty input is short-circuited to `null` so the
//      caller skips the query entirely — we never emit
//      `where: {}` or `where: { teamId: { in: [] } }`, both of
//      which would be silently-wrong (the former returns every
//      memory in the office; the latter is a pointless round-trip).
//
// Non-invariants (deliberately NOT pinned here):
//   - Per-team limits / pagination. `buildMemoriesWithProvenanceQuery`
//     takes no caller-supplied limit today; the overall result set
//     is clamped to `DEFAULT_MEMORY_POLICY.adminListMaxLimit` (500)
//     via the `take` field below. When pagination lands, the
//     page-size argument goes into `MemoryListOptions`-style opts
//     and gets clamped here against the same policy ceiling.
//
// P17-A.AUDIT-4 — cap added (Finding 4 of the 2026-04-21 deep
// audit). Previously this builder returned `where + orderBy +
// include` only; `listMemoriesForTeamsWithProvenance` forwarded
// that straight to `prisma.memory.findMany`, which scanned every
// memory row across every in-scope team into the RSC response.
// At tenant scale (multiple teams × growing memory counts) that
// is a self-DoS vector. The policy-driven `take` bounds the
// worst case until pagination lands.

// Pure delete-where builder. Throws on either side missing —
// callers without both parts are a bug, not a valid request.
// A thrown error surfaces as a 500 at the route edge, which is
// preferable to silently dropping a click.
export function buildMemoryDeleteWhere(
  id: string,
  teamId: string,
): { id: string; teamId: string } {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("buildMemoryDeleteWhere: id is required");
  }
  if (typeof teamId !== "string" || teamId.length === 0) {
    throw new Error("buildMemoryDeleteWhere: teamId is required");
  }
  return { id, teamId };
}

// Multi-team provenance list builder. Returns `null` on empty
// input so the caller short-circuits without issuing a no-op
// query. The `include` shape is pinned: `createdByUser` and
// `sourceSession` with a narrow field `select`. We don't widen
// to full rows — the UI only needs identifying fields and
// widening would silently leak unused columns into the response.
//
// De-duplication: identical teamIds in the input are merged into
// a single `IN` value. This protects against a caller passing
// the same id twice (e.g. membership + admin-listTeams merges)
// without the builder needing to know which seam the caller
// sourced the list from.
export function buildMemoriesWithProvenanceQuery(
  teamIds: readonly string[],
): Prisma.MemoryFindManyArgs | null {
  if (!Array.isArray(teamIds)) return null;
  const uniq = Array.from(
    new Set(
      teamIds.filter(
        (t): t is string => typeof t === "string" && t.length > 0,
      ),
    ),
  );
  if (uniq.length === 0) return null;
  return {
    where: { teamId: { in: uniq } },
    orderBy: { updatedAt: "desc" },
    // P17-A.AUDIT-4 — policy-driven cap. Sorting by updatedAt desc
    // first means a truncated result still surfaces the most
    // recently-touched memories, which is what an operator looking
    // at the list most likely wants when scanning for what they
    // just said or saved. Pagination lands in a later slice.
    take: DEFAULT_MEMORY_POLICY.adminListMaxLimit,
    include: {
      createdByUser: {
        select: { id: true, email: true, fullName: true },
      },
      sourceSession: {
        select: { id: true, title: true },
      },
    },
  };
}
