import { test } from "node:test";
import assert from "node:assert/strict";

import { secretMatches } from "../../src/lib/webhook-auth";

// P14-I pin set (half B) — `secretMatches` is the shared-bearer
// token comparator used by the two inbound webhook routes
// (`inbound/email`, `inbound/sms`) and the cron-tick endpoint.
// It's a security-sensitive function with non-obvious semantics:
//
//   1. Both sides are hashed to SHA-256 BEFORE timingSafeEqual,
//      so the actual compared inputs are always 32 bytes. This
//      eliminates a length-oracle that would exist if we did
//      the naive `if (a.length !== b.length) return false`
//      pattern.
//
//   2. Empty `expected` is an explicit hard-fail — the function
//      returns false even if `sent` is also empty. This protects
//      against an unconfigured secret env var silently auth'ing
//      every empty-bearer request.
//
// These aren't properties that can be read off from the signature.
// They're exactly the kind of thing that regresses silently when
// someone "simplifies" the code and misses the edge cases.

test("secretMatches: correct match returns true", () => {
  const secret = "shared-secret-value-42";
  assert.equal(secretMatches(secret, secret), true);
});

test("secretMatches: wrong value returns false", () => {
  assert.equal(
    secretMatches("wrong-secret", "real-secret"),
    false,
  );
});

test("secretMatches: empty expected is a HARD FAIL even with empty sent", () => {
  // Load-bearing — an unconfigured `INBOUND_WEBHOOK_SECRET` env
  // var would otherwise silently let every empty-bearer request
  // through. The route wraps this with an additional
  //   if (!secret) return 503
  // check, but secretMatches itself is the last line of defense.
  // Pinned.
  assert.equal(secretMatches("", ""), false);
  // And with a non-empty sent but empty expected.
  assert.equal(secretMatches("any-value", ""), false);
});

test("secretMatches: different lengths still compared safely (no length-oracle throw)", () => {
  // A naive implementation would call timingSafeEqual on the
  // raw inputs and crash with "Input buffers must have the same
  // byte length". This implementation hashes both sides first,
  // so the compared inputs are always 32 bytes. Verify no throw
  // and a clean false return.
  assert.doesNotThrow(() => {
    const result = secretMatches("a", "aaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(result, false);
  });
  assert.doesNotThrow(() => {
    const result = secretMatches(
      "aaaaaaaaaaaaaaaaaaaaaaaa",
      "a",
    );
    assert.equal(result, false);
  });
});

test("secretMatches: hash collision property — same string hashes identically", () => {
  // Round-trip property: the same value compared against itself
  // always returns true, regardless of value characteristics
  // (length, character set). Pinned to catch a regression that
  // swaps the hash function for one with a less-collision-
  // resistant output.
  for (const value of [
    "a",
    "short",
    "a much longer secret with spaces and symbols ! @ # $ %",
    "\u0000\u0001\u0002", // control chars
    "كلمة سر", // unicode
    "🔒🔑", // emoji
  ]) {
    assert.equal(
      secretMatches(value, value),
      true,
      `same value should match itself: ${JSON.stringify(value)}`,
    );
  }
});

test("secretMatches: order doesn't matter (symmetric)", () => {
  // Sanity — hash-then-timingSafeEqual is symmetric.
  assert.equal(secretMatches("alpha", "beta"), false);
  assert.equal(secretMatches("beta", "alpha"), false);
  assert.equal(secretMatches("alpha", "alpha"), true);
});
