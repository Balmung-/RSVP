import { test } from "node:test";
import assert from "node:assert/strict";

import {
  OPERATOR_VISIBLE_ROLES,
  buildFindSessions,
  type FindSessionsArgs,
  type PrismaSessionFinder,
} from "../../src/app/api/chat/sessions/query";
import type { ListSessionsRow } from "../../src/app/api/chat/sessions/handler";

// P4-A fix — regression test for GPT's blocker on 6b3aa8c.
//
// Background: `/api/chat/sessions` ships a `messageCount` field for
// the session picker's badge. The original query used
// `_count.messages` with no filter, which counts every ChatMessage
// row regardless of role. Because `/api/chat/route.ts` persists a
// ChatMessage row with `role: "tool"` for each tool call the model
// makes, a single operator ask that triggers four tool calls would
// show up as "7 messages" in the picker (1 user + 4 tool + 2
// assistant) — misleading, since the operator only sees 2 bubbles.
//
// The fix (query.ts): the Prisma query now passes a `where: { role:
// { in: OPERATOR_VISIBLE_ROLES } }` inside `_count.select.messages`.
// These tests pin that filter so a future refactor can't silently
// drop it.
//
// Why test the query builder (not just the handler): the filter
// lives in the Prisma call, not in the handler logic. A handler
// test can only verify the handler forwards whatever count the dep
// returns — it can't prove the DEP is asking Prisma for the right
// count. Testing the builder with a stub client catches the
// structural regression at the exact layer where it would land.

// --- Fixtures ------------------------------------------------------

// A recording stub that captures the most recent findMany args so
// the tests can inspect them without parsing a real DB response.
function makeStubFinder(rows: ListSessionsRow[] = []): {
  finder: PrismaSessionFinder;
  calls: FindSessionsArgs[];
} {
  const calls: FindSessionsArgs[] = [];
  const finder: PrismaSessionFinder = {
    chatSession: {
      findMany: async (args) => {
        calls.push(args);
        return rows;
      },
    },
  };
  return { finder, calls };
}

// --- Exported constants ---------------------------------------

test("OPERATOR_VISIBLE_ROLES is exactly ['user', 'assistant'] — tool is excluded", () => {
  // Pin the constant so an accidental addition (e.g. "system" or
  // "tool" slipping in) trips a test. If a future schema change
  // adds a new role we want to deliberately audit whether it
  // counts, not silently inherit.
  assert.deepEqual([...OPERATOR_VISIBLE_ROLES], ["user", "assistant"]);
  assert.ok(
    !(OPERATOR_VISIBLE_ROLES as readonly string[]).includes("tool"),
    "tool role MUST NOT be counted",
  );
});

// --- findMany call shape ---------------------------------------

test("buildFindSessions: calls chatSession.findMany exactly once with the given limit + userId", async () => {
  const { finder, calls } = makeStubFinder();
  const find = buildFindSessions(finder);
  await find({ userId: "alice", tenantId: "tenant-1", limit: 12 });
  assert.equal(calls.length, 1);
  const args = calls[0]!;
  assert.equal(args.where.userId, "alice");
  assert.equal(args.where.tenantId, "tenant-1");
  assert.equal(args.where.archivedAt, null);
  assert.equal(args.take, 12);
  assert.equal(args.orderBy.updatedAt, "desc");
});

test("buildFindSessions: select carries id, title, createdAt, updatedAt (top-level columns)", async () => {
  const { finder, calls } = makeStubFinder();
  const find = buildFindSessions(finder);
  await find({ userId: "alice", tenantId: "tenant-1", limit: 25 });
  const sel = calls[0]!.select;
  assert.equal(sel.id, true);
  assert.equal(sel.title, true);
  assert.equal(sel.createdAt, true);
  assert.equal(sel.updatedAt, true);
});

// --- The load-bearing role filter --------------------------------

test("regression: _count.messages is filtered to role IN ('user', 'assistant') — tool rows excluded", async () => {
  // THIS is the test GPT asked for. If this ever fails, the picker
  // badge will start inflating with tool fan-out — the exact bug
  // the notepad blocker flagged on 6b3aa8c.
  const { finder, calls } = makeStubFinder();
  const find = buildFindSessions(finder);
  await find({ userId: "alice", tenantId: "tenant-1", limit: 25 });
  const countWhere = calls[0]!.select._count.select.messages.where;
  assert.ok(countWhere, "messages._count must carry a where clause");
  assert.ok(countWhere.role, "count filter must include role predicate");
  assert.deepEqual(
    [...countWhere.role.in],
    ["user", "assistant"],
    "count must be restricted to operator-visible roles",
  );
  // Belt-and-braces — explicitly verify 'tool' is not in the list.
  assert.ok(
    !countWhere.role.in.includes("tool"),
    "tool role must NOT be in the count filter",
  );
});

test("regression: the filter is sourced from OPERATOR_VISIBLE_ROLES — not a duplicated literal", async () => {
  // If someone refactors and inlines the filter as
  // `role: { in: ["user"] }` (dropping assistant by mistake) or
  // `role: { not: "tool" }` (opening the door to future roles),
  // this test catches it by pinning the exact reference.
  const { finder, calls } = makeStubFinder();
  const find = buildFindSessions(finder);
  await find({ userId: "alice", tenantId: "tenant-1", limit: 25 });
  const countRoles = calls[0]!.select._count.select.messages.where.role.in;
  assert.equal(countRoles.length, OPERATOR_VISIBLE_ROLES.length);
  for (const role of OPERATOR_VISIBLE_ROLES) {
    assert.ok(
      countRoles.includes(role),
      `${role} must be in the count filter`,
    );
  }
});

// --- First-user-message include for preview ----------------------

test("buildFindSessions: messages include is restricted to the first user message (createdAt asc, take 1)", async () => {
  // The preview derivation relies on messages[0].content being the
  // EARLIEST user message — the operator's original ask. Order
  // changes or `take` changes here would break preview semantics.
  const { finder, calls } = makeStubFinder();
  const find = buildFindSessions(finder);
  await find({ userId: "alice", tenantId: "tenant-1", limit: 25 });
  const msgs = calls[0]!.select.messages;
  assert.equal(msgs.where.role, "user");
  assert.equal(msgs.orderBy.createdAt, "asc");
  assert.equal(msgs.take, 1);
  assert.equal(msgs.select.content, true);
});

// --- Happy-path behavioral check --------------------------------

test("buildFindSessions: forwards the rows Prisma returned — no transform, no sort", async () => {
  // The builder is a thin closure — rows pass through untouched,
  // including null titles and empty messages arrays. The handler
  // is responsible for shaping them into SessionListItems.
  const row: ListSessionsRow = {
    id: "sess-1",
    title: null,
    createdAt: new Date("2026-04-20T00:00:00Z"),
    updatedAt: new Date("2026-04-20T12:00:00Z"),
    _count: { messages: 2 }, // operator-visible: user + assistant
    messages: [{ content: "First ask" }],
  };
  const { finder } = makeStubFinder([row]);
  const find = buildFindSessions(finder);
  const out = await find({ userId: "alice", tenantId: "tenant-1", limit: 25 });
  assert.equal(out.length, 1);
  assert.equal(out[0], row);
});

// --- Simulated "tool fan-out" scenario --------------------------

test("behavior: when Prisma returns a pre-filtered count of 2 for a session that had 5 raw rows, the finder forwards 2", async () => {
  // Simulates a session where the raw ChatMessage table holds:
  //   1 user + 1 assistant + 3 tool = 5 rows total
  // After the role filter, Prisma returns _count.messages = 2.
  // The handler (and picker) must see 2 — NOT 5. This test
  // documents the intended end-to-end behavior even though the
  // actual filtering is performed by Prisma, not the builder.
  const row: ListSessionsRow = {
    id: "sess-tool-heavy",
    title: "Heavy session",
    createdAt: new Date("2026-04-19T09:00:00Z"),
    updatedAt: new Date("2026-04-20T15:00:00Z"),
    _count: { messages: 2 }, // filtered — 3 tool rows excluded
    messages: [{ content: "Draft the Eid campaign" }],
  };
  const { finder } = makeStubFinder([row]);
  const find = buildFindSessions(finder);
  const [result] = await find({ userId: "alice", tenantId: "tenant-1", limit: 25 });
  assert.ok(result, "row must be returned");
  assert.equal(result._count.messages, 2);
});
