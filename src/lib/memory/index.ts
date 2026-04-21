// P16-A — public surface for the durable-memory module.
//
// Intentionally PURE: re-exports only, zero runtime side effects.
// Importing `@/lib/memory` must NOT instantiate the Prisma client
// or pull in any server-only module. That keeps this barrel safe
// to reference from client bundles, edge runtime, and future
// prompt/policy code paths that only need the pure helpers.
//
// The DB-calling edge (`listMemoriesForTeam`) lives in a separate
// server module — `@/lib/memory/server`. Consumers who actually
// need to talk to the DB import from there explicitly; consumers
// who only need the pure helpers import from `@/lib/memory` and
// pay no runtime cost.
//
// Scope check: P16-A exports the data contract type + a pure
// query builder + a pure policy. It does NOT yet export a write
// helper (P16-B), a recall-ranking helper (P16-C), or any UI
// bindings. When those land, the PURE surface belongs here and
// any DB edge belongs in `./server`.

import type { Memory as PrismaMemory } from "@prisma/client";

export { buildMemoryListQuery } from "./query";
export type { MemoryListOptions } from "./query";
export {
  DEFAULT_MEMORY_POLICY,
  memoryPolicyFromEnv,
  type MemoryPolicy,
} from "./policy";

// Re-export the Prisma row type under a neutral name so call
// sites elsewhere can type-check against `MemoryRecord` without
// importing `@prisma/client` directly. This is a TYPE-ONLY export
// (erased at compile time) — the `import type` above produces no
// runtime code, so the barrel stays pure.
export type MemoryRecord = PrismaMemory;
