import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";

import { isUniqueViolation, isNotFound } from "../../src/lib/prisma-errors";

// P14-J pin set (half B) — `isUniqueViolation` and `isNotFound` in
// `src/lib/prisma-errors.ts` are Prisma error classifiers used by
// every mutation helper in the app (campaign creates, invitee
// upserts, dispatch state transitions). They key on Prisma's
// stable error codes (P2002, P2025) instead of substring-matching
// `String(e)` — which was the pre-refactor pattern and broke
// across Prisma upgrades.
//
// Regression surfaces protected:
//
//   1. `instanceof` discipline — a duck-typed `{ code: "P2002" }`
//      object MUST NOT classify as a unique violation. If someone
//      "simplifies" to `e?.code === "P2002"`, every plain Error
//      with a `code` field starts matching (and any attacker-
//      controlled JSON deserialized into an error slot would
//      forge the classification).
//
//   2. Exclusive code discrimination — P2002 ≠ P2025. A regression
//      that swaps the codes (copy-paste bug) would break mutation
//      error handling in subtle ways: unique-violation paths
//      would fire on not-found, and not-found paths (often with
//      softer recovery) would mask duplicate-key conflicts.
//
//   3. No-throw on weird inputs — passing null/undefined/string
//      must return false cleanly without crashing. These helpers
//      are called inside `catch (e: unknown)` blocks where `e`
//      can be literally anything.

// Helper: construct a real Prisma error with a given code.
function prismaErr(code: string, message = "test") {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: "test",
  });
}

// ---------------------------------------------------------------
// isUniqueViolation
// ---------------------------------------------------------------

test("isUniqueViolation: P2002 PrismaClientKnownRequestError → true", () => {
  assert.equal(isUniqueViolation(prismaErr("P2002")), true);
});

test("isUniqueViolation: P2025 PrismaClientKnownRequestError → false", () => {
  // Wrong code — MUST discriminate. A regression that swaps P2002
  // with P2025 would silently break every mutation error path.
  assert.equal(isUniqueViolation(prismaErr("P2025")), false);
});

test("isUniqueViolation: other Prisma code (P2003 FK violation) → false", () => {
  assert.equal(isUniqueViolation(prismaErr("P2003")), false);
});

test("isUniqueViolation: plain Error with code='P2002' → false (instanceof discipline)", () => {
  // Load-bearing — if this regressed to `e?.code === "P2002"`,
  // every custom Error with a `code` field would classify as a
  // unique violation. Pinned.
  const err: Error & { code?: string } = new Error("unique violation");
  err.code = "P2002";
  assert.equal(isUniqueViolation(err), false);
});

test("isUniqueViolation: duck-typed POJO {code: 'P2002'} → false", () => {
  // Same as above but via a plain object — MUST NOT classify.
  // This is the canonical regression vector: a "simpler" impl
  // using `(e as any)?.code === "P2002"` would let a random
  // object forge the classification.
  assert.equal(isUniqueViolation({ code: "P2002" }), false);
});

test("isUniqueViolation: null/undefined/string/number don't throw, return false", () => {
  for (const value of [null, undefined, "P2002", 42, 0, "", true, false]) {
    assert.doesNotThrow(() => {
      assert.equal(
        isUniqueViolation(value),
        false,
        `weird input: ${JSON.stringify(value)}`,
      );
    });
  }
});

// ---------------------------------------------------------------
// isNotFound
// ---------------------------------------------------------------

test("isNotFound: P2025 PrismaClientKnownRequestError → true", () => {
  assert.equal(isNotFound(prismaErr("P2025")), true);
});

test("isNotFound: P2002 PrismaClientKnownRequestError → false", () => {
  assert.equal(isNotFound(prismaErr("P2002")), false);
});

test("isNotFound: other Prisma code (P2003) → false", () => {
  assert.equal(isNotFound(prismaErr("P2003")), false);
});

test("isNotFound: plain Error with code='P2025' → false (instanceof discipline)", () => {
  const err: Error & { code?: string } = new Error("record not found");
  err.code = "P2025";
  assert.equal(isNotFound(err), false);
});

test("isNotFound: duck-typed POJO {code: 'P2025'} → false", () => {
  assert.equal(isNotFound({ code: "P2025" }), false);
});

test("isNotFound: null/undefined/string/number don't throw, return false", () => {
  for (const value of [null, undefined, "P2025", 42, 0, "", true, false]) {
    assert.doesNotThrow(() => {
      assert.equal(
        isNotFound(value),
        false,
        `weird input: ${JSON.stringify(value)}`,
      );
    });
  }
});

// ---------------------------------------------------------------
// Mutual exclusivity — unique violation and not-found are disjoint
// ---------------------------------------------------------------

test("mutual exclusivity: P2002 classifies only as unique, not as not-found", () => {
  // Pinned to catch a regression where the two classifiers key on
  // the same code (copy-paste bug). Each code MUST map to exactly
  // one classification.
  const e = prismaErr("P2002");
  assert.equal(isUniqueViolation(e), true);
  assert.equal(isNotFound(e), false);
});

test("mutual exclusivity: P2025 classifies only as not-found, not as unique", () => {
  const e = prismaErr("P2025");
  assert.equal(isUniqueViolation(e), false);
  assert.equal(isNotFound(e), true);
});
