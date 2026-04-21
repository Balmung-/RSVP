import type { Memory as PrismaMemory } from "@prisma/client";
import { prisma } from "@/lib/db";
import { buildMemoryListQuery, type MemoryListOptions } from "./query";

// P16-A.1 — server-only read edge for durable memory.
//
// The DB-calling wrapper lives HERE, not in the `@/lib/memory`
// barrel. Why: importing the barrel must not instantiate the
// Prisma client. A future caller that wants just
// `DEFAULT_MEMORY_POLICY` or `buildMemoryListQuery` (both pure)
// shouldn't pay the side-effect cost of `new PrismaClient()`.
// The separation also matches Next.js bundling: client/edge
// code can safely reference `@/lib/memory`, and only server
// routes/tools that actually read the DB pull in
// `@/lib/memory/server`.
//
// Tenant safety: the only filter this path applies is `teamId`,
// enforced by `buildMemoryListQuery` (which throws on missing
// teamId). Callers MUST perform auth before invoking — deciding
// WHICH teamId is safe to read is a caller responsibility, not
// a leaf-helper one.

export type MemoryRecord = PrismaMemory;

// Thin wrapper: `prisma.memory.findMany(buildMemoryListQuery(...))`.
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
