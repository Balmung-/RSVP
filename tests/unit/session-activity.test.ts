import { test } from "node:test";
import assert from "node:assert/strict";

import {
  touchChatSession,
  type SessionActivityPrisma,
} from "../../src/lib/chat/session-activity";

// P17-A.AUDIT-1 — session-activity touchpoint.
//
// The helper is deliberately tiny, so the pins are about INVARIANTS
// not branches:
//
//   (a) It ALWAYS calls `chatSession.update` with `data.updatedAt`
//       set to a live `Date`. The session picker sort key is
//       `updatedAt DESC`; if this call goes missing, recency
//       ordering silently becomes wrong — and since the only
//       observable effect is "wrong order", a missing call is
//       exactly the bug class GPT's deep audit caught before.
//   (b) It ALWAYS narrows the returning row with `select: { id: true }`
//       — we don't need the full row, and an accidental wide select
//       would mean every message write pulls the whole session
//       payload over the wire on the way back.
//   (c) A thrown error is SWALLOWED, not rethrown. A stale
//       `updatedAt` is a UX hint; the message row that preceded
//       this call is already durable. Failing the outer request
//       because the recency-bump hit a constraint would be
//       strictly worse.
//   (d) An empty / missing sessionId short-circuits BEFORE any
//       DB call. Prisma would otherwise fail with a P2025
//       (record-not-found) on the where clause.

function makeFakePrisma(
  behaviour: "ok" | "throw" = "ok",
): {
  prisma: SessionActivityPrisma;
  calls: Array<{ where: { id: string }; data: { updatedAt: Date }; select: { id: true } }>;
} {
  const calls: Array<{
    where: { id: string };
    data: { updatedAt: Date };
    select: { id: true };
  }> = [];
  const prisma: SessionActivityPrisma = {
    chatSession: {
      update: async (args) => {
        calls.push(args);
        if (behaviour === "throw") {
          throw new Error("simulated: record not found");
        }
        return { id: args.where.id };
      },
    },
  };
  return { prisma, calls };
}

test("touchChatSession calls chatSession.update with updatedAt set to a live Date", async () => {
  const { prisma, calls } = makeFakePrisma();
  const before = Date.now();
  await touchChatSession(prisma, "sess-1");
  const after = Date.now();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].where.id, "sess-1");
  assert.ok(calls[0].data.updatedAt instanceof Date);
  const t = calls[0].data.updatedAt.getTime();
  assert.ok(
    t >= before && t <= after,
    `updatedAt (${t}) should be between before (${before}) and after (${after})`,
  );
});

test("touchChatSession narrows the returning row with select: { id: true }", async () => {
  const { prisma, calls } = makeFakePrisma();
  await touchChatSession(prisma, "sess-1");
  // A wider select would be a silent regression (every message
  // write would pull a full session row). Pin the narrow shape.
  assert.deepEqual(calls[0].select, { id: true });
});

test("touchChatSession swallows errors and does not rethrow", async () => {
  const { prisma, calls } = makeFakePrisma("throw");
  // Intentionally not wrapping in try/catch — the test itself
  // would fail on any rethrow, which is the assertion.
  await touchChatSession(prisma, "sess-1");
  assert.equal(calls.length, 1);
  // And the function completed (we reached this line without a
  // throw having escaped).
});

test("touchChatSession short-circuits on empty sessionId (no DB call)", async () => {
  const { prisma, calls } = makeFakePrisma();
  await touchChatSession(prisma, "");
  assert.equal(
    calls.length,
    0,
    "empty sessionId should not reach the prisma surface",
  );
});

test("touchChatSession short-circuits on non-string sessionId (no DB call)", async () => {
  const { prisma, calls } = makeFakePrisma();
  // Defensive pin — a cold callsite that passes a null-coerced
  // value (runtime-type-lies) must not hit Prisma.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await touchChatSession(prisma, null as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await touchChatSession(prisma, undefined as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await touchChatSession(prisma, 42 as any);
  assert.equal(calls.length, 0);
});
