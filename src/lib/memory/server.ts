import type { Memory as PrismaMemory } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  buildMemoriesWithProvenanceQuery,
  buildMemoryDeleteWhere,
} from "./admin-query";
import { DEFAULT_MEMORY_POLICY, type MemoryPolicy } from "./policy";
import { buildMemoryListQuery, type MemoryListOptions } from "./query";
import {
  buildMemoryRecallQuery,
  rankMemoriesForRecall,
  type MemoryRecallOptions,
} from "./retrieval";
import { validateMemoryWrite } from "./validate";

// P16-A.1 / P16-B — server-only DB edges for durable memory.
//
// The DB-calling wrappers live HERE, not in the `@/lib/memory`
// barrel. Why: importing the barrel must not instantiate the
// Prisma client. A future caller that wants just
// `DEFAULT_MEMORY_POLICY`, `buildMemoryListQuery`, or
// `validateMemoryWrite` (all pure) shouldn't pay the side-effect
// cost of `new PrismaClient()`. The separation also matches
// Next.js bundling: client/edge code can safely reference
// `@/lib/memory`, and only server routes/tools that actually read
// or write the DB pull in `@/lib/memory/server`.
//
// Tenant safety: reads filter by `teamId` (enforced at the
// builder); writes require `teamId` in the validated input
// (enforced at the validator). Callers MUST perform auth before
// invoking EITHER path — deciding WHICH teamId is safe to touch
// is a caller responsibility, not a leaf-helper one.

export type MemoryRecord = PrismaMemory;

// Thin read wrapper: `prisma.memory.findMany(buildMemoryListQuery(...))`.
// Kept minimal on purpose — the policy-clamped shape is tested at
// the builder; this function is just the DB edge. Any future
// behavior (e.g. retrieval ranking in P16-C) should wrap the
// builder independently rather than grow parameters here.
export async function listMemoriesForTeam(
  teamId: string,
  opts: MemoryListOptions = {},
): Promise<MemoryRecord[]> {
  return prisma.memory.findMany(buildMemoryListQuery(teamId, opts));
}

// P16-B — the sanctioned write seam.
//
// This is the ONLY server-side path that should ever reach
// `prisma.memory.create(...)`. Routing every write through this
// helper means the validator (kind gating, max length, provenance
// normalisation) is non-bypassable — a future tool or operator
// route can't accidentally skip the shape checks.
//
// Error policy: throws on an invalid input rather than returning
// `null`. The pure validator returns null (composable / testable
// without throws), but at the server edge a null input is a
// caller bug — the upstream route / tool / form should have
// validated before calling. Throwing here fails loudly during dev
// and surfaces as a 500 in prod, which is preferable to silently
// dropping a write the operator believed succeeded.
//
// The thrown message is intentionally vague ("invalid memory
// write input") because this helper can't know WHY validation
// failed — callers that need per-field error reporting should
// invoke `validateMemoryWrite` first and handle the null branch
// themselves before calling into the server.
export async function createMemoryForTeam(
  input: unknown,
  opts: { policy?: MemoryPolicy } = {},
): Promise<MemoryRecord> {
  const policy = opts.policy ?? DEFAULT_MEMORY_POLICY;
  const validated = validateMemoryWrite(input, policy);
  if (!validated) {
    throw new Error("createMemoryForTeam: invalid memory write input");
  }
  // Pass the validated shape straight through to Prisma. The
  // canonical shape (nullable provenance as `null`, `kind` in the
  // closed set) matches the schema row exactly, so no field
  // massaging lives at this layer.
  return prisma.memory.create({
    data: {
      teamId: validated.teamId,
      body: validated.body,
      kind: validated.kind,
      sourceSessionId: validated.sourceSessionId,
      sourceMessageId: validated.sourceMessageId,
      createdByUserId: validated.createdByUserId,
    },
  });
}

// P16-C — the sanctioned recall path.
//
// Composes the pure retrieval builder + the pure ranker into a
// single DB-calling edge. Every future chat-route / tool caller
// that wants "which memories should feed this prompt?" routes
// through here so the ranking policy (dedup, stable ordering,
// recall-specific limit clamp) is non-bypassable.
//
// Flow:
//   1. `buildMemoryRecallQuery` — teamId-gated where, optional
//      `kind IN (...)` filter, ordered by (updatedAt desc, id
//      desc), clamped take.
//   2. `prisma.memory.findMany` — hits the `(teamId, updatedAt)`
//      index when no kind filter is present, and the
//      `(teamId, kind)` index when one is. Both indexes exist in
//      the schema (P16-A added them for this path specifically).
//   3. `rankMemoriesForRecall` — sorts (idempotent after the DB's
//      ORDER BY), deduplicates by normalised body, clamps to the
//      caller's / policy's recall limit.
//
// Tenant safety: the only `where` filter is teamId (plus optional
// kind allow-list); all enforced at the builder. Caller MUST
// check auth before handing a teamId here.
export async function recallMemoriesForTeam(
  teamId: string,
  opts: MemoryRecallOptions = {},
): Promise<MemoryRecord[]> {
  const rows = await prisma.memory.findMany(
    buildMemoryRecallQuery(teamId, opts),
  );
  return rankMemoriesForRecall(rows, { limit: opts.limit, policy: opts.policy });
}

// P16-E — operator UI read helper (multi-team list with
// provenance relations).
//
// The chat-recall path (P16-C) deliberately returns a narrow
// shape: body + kind + updatedAt + provenance pointer columns,
// nothing else. That keeps its prompt-surface small. The
// operator-UI read path has a different need: show WHO added this
// memory and WHICH chat session it came from, so a human can
// decide whether to keep or remove it. That requires joining on
// `createdByUser` and `sourceSession`, which the P16-C builder
// doesn't do.
//
// Shape choices:
//   - Input is the caller's ALREADY-TENANT-RESOLVED teamIds (from
//     `teamIdsForUser` for non-admins; from `listTeams` for
//     admins). This keeps the tenant-scope decision at the auth
//     layer — this helper doesn't know whether "all teams" is
//     safe for a given caller. A caller passing an untrusted
//     teamId list is the caller's bug.
//   - Empty input short-circuits to `[]`. Cheap and avoids an
//     `IN ()` query.
//   - `createdByUser` / `sourceSession` are `select`-narrowed
//     rather than full rows. We only need identifying fields for
//     display; widening here would leak unused columns into the
//     UI bundle.
//   - Order is `updatedAt desc` — the most-recently-touched
//     memories land at the top of the operator's view. The
//     renderer can re-group by team client-side without losing
//     this.
//
// Cap: caller's responsibility. In this first slice the caller
// passes the policy list-limit per team implicitly by not asking
// for more; if the UI ever grows paging we'll push the limit down
// into this helper rather than growing a second knob.
export type MemoryWithProvenance = PrismaMemory & {
  createdByUser: {
    id: string;
    email: string;
    fullName: string | null;
  } | null;
  sourceSession: {
    id: string;
    title: string | null;
  } | null;
};

export async function listMemoriesForTeamsWithProvenance(
  teamIds: readonly string[],
): Promise<MemoryWithProvenance[]> {
  // The pure builder owns empty / non-string / duplicate handling.
  // A `null` return is the short-circuit signal — no round-trip.
  const args = buildMemoriesWithProvenanceQuery(teamIds);
  if (!args) return [];
  const rows = (await prisma.memory.findMany(
    args,
  )) as MemoryWithProvenance[];
  return rows;
}

// P16-E — operator UI delete.
//
// Tenant-scoped hard delete. Uses `deleteMany` (not `delete`) for
// two reasons:
//   1. Tenant gate: a caller that passes the wrong teamId (e.g.
//      a user trying to delete a memory from a team they don't
//      belong to) matches ZERO rows and the call returns
//      `{ deleted: false }` — no 500, no leak of the row's
//      existence. A `delete({ where: { id, teamId } })` would
//      throw P2025 "record not found" which conflates "wrong
//      team" with "genuinely missing" and is noisy to distinguish.
//   2. Idempotence: a double-submit (e.g. user hits the button
//      twice) gracefully reports `deleted: false` on the second
//      click rather than throwing.
//
// Hard delete vs archive: this slice ships hard delete. The
// schema has no `archivedAt` on Memory, and adding one now would
// ripple into P16-C's recall filter + the existing builders and
// their pins. If an archive-instead semantic is wanted, it
// belongs in a follow-up slice that owns the migration + recall
// filter update.
//
// Caller contract: MUST have resolved the teamId to one the
// current user is authorised to touch BEFORE calling. The
// `{ id, teamId }` pair is the tenant gate; this helper does not
// call `getCurrentUser` or look up memberships. That keeps the
// helper a pure DB edge and makes its unit test trivially
// prisma-moqueable.
export async function deleteMemoryForTeam(
  id: string,
  teamId: string,
): Promise<{ deleted: boolean }> {
  // The pure builder throws on missing id / teamId — we catch
  // that into a `deleted: false` result so an upstream route
  // passing bad form data returns a clean no-op rather than a
  // 500. The builder's throw still pins the invariant at the
  // shape layer (unit test covers both sides missing); this
  // wrapper is where the graceful "bad click → no-op" UX lives.
  let where: { id: string; teamId: string };
  try {
    where = buildMemoryDeleteWhere(id, teamId);
  } catch {
    return { deleted: false };
  }
  const res = await prisma.memory.deleteMany({ where });
  return { deleted: res.count > 0 };
}
