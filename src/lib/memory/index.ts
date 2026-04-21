// P16-A — public surface for the durable-memory module.
//
// Everything the rest of the app imports from `@/lib/memory`
// passes through this barrel. Re-exports only; no runtime logic
// here so `import "@/lib/memory"` stays cheap.
//
// Scope check: P16-A exports the data contract + a pure query
// builder + a pure policy. It does NOT yet export a write helper
// (P16-B), a recall-ranking helper (P16-C), or any UI bindings.
// When those land, they should be added to this barrel so
// consumers have one canonical entry point.

import type { Memory as PrismaMemory } from "@prisma/client";
import { prisma } from "@/lib/db";
import { buildMemoryListQuery, type MemoryListOptions } from "./query";

export { buildMemoryListQuery } from "./query";
export type { MemoryListOptions } from "./query";
export {
  DEFAULT_MEMORY_POLICY,
  memoryPolicyFromEnv,
  type MemoryPolicy,
} from "./policy";

// Re-export the Prisma row type under a neutral name so call
// sites in the rest of the app can type-check against
// `MemoryRecord` without importing `@prisma/client` directly.
// Also future-proofs a possible rename: if the schema field set
// ever changes, callers keep the same import.
export type MemoryRecord = PrismaMemory;

// Thin wrapper over `prisma.memory.findMany(buildMemoryListQuery(...))`.
// This exists so consumers don't have to know that the builder
// returns a Prisma args object — they can just ask for "memories
// for this team" and get back rows. The builder itself stays
// pure/testable; this wrapper is the trivial DB-calling edge.
//
// Tenant safety: the only filter is `teamId`, enforced at the
// builder. Callers MUST check auth before calling (a user who
// can't see team X shouldn't be handed a teamId that targets X).
// That check is deliberately NOT done here — this is a leaf
// helper; caller context is where ACL lives.
export async function listMemoriesForTeam(
  teamId: string,
  opts: MemoryListOptions = {},
): Promise<MemoryRecord[]> {
  return prisma.memory.findMany(buildMemoryListQuery(teamId, opts));
}
