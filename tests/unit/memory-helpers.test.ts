import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildMemoryListQuery,
  DEFAULT_MEMORY_POLICY,
  memoryPolicyFromEnv,
  type MemoryPolicy,
} from "../../src/lib/memory";

// P16-A — durable memory data contract + pure helpers.
//
// This suite pins the shape and behavior of the only read seam
// (`buildMemoryListQuery`) and the policy defaults that every
// later P16 slice will lean on. The module is deliberately
// narrow: no tools, no chat wiring, no UI, no prompt injection
// yet. So these pins are the full "regression surface" for the
// slice.
//
// What's guarded here:
//   - Tenant safety: the query builder's `where` has EXACTLY
//     `teamId` as its filter. A future accidental widening would
//     trip this test first.
//   - Missing teamId is a loud throw, not a silent "return
//     everything". Important because the prisma layer would
//     happily run findMany({ where: {} }) otherwise.
//   - Limit clamping: caller-supplied limits are clamped to
//     [1, policy.listMaxLimit]. Defaults kick in when absent.
//   - Non-finite limits (NaN, Infinity) collapse to the minimum,
//     not to `take: undefined` (which would fetch everything).
//   - Ordering is `updatedAt: "desc"` — hot-list semantics. The
//     compound (teamId, updatedAt) index in schema.prisma
//     exists to serve exactly this shape; a silent ordering
//     change would degrade O(log n) to a full scan.
//   - DEFAULT_MEMORY_POLICY is a frozen object — a caller
//     trying to mutate it throws. Keeps the defaults honest
//     when multiple slices share the object.
//   - memoryPolicyFromEnv returns defaults verbatim in P16-A;
//     pinned here so a future env-override slice has to update
//     the test when it changes behavior.

test("buildMemoryListQuery: happy path — teamId filter + desc order + default limit", () => {
  const q = buildMemoryListQuery("team-abc");
  assert.deepEqual(q.where, { teamId: "team-abc" });
  assert.deepEqual(q.orderBy, { updatedAt: "desc" });
  assert.equal(q.take, DEFAULT_MEMORY_POLICY.listDefaultLimit);
});

test("buildMemoryListQuery: where clause has EXACTLY teamId (tenant-safety pin)", () => {
  // If this fails, someone widened the read filter — every cross-
  // team leak would have to pass through this one clause. The
  // count is pinned, not just the presence of teamId.
  const q = buildMemoryListQuery("team-abc");
  const whereKeys = Object.keys(q.where ?? {});
  assert.deepEqual(whereKeys, ["teamId"]);
});

test("buildMemoryListQuery: missing teamId throws (no silent empty-where)", () => {
  // Prisma.findMany({ where: {} }) would return everything. A
  // caller without a teamId is a bug at the call site; we want
  // a loud throw, not a query that silently ignores tenancy.
  assert.throws(
    () => buildMemoryListQuery(""),
    /teamId is required/,
  );
  assert.throws(
    () => buildMemoryListQuery(undefined as unknown as string),
    /teamId is required/,
  );
});

test("buildMemoryListQuery: caller-supplied limit is honored when within bounds", () => {
  const q = buildMemoryListQuery("team-abc", { limit: 25 });
  assert.equal(q.take, 25);
});

test("buildMemoryListQuery: limit is clamped to policy.listMaxLimit (upper bound)", () => {
  // DoS guard: a caller passing a huge number can't hose the DB.
  const q = buildMemoryListQuery("team-abc", { limit: 100_000 });
  assert.equal(q.take, DEFAULT_MEMORY_POLICY.listMaxLimit);
});

test("buildMemoryListQuery: limit is clamped to 1 (lower bound)", () => {
  // Zero / negative limits collapse to 1 so callers never get
  // `take: 0` (an empty result) or a Prisma error from `take: -5`.
  const q0 = buildMemoryListQuery("team-abc", { limit: 0 });
  assert.equal(q0.take, 1);
  const qNeg = buildMemoryListQuery("team-abc", { limit: -10 });
  assert.equal(qNeg.take, 1);
});

test("buildMemoryListQuery: NaN / Infinity collapse to 1 (not undefined)", () => {
  // `take: undefined` in Prisma = "no limit" = fetch everything.
  // If a future refactor stops feeding the clamp, this pin trips.
  const qNaN = buildMemoryListQuery("team-abc", { limit: Number.NaN });
  assert.equal(qNaN.take, 1);
  const qInf = buildMemoryListQuery("team-abc", { limit: Number.POSITIVE_INFINITY });
  assert.equal(qInf.take, DEFAULT_MEMORY_POLICY.listMaxLimit);
});

test("buildMemoryListQuery: fractional limits floor to integers (no Prisma TypeError)", () => {
  // Prisma's `take` must be an integer; `take: 12.5` throws at
  // runtime. Clamp floors so a caller passing a computed float
  // (e.g. token-budget math from a future recall slice) doesn't
  // surprise the DB layer.
  const q = buildMemoryListQuery("team-abc", { limit: 12.9 });
  assert.equal(q.take, 12);
});

test("buildMemoryListQuery: custom policy is honored end-to-end", () => {
  const custom: MemoryPolicy = {
    maxBodyLength: 2048,
    defaultKind: "preference",
    listDefaultLimit: 10,
    listMaxLimit: 25,
    // P16-C — recall bounds are part of the policy shape now.
    // `buildMemoryListQuery` ignores them (only the list bounds
    // matter here), but the type demands them so we set
    // something sensible for shape-completeness.
    recallDefaultLimit: 5,
    recallMaxLimit: 10,
    // P16-C.1 — the recall builder overfetches up to this cap;
    // again, the list builder doesn't consume it, but the type
    // demands the field.
    recallScanMaxLimit: 40,
    // P17-A.AUDIT-4 — admin-UI cap. `buildMemoryListQuery` also
    // doesn't consume this, but the type demands it.
    adminListMaxLimit: 250,
  };
  const qDefault = buildMemoryListQuery("team-abc", { policy: custom });
  assert.equal(qDefault.take, 10, "default limit should use custom.listDefaultLimit");
  const qClamped = buildMemoryListQuery("team-abc", { limit: 500, policy: custom });
  assert.equal(qClamped.take, 25, "upper clamp should use custom.listMaxLimit");
});

test("DEFAULT_MEMORY_POLICY: shape is frozen + values are stable", () => {
  // Frozen: mutating the default throws in strict mode (node:test
  // runs strict). Pin both the freeze AND the actual numbers so a
  // future policy retune is intentional, not accidental.
  assert.equal(Object.isFrozen(DEFAULT_MEMORY_POLICY), true);
  assert.equal(DEFAULT_MEMORY_POLICY.maxBodyLength, 1024);
  assert.equal(DEFAULT_MEMORY_POLICY.defaultKind, "fact");
  assert.equal(DEFAULT_MEMORY_POLICY.listDefaultLimit, 50);
  assert.equal(DEFAULT_MEMORY_POLICY.listMaxLimit, 200);
  // P16-C — recall path has its own bounds. Strictly smaller than
  // the list bounds because recall rows feed the model's prompt
  // context, which is token-budgeted.
  assert.equal(DEFAULT_MEMORY_POLICY.recallDefaultLimit, 10);
  assert.equal(DEFAULT_MEMORY_POLICY.recallMaxLimit, 25);
  // P16-C.1 — DB-level scan ceiling for the recall builder's
  // overfetch. Between `recallMaxLimit` and `listMaxLimit` — the
  // builder scans more than the user's final limit (to give
  // post-fetch dedup headroom) but strictly less than the list
  // path's wide-read ceiling.
  assert.equal(DEFAULT_MEMORY_POLICY.recallScanMaxLimit, 100);
  // P17-A.AUDIT-4 — admin `/memories` list cap. Strictly larger
  // than `listMaxLimit` (200) because this surface is multi-team
  // (operator view across every team they can admin); sized to
  // roughly 10 teams × 50-memory default density. Pinned here so
  // a future retune (e.g. when pagination lands and this can
  // shrink) is intentional, not accidental.
  assert.equal(DEFAULT_MEMORY_POLICY.adminListMaxLimit, 500);
});

test("memoryPolicyFromEnv: returns defaults in P16-A (no env reads yet)", () => {
  // P16-A contract: the function takes an env map but doesn't
  // read from it yet. Future slices (P16-B/C) will wire env
  // overrides for specific knobs. This pin forces the test to
  // be updated when that wiring lands, rather than silently
  // changing defaults.
  const p = memoryPolicyFromEnv({});
  assert.deepEqual(p, DEFAULT_MEMORY_POLICY);
  // Verify it ignores env for now (pin the "no env reads" claim).
  const pWithEnv = memoryPolicyFromEnv({
    MEMORY_MAX_BODY: "9999",
    MEMORY_LIST_MAX: "9999",
  });
  assert.deepEqual(pWithEnv, DEFAULT_MEMORY_POLICY);
});

test("memoryPolicyFromEnv: default parameter is process.env (doesn't throw)", () => {
  // Exercises the default-parameter branch without asserting
  // a specific process.env shape. If someone later swaps the
  // default to something that reads a required key, this will
  // fail loudly in tests with a missing-key throw.
  const p = memoryPolicyFromEnv();
  assert.equal(typeof p.maxBodyLength, "number");
  assert.equal(typeof p.defaultKind, "string");
});

test("barrel: @/lib/memory exposes pure runtime exports only (P16-A.1 purity pin)", async () => {
  // GPT P16-A audit blocker: the barrel imported `prisma` at the
  // top level and exported `listMemoriesForTeam`, so every pure
  // consumer of the memory helpers paid a Prisma instantiation
  // cost via the side-effect import in `@/lib/db`. Fix: every DB
  // edge lives in `@/lib/memory/server`; the barrel has NO
  // runtime export that requires prisma.
  //
  // The expected set grows as later slices land pure helpers
  // (P16-B added `validateMemoryWrite` + `MEMORY_KINDS`; P16-C
  // added `buildMemoryRecallQuery` + `rankMemoriesForRecall`).
  // Each of those is pure — no prisma import — so they belong
  // on the barrel. What must STILL be absent: the DB-calling
  // wrappers (`listMemoriesForTeam`, `createMemoryForTeam`,
  // `recallMemoriesForTeam`). Those live in ./server.
  const barrel = await import("../../src/lib/memory");
  const runtimeExports = Object.keys(barrel)
    .filter((k) => k !== "default" && k !== "__esModule")
    .sort();
  assert.deepEqual(runtimeExports, [
    "DEFAULT_MEMORY_POLICY",
    "MEMORY_KINDS",
    "buildMemoryListQuery",
    "buildMemoryRecallQuery",
    "memoryPolicyFromEnv",
    "rankMemoriesForRecall",
    "validateMemoryWrite",
  ]);
  // Explicit negative pins — every DB-calling wrapper must be
  // absent. If a future refactor adds one of these back to the
  // barrel (and therefore imports prisma), this test trips.
  const b = barrel as Record<string, unknown>;
  assert.equal(
    b.listMemoriesForTeam,
    undefined,
    "listMemoriesForTeam must live in @/lib/memory/server, not on the barrel",
  );
  assert.equal(
    b.createMemoryForTeam,
    undefined,
    "createMemoryForTeam must live in @/lib/memory/server, not on the barrel",
  );
  assert.equal(
    b.recallMemoriesForTeam,
    undefined,
    "recallMemoriesForTeam must live in @/lib/memory/server, not on the barrel",
  );
});
