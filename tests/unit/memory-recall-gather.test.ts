import { test } from "node:test";
import assert from "node:assert/strict";
import type { Memory as PrismaMemory } from "@prisma/client";

import {
  gatherMemoriesForUserWith,
  composeMemoryBlocks,
  toRenderedMemory,
  type GatherDeps,
} from "../../src/lib/ai/memory-recall";

// P16-D — pins for the server-side memory gather orchestrator.
//
// The gather is the SEAM between the chat route and the three
// primitives it composes: (a) teamIdsForUser (tenant scope),
// (b) recallMemoriesForTeam (P16-C ranker), (c) team-name lookup
// for per-section headings. Every one of those is a DB edge in
// production; here we exercise the orchestrator with synthesised
// fakes so the fail-closed posture and tenant-safety invariants
// are pinned without a live Postgres.
//
// What's guarded (GPT's P16-D acceptance criteria, verbatim):
//   - "Recalled memory appears in the model input" — covered
//     end-to-end by the happy-path test that walks teamIds →
//     per-team recall → team-name lookup → composed blocks with
//     bodies in the right teams.
//   - "No cross-team leakage" — the gather never asks for
//     memories from a team the user isn't in. This is the
//     tenant-safety pin below: the FAKE `recallMemoriesForTeam`
//     records every teamId it's called with, and the test
//     asserts that set equals `teamIdsForUser`'s return.
//   - "Fail closed if memory rows are malformed" — each seam has
//     its own fail-closed pin (teamIdsForUser throws, one team's
//     recall throws, team-name lookup throws, user is nobody).
//     Malformed INDIVIDUAL rows are filtered at the renderer
//     layer (see memory-context-render.test.ts) — the gather's
//     job here is to not explode on a failing seam.
//   - Pure helpers (`composeMemoryBlocks`, `toRenderedMemory`)
//     are pinned in isolation so the shaping rules (drop empty
//     teams, preserve input order, map to RenderedMemory shape)
//     don't drift silently.

// ---- fixtures ---------------------------------------------------

// Build a PrismaMemory row with minimal fields. Most tests only
// exercise kind/body/updatedAt; unused fields get conservative
// values (nulls for provenance, stable ids for deterministic
// compare). Cast through unknown to satisfy the generated Prisma
// type without importing it (keeps test file independent of
// schema changes that add non-critical fields).
function makeMemoryRow(overrides: Partial<PrismaMemory> = {}): PrismaMemory {
  const defaults = {
    id: `mem-${Math.random().toString(36).slice(2, 10)}`,
    teamId: "team-default",
    kind: "fact",
    body: "default body",
    sourceSessionId: null,
    sourceMessageId: null,
    createdByUserId: null,
    createdAt: new Date("2025-10-15T12:00:00Z"),
    updatedAt: new Date("2025-10-15T12:00:00Z"),
  } as unknown as PrismaMemory;
  return { ...defaults, ...overrides };
}

// Factory for a GatherDeps fixture. Callers override specific
// seams; the defaults are "happy path".
function makeDeps(overrides: Partial<GatherDeps> = {}): GatherDeps {
  return {
    teamIdsForUser: async () => [],
    recallMemoriesForTeam: async () => [],
    lookupTeamNames: async () => [],
    ...overrides,
  };
}

// ---- pure helpers ----------------------------------------------

test("toRenderedMemory: strips PrismaMemory to {kind, body, updatedAt}", () => {
  // Pin the narrowing step explicitly so a future PrismaMemory
  // field addition (e.g. a `tags` column) doesn't accidentally
  // leak into the renderer-facing shape.
  const row = makeMemoryRow({
    id: "mem-1",
    kind: "rule",
    body: "hello",
    updatedAt: new Date("2025-10-15T09:00:00Z"),
  });
  const out = toRenderedMemory(row);
  assert.deepEqual(out, {
    kind: "rule",
    body: "hello",
    updatedAt: new Date("2025-10-15T09:00:00Z"),
  });
  // Explicit negative — no extra keys.
  assert.deepEqual(Object.keys(out).sort(), ["body", "kind", "updatedAt"]);
});

test("composeMemoryBlocks: preserves teamId order from input", () => {
  const teamIds = ["team-c", "team-a", "team-b"];
  const rows = new Map<string, PrismaMemory[]>([
    ["team-a", [makeMemoryRow({ body: "from-a" })]],
    ["team-b", [makeMemoryRow({ body: "from-b" })]],
    ["team-c", [makeMemoryRow({ body: "from-c" })]],
  ]);
  const names = new Map([
    ["team-a", "Alpha"],
    ["team-b", "Beta"],
    ["team-c", "Gamma"],
  ]);
  const blocks = composeMemoryBlocks(teamIds, rows, names);
  assert.deepEqual(
    blocks.map((b) => b.teamId),
    ["team-c", "team-a", "team-b"],
    "order matches teamIds input, not map key insertion",
  );
});

test("composeMemoryBlocks: teams with zero memories are dropped", () => {
  const teamIds = ["team-a", "team-empty", "team-b"];
  const rows = new Map<string, PrismaMemory[]>([
    ["team-a", [makeMemoryRow({ body: "a1" })]],
    // team-empty: absent from map (equivalent to "no rows returned")
    ["team-b", [makeMemoryRow({ body: "b1" })]],
  ]);
  const blocks = composeMemoryBlocks(teamIds, rows, new Map());
  assert.deepEqual(
    blocks.map((b) => b.teamId),
    ["team-a", "team-b"],
    "empty team dropped between siblings",
  );
});

test("composeMemoryBlocks: missing team name → teamName: null", () => {
  const teamIds = ["team-a"];
  const rows = new Map<string, PrismaMemory[]>([
    ["team-a", [makeMemoryRow({ body: "orphan" })]],
  ]);
  // Empty names map — lookup "failed" for this team.
  const blocks = composeMemoryBlocks(teamIds, rows, new Map());
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.teamName, null);
});

// ---- gatherMemoriesForUserWith — happy path --------------------

test("gather: happy path — teamIds → per-team recall → named blocks (end-to-end)", async () => {
  // GPT acceptance: "recalled memory appears in the model input".
  // This is the end-to-end pin at the gather seam — it DOES produce
  // a block with the expected memory rows attached to the right
  // team. The renderer pins (separate file) cover the markdown side.
  const deps = makeDeps({
    teamIdsForUser: async () => ["team-1", "team-2"],
    recallMemoriesForTeam: async (teamId) => {
      if (teamId === "team-1") {
        return [
          makeMemoryRow({ teamId, kind: "preference", body: "team-1 pref" }),
          makeMemoryRow({ teamId, kind: "fact", body: "team-1 fact" }),
        ];
      }
      if (teamId === "team-2") {
        return [makeMemoryRow({ teamId, kind: "rule", body: "team-2 rule" })];
      }
      return [];
    },
    lookupTeamNames: async (ids) => {
      const all = [
        { id: "team-1", name: "Ministry Events" },
        { id: "team-2", name: "Royal Events" },
      ];
      return all.filter((t) => ids.includes(t.id));
    },
  });
  const blocks = await gatherMemoriesForUserWith({ id: "user-1" }, deps);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.teamId, "team-1");
  assert.equal(blocks[0]!.teamName, "Ministry Events");
  assert.equal(blocks[0]!.memories.length, 2);
  assert.equal(blocks[0]!.memories[0]!.body, "team-1 pref");
  assert.equal(blocks[1]!.teamId, "team-2");
  assert.equal(blocks[1]!.teamName, "Royal Events");
  assert.equal(blocks[1]!.memories.length, 1);
  assert.equal(blocks[1]!.memories[0]!.body, "team-2 rule");
});

test("gather: forwards opts.limitPerTeam and opts.policy to recallMemoriesForTeam", async () => {
  // Pin the option passthrough — the gather must thread the caller's
  // knobs into the recall path, not silently drop them.
  const captured: Array<{ teamId: string; limit?: number; hasPolicy: boolean }> = [];
  const deps = makeDeps({
    teamIdsForUser: async () => ["team-1"],
    recallMemoriesForTeam: async (teamId, opts) => {
      captured.push({
        teamId,
        limit: opts.limit,
        hasPolicy: opts.policy !== undefined,
      });
      return [makeMemoryRow({ teamId, body: "x" })];
    },
    lookupTeamNames: async () => [{ id: "team-1", name: "T1" }],
  });
  const customPolicy = {
    maxBodyLength: 100,
    defaultKind: "fact",
    listDefaultLimit: 10,
    listMaxLimit: 50,
    recallDefaultLimit: 5,
    recallMaxLimit: 10,
    recallScanMaxLimit: 20,
    adminListMaxLimit: 250,
  };
  await gatherMemoriesForUserWith(
    { id: "user-1" },
    deps,
    { limitPerTeam: 3, policy: customPolicy },
  );
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.limit, 3);
  assert.equal(captured[0]!.hasPolicy, true, "policy threaded through");
});

// ---- tenant-isolation (GPT: "no cross-team leakage") -----------

test("gather: never asks for memories outside teamIdsForUser (tenant isolation pin)", async () => {
  // THE cross-team-leakage guard. The gather must only call
  // recallMemoriesForTeam for teamIds returned by the tenant
  // primitive — no other sources, no widening. If a future
  // refactor accidentally widens the scope (e.g. "all teams in
  // the office"), this pin trips.
  const requestedTeamIds = new Set<string>();
  const deps = makeDeps({
    teamIdsForUser: async () => ["team-mine-1", "team-mine-2"],
    recallMemoriesForTeam: async (teamId) => {
      requestedTeamIds.add(teamId);
      return [makeMemoryRow({ teamId, body: "x" })];
    },
    lookupTeamNames: async () => [],
  });
  await gatherMemoriesForUserWith({ id: "user-1" }, deps);
  // Exact match — the requested set is PRECISELY the user's teams.
  assert.deepEqual(
    Array.from(requestedTeamIds).sort(),
    ["team-mine-1", "team-mine-2"].sort(),
  );
});

test("gather: teamIdsForUser returns [] → no memory calls, empty blocks", async () => {
  // A user with zero memberships must trigger ZERO downstream
  // calls. This is the stricter form of tenant isolation — we
  // don't even query the DB if the user has no scope.
  let recallCalls = 0;
  let lookupCalls = 0;
  const deps = makeDeps({
    teamIdsForUser: async () => [],
    recallMemoriesForTeam: async () => {
      recallCalls += 1;
      return [];
    },
    lookupTeamNames: async () => {
      lookupCalls += 1;
      return [];
    },
  });
  const blocks = await gatherMemoriesForUserWith({ id: "user-1" }, deps);
  assert.deepEqual(blocks, []);
  assert.equal(recallCalls, 0, "no recall calls when teamIds is empty");
  assert.equal(lookupCalls, 0, "no name lookup when teamIds is empty");
});

test("gather: lookupTeamNames is called with exactly the teams that had rows", async () => {
  // Optimisation pin: we don't ask for names for teams that had
  // zero memories. Also tenant-adjacent — the team-name query
  // surface is minimised to teams actually showing up in the
  // user's memory context.
  const deps = makeDeps({
    teamIdsForUser: async () => ["team-1", "team-2", "team-3"],
    recallMemoriesForTeam: async (teamId) => {
      if (teamId === "team-2") return []; // empty result
      return [makeMemoryRow({ teamId, body: "x" })];
    },
    lookupTeamNames: async (ids) => {
      // Pin the EXACT set passed through. team-2 had no rows
      // so it must NOT be in the lookup.
      assert.deepEqual(
        Array.from(ids).sort(),
        ["team-1", "team-3"].sort(),
        "lookup is called with the minimised team set",
      );
      return ids.map((id) => ({ id, name: `Name-${id}` }));
    },
  });
  const blocks = await gatherMemoriesForUserWith({ id: "user-1" }, deps);
  assert.equal(blocks.length, 2);
  assert.deepEqual(
    blocks.map((b) => b.teamId),
    ["team-1", "team-3"],
  );
});

// ---- fail-closed (GPT: "fail closed if memory rows are malformed") ----

test("gather: teamIdsForUser throws → returns [] (no memories, no crash)", async () => {
  // Top-level fail-closed: the tenant lookup failed so we have
  // NO safe scope to query — the right answer is an empty gather,
  // and the chat route proceeds without memory injection.
  const deps = makeDeps({
    teamIdsForUser: async () => {
      throw new Error("DB connection failed");
    },
    // These MUST NOT be called; if the gather widens the scope
    // on a teams lookup failure, one of these would record it.
    recallMemoriesForTeam: async () => {
      throw new Error("should not be called when teamIds failed");
    },
    lookupTeamNames: async () => {
      throw new Error("should not be called when teamIds failed");
    },
  });
  const blocks = await gatherMemoriesForUserWith({ id: "user-1" }, deps);
  assert.deepEqual(blocks, []);
});

test("gather: one team's recall throws → that team drops, others ship", async () => {
  // Isolation pin: a DB blip on one team's recall must not
  // silence the other teams. The allSettled structure inside
  // the gather is the mechanism; this test pins the behavior.
  const deps = makeDeps({
    teamIdsForUser: async () => ["team-ok-1", "team-broken", "team-ok-2"],
    recallMemoriesForTeam: async (teamId) => {
      if (teamId === "team-broken") {
        throw new Error("simulated per-team failure");
      }
      return [makeMemoryRow({ teamId, body: `body-${teamId}` })];
    },
    lookupTeamNames: async (ids) =>
      ids.map((id) => ({ id, name: `Name-${id}` })),
  });
  const blocks = await gatherMemoriesForUserWith({ id: "user-1" }, deps);
  // team-broken dropped; the two ok teams ship.
  assert.equal(blocks.length, 2);
  assert.deepEqual(
    blocks.map((b) => b.teamId),
    ["team-ok-1", "team-ok-2"],
  );
  assert.deepEqual(
    blocks.map((b) => b.teamName),
    ["Name-team-ok-1", "Name-team-ok-2"],
  );
});

test("gather: team-name lookup throws → memories ship with null teamName", async () => {
  // Fail-closed on the cosmetic seam: a team-name query failure
  // is the MOST recoverable thing that can go wrong. We'd rather
  // show "(team name unavailable)" in the prompt than lose the
  // operator's memory context entirely.
  const deps = makeDeps({
    teamIdsForUser: async () => ["team-1", "team-2"],
    recallMemoriesForTeam: async (teamId) => [
      makeMemoryRow({ teamId, body: `from-${teamId}` }),
    ],
    lookupTeamNames: async () => {
      throw new Error("team name lookup down");
    },
  });
  const blocks = await gatherMemoriesForUserWith({ id: "user-1" }, deps);
  assert.equal(blocks.length, 2);
  for (const b of blocks) {
    assert.equal(b.teamName, null, "lookup failure → null (renderer substitutes)");
    assert.equal(b.memories.length, 1, "memories still shipped");
  }
});

test("gather: ALL teams' recalls throw → empty blocks (no crash)", async () => {
  // Worst-case per-team failure: every call throws. The gather
  // must not propagate any of them. lookupTeamNames must not
  // even be called (no teams with rows).
  let lookupCalls = 0;
  const deps = makeDeps({
    teamIdsForUser: async () => ["team-1", "team-2"],
    recallMemoriesForTeam: async () => {
      throw new Error("every team fails");
    },
    lookupTeamNames: async () => {
      lookupCalls += 1;
      return [];
    },
  });
  const blocks = await gatherMemoriesForUserWith({ id: "user-1" }, deps);
  assert.deepEqual(blocks, []);
  assert.equal(lookupCalls, 0, "no name lookup when no team has rows");
});

test("gather: missing/empty user id → empty blocks (caller bug, fail closed)", async () => {
  // A caller bug — unauth paths shouldn't reach this gather, but
  // we fail-closed rather than throwing so the chat route doesn't
  // 500 if it happens.
  const deps = makeDeps({
    teamIdsForUser: async () => {
      throw new Error("should not be called");
    },
  });
  const blocksEmpty = await gatherMemoriesForUserWith({ id: "" }, deps);
  assert.deepEqual(blocksEmpty, []);
  const blocksUndef = await gatherMemoriesForUserWith(
    undefined as unknown as { id: string },
    deps,
  );
  assert.deepEqual(blocksUndef, []);
});

test("gather: teamIdsForUser returns non-array → treated as empty", async () => {
  // Belt-and-braces: even if some future teamIdsForUser impl
  // returns `null` or `undefined` (rather than `[]`), the gather
  // must not crash. This pin covers the Array.isArray guard.
  const deps = makeDeps({
    teamIdsForUser: async () => null as unknown as string[],
    recallMemoriesForTeam: async () => {
      throw new Error("should not be called");
    },
  });
  const blocks = await gatherMemoriesForUserWith({ id: "user-1" }, deps);
  assert.deepEqual(blocks, []);
});

// ---- ordering & composition ----

test("gather: block order mirrors teamIdsForUser order (not team-name alphabetical)", async () => {
  // Determinism: the gather respects the order teamIdsForUser
  // returns. A future refactor that alpha-sorts teams would
  // trip this pin.
  const deps = makeDeps({
    teamIdsForUser: async () => ["team-z", "team-a", "team-m"],
    recallMemoriesForTeam: async (teamId) => [
      makeMemoryRow({ teamId, body: `b-${teamId}` }),
    ],
    lookupTeamNames: async (ids) =>
      ids.map((id) => ({
        id,
        name: id === "team-z" ? "Alpha" : id === "team-a" ? "Omega" : "Middle",
      })),
  });
  const blocks = await gatherMemoriesForUserWith({ id: "user-1" }, deps);
  assert.deepEqual(
    blocks.map((b) => b.teamId),
    ["team-z", "team-a", "team-m"],
    "teamId order preserved even though team names would sort differently",
  );
});

test("gather: each memory row is narrowed to {kind, body, updatedAt} (no prisma fields leak)", async () => {
  // Pin that `toRenderedMemory` is the only shape going out —
  // tests the composition boundary. If a future refactor passes
  // raw PrismaMemory through the renderer, this would trip.
  const deps = makeDeps({
    teamIdsForUser: async () => ["team-1"],
    recallMemoriesForTeam: async () => [
      makeMemoryRow({
        teamId: "team-1",
        kind: "fact",
        body: "hello",
        updatedAt: new Date("2025-10-15T00:00:00Z"),
      }),
    ],
    lookupTeamNames: async () => [{ id: "team-1", name: "T1" }],
  });
  const blocks = await gatherMemoriesForUserWith({ id: "user-1" }, deps);
  assert.equal(blocks.length, 1);
  const mem = blocks[0]!.memories[0]!;
  // Exactly these three keys — no id, teamId, sourceSessionId.
  assert.deepEqual(Object.keys(mem).sort(), ["body", "kind", "updatedAt"]);
});
