import type { Memory as PrismaMemory } from "@prisma/client";
import { prisma } from "@/lib/db";
import { teamIdsForUser } from "@/lib/teams";
import { recallMemoriesForTeam } from "@/lib/memory/server";
import type { MemoryPolicy } from "@/lib/memory";
import type { RecalledMemoryBlock, RenderedMemory } from "./memory-context";

// P16-D — the server-side gather step for the chat-recall pipeline.
//
// This is the ONLY entry point the chat route uses to turn a user
// into "memories that should feed this turn's prompt". It composes:
//
//   1. `teamIdsForUser(userId)` — tenant check. The SET of teams the
//      user can recall memory FROM is their active memberships —
//      nothing else. Admins get their own memberships here too: the
//      "admins see everything" escape hatch that applies to
//      campaigns (`scopedCampaignWhere`) deliberately does NOT
//      apply to memory, because memory is per-team operator notes,
//      not office-wide records. Cross-team admin recall — if ever
//      needed — belongs to the operator UI (P16-E) with an explicit
//      team picker, not the silent chat injection.
//
//   2. `recallMemoriesForTeam(teamId, ...)` — per team, with the
//      P16-C ranker. This path already clamps the limit, dedups
//      by body, and enforces the tenant filter at the builder.
//
//   3. Team name lookup — a single `prisma.team.findMany` over the
//      recalled team ids, so the per-team heading in the prompt
//      reads like "Ministry Events" not "ckabc123...". If the team
//      lookup fails, we still ship the memories with a null
//      `teamName` (the renderer substitutes a placeholder).
//
// Fail-closed posture (GPT's P16-D requirement, "fail closed if
// memory rows are malformed"):
//   - `teamIdsForUser` throws → return `[]`. No memory context
//     injected. The chat turn proceeds without memories rather
//     than 500-ing on the operator.
//   - One team's `recallMemoriesForTeam` throws → drop JUST that
//     team. Other teams' memories still ship. An isolated DB
//     hiccup mustn't silence every team.
//   - The team name lookup throws → continue with `teamName: null`
//     for all teams. The renderer's placeholder covers it.
//   - An individual memory row has a malformed shape → the PURE
//     renderer (`memory-context.ts`) filters it out downstream. We
//     don't pre-filter here because the validation lives with the
//     renderer's own pins.
//
// Why this module, not `@/lib/memory/server`:
//   The memory server module is the DB edge for the memory data
//   itself (list / create / recall). The gather step here is the
//   ORCHESTRATOR: it combines memory + team + user to produce the
//   shape the AI package wants. Putting it in `@/lib/ai` keeps the
//   "memory module is tenant-agnostic leaf" framing intact — the
//   ai layer IS where tenant concerns compose.
//
// Dep-injected for testability:
//   `gatherMemoriesForUser` is a thin wrapper that binds the real
//   prisma/teams/memory primitives; the workhorse is
//   `gatherMemoriesForUserWith(user, deps, opts)`, which takes the
//   three seams as callable deps. Tests drive that entry point
//   with synthesised functions to exercise:
//     - tenant isolation (teamIdsForUser dictates the scope);
//     - fail-closed (any seam can throw; others must keep shipping);
//     - empty cases (zero teams, zero memories, all-failures).
//   The wrapper exists so the chat route keeps its terse call
//   signature (`gatherMemoriesForUser(user)`).

// Recall knob. Controls how many memories we ask for PER TEAM.
// Kept low on purpose: across N teams we'd inject N * limit rows
// into the prompt context, and even at the recall default (10) a
// 5-team operator would see 50 memory lines. The default policy
// clamp (`recallMaxLimit: 25`) is a per-team cap; the aggregate
// across teams is bounded below by caller discipline. Today the
// chat route uses the policy default (10 per team) which is fine
// for the typical 1-3 team user. A future tuning knob can flow in
// via `opts.policy.recallDefaultLimit` without changing this
// signature.
export type GatherOptions = {
  policy?: MemoryPolicy;
  // Override the per-team recall limit. Passes straight through
  // to `recallMemoriesForTeam`, which clamps to
  // `policy.recallMaxLimit`. Tests use this to control fixture
  // size without mutating the policy.
  limitPerTeam?: number;
};

// Input user: we only need the id. Callers from the chat route
// pass the full User row, but typing against `{ id: string }`
// keeps this module independent of the Prisma User shape — a
// future mock user in tests doesn't need the full column set.
export type GatherInput = { id: string };

// Injectable dependency surface. Each field is a single function
// the gather calls; tests synthesise them to exercise each
// fail-closed branch independently. The SHAPE here mirrors the
// real imports (`teamIdsForUser`, `recallMemoriesForTeam`, and a
// narrow prisma-team-name lookup) so the production binding in
// `gatherMemoriesForUser` is a simple passthrough.
export type GatherDeps = {
  teamIdsForUser: (userId: string) => Promise<string[]>;
  recallMemoriesForTeam: (
    teamId: string,
    opts: { limit?: number; policy?: MemoryPolicy },
  ) => Promise<PrismaMemory[]>;
  // Narrow over-the-wire lookup for {id, name} rows. Wrapping
  // prisma directly here would drag the generated types through
  // tests; a `(teamIds) => Promise<{id,name}[]>` shape is enough.
  lookupTeamNames: (teamIds: readonly string[]) => Promise<Array<{ id: string; name: string }>>;
};

// ---- pure shaping helpers (testable without prisma) ----

// Strip a PrismaMemory down to the renderer's `RenderedMemory`
// shape. Split out because the TRIM happens at this seam: the
// renderer expects `{kind, body, updatedAt}` and nothing else. We
// do NOT filter malformed rows here — the renderer has that
// logic, and duplicating it risks drift.
export function toRenderedMemory(m: PrismaMemory): RenderedMemory {
  return {
    kind: m.kind,
    body: m.body,
    updatedAt: m.updatedAt,
  };
}

// Given the set of per-team recall results AND a teamId->name map
// (lookup may have partially failed), produce the `RecalledMemoryBlock[]`
// the renderer consumes. Pure — no prisma, no network — so its
// composition semantics (e.g. "team with no memories is dropped
// before rendering too") are unit-testable.
//
// Dropping empty teams HERE means the renderer receives only
// teams that have something to say. The renderer also filters
// empty teams — that's belt-and-braces and doesn't hurt.
//
// Ordering: the output preserves the input `teamIds` order so a
// caller that wants deterministic section ordering gets it. The
// chat route passes the result of `teamIdsForUser` which is in
// membership-row order (arbitrary but stable per-query); tests
// pass an explicit order.
export function composeMemoryBlocks(
  teamIds: readonly string[],
  memoriesByTeam: ReadonlyMap<string, readonly PrismaMemory[]>,
  teamNamesById: ReadonlyMap<string, string>,
): RecalledMemoryBlock[] {
  const blocks: RecalledMemoryBlock[] = [];
  for (const teamId of teamIds) {
    const rows = memoriesByTeam.get(teamId) ?? [];
    // Drop teams with no memories here too — keeps the render
    // phase linear and makes "did we inject anything?" easy to
    // answer by checking `blocks.length`.
    if (rows.length === 0) continue;
    blocks.push({
      teamId,
      teamName: teamNamesById.get(teamId) ?? null,
      memories: rows.map(toRenderedMemory),
    });
  }
  return blocks;
}

// ---- server gather (dep-injected workhorse) ----
//
// Entry point used by both the production wrapper (which injects
// real prisma/teams/memory) and tests (which inject fakes). Every
// external call is wrapped in try/catch — errors log-and-continue
// rather than bubble, because a failed memory recall must NOT
// block the operator's chat turn.
export async function gatherMemoriesForUserWith(
  user: GatherInput,
  deps: GatherDeps,
  opts: GatherOptions = {},
): Promise<RecalledMemoryBlock[]> {
  if (!user || typeof user.id !== "string" || user.id.length === 0) {
    // Caller bug — but we fail-closed on the chat path rather
    // than throwing. The route will see an empty memory block
    // and skip injection.
    return [];
  }

  // Step 1 — which teams is the user allowed to recall from?
  // `teamIdsForUser` is the same tenant primitive used for
  // campaign scoping, so the invariant is shared: the user only
  // sees memory from teams they're an active member of.
  let teamIds: string[];
  try {
    teamIds = await deps.teamIdsForUser(user.id);
  } catch (err) {
    // Log to stderr; the chat route's own error handling will
    // still serve the turn. Note: we avoid pulling in the
    // project logger here (it'd re-import prisma downstream);
    // console.warn is sufficient for a fail-closed signal.
    // eslint-disable-next-line no-console
    console.warn("[memory-recall] teamIdsForUser failed; returning no memories", err);
    return [];
  }

  if (!Array.isArray(teamIds) || teamIds.length === 0) {
    // Not a member of any team → nothing to recall. Not an error,
    // just empty.
    return [];
  }

  // Step 2 — per-team recall. Parallel via Promise.allSettled so
  // one team's failure (DB blip, missing index during migration,
  // etc.) doesn't starve the others.
  const results = await Promise.allSettled(
    teamIds.map((teamId) =>
      deps.recallMemoriesForTeam(teamId, {
        limit: opts.limitPerTeam,
        policy: opts.policy,
      }),
    ),
  );

  const memoriesByTeam = new Map<string, PrismaMemory[]>();
  results.forEach((res, idx) => {
    const teamId = teamIds[idx]!;
    if (res.status === "fulfilled") {
      memoriesByTeam.set(teamId, res.value);
    } else {
      // Log and skip. Silent drop of one team mustn't mask
      // a systemic issue, so the warn is the trail a human
      // can follow in the server logs.
      // eslint-disable-next-line no-console
      console.warn(
        `[memory-recall] recallMemoriesForTeam failed for team=${teamId}; skipping`,
        res.reason,
      );
    }
  });

  // Step 3 — team name lookup. Single query over all teams we
  // actually got rows for (skipping teams that had zero memories
  // or that failed to recall). If this lookup throws, we still
  // ship the blocks with `teamName: null` — the renderer has a
  // placeholder for exactly this case.
  const teamIdsWithRows = Array.from(memoriesByTeam.keys()).filter(
    (id) => (memoriesByTeam.get(id) ?? []).length > 0,
  );
  const teamNamesById = new Map<string, string>();
  if (teamIdsWithRows.length > 0) {
    try {
      const rows = await deps.lookupTeamNames(teamIdsWithRows);
      for (const row of rows) {
        teamNamesById.set(row.id, row.name);
      }
    } catch (err) {
      // Log and continue — the renderer covers the null-name
      // case. We don't clear the existing map; a partial lookup
      // that completed before the throw would still populate
      // entries, though for `findMany` that's all-or-nothing.
      // eslint-disable-next-line no-console
      console.warn("[memory-recall] team-name lookup failed; using placeholders", err);
    }
  }

  // Step 4 — compose and return. `composeMemoryBlocks` is pure so
  // the bulk of the shaping is exercised without prisma in tests.
  return composeMemoryBlocks(teamIds, memoriesByTeam, teamNamesById);
}

// Production binding. Thin wrapper that hands
// `gatherMemoriesForUserWith` the real prisma/teams/memory
// primitives. The chat route calls this; tests call the
// dep-injected form above.
export async function gatherMemoriesForUser(
  user: GatherInput,
  opts: GatherOptions = {},
): Promise<RecalledMemoryBlock[]> {
  return gatherMemoriesForUserWith(
    user,
    {
      teamIdsForUser,
      recallMemoriesForTeam,
      lookupTeamNames: (teamIds) =>
        prisma.team.findMany({
          where: { id: { in: Array.from(teamIds) } },
          select: { id: true, name: true },
        }),
    },
    opts,
  );
}
