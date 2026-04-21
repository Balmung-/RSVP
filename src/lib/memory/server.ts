import type { Memory as PrismaMemory } from "@prisma/client";
import { prisma } from "@/lib/db";
import { DEFAULT_MEMORY_POLICY, type MemoryPolicy } from "./policy";
import { buildMemoryListQuery, type MemoryListOptions } from "./query";
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
