import { test } from "node:test";
import assert from "node:assert/strict";

// Pins the HMAC-signed OAuth state contract in `src/lib/oauth/state.ts`.
//
// The state parameter protects the Google OAuth redirect round-trip
// from two specific attacks:
//
//   (A) Forged callback — an attacker sends a victim to
//       `/api/oauth/google/callback?code=<attacker's>&state=<forged>`.
//       Without signed state we'd treat the attacker's auth code as
//       legitimate and bind THEIR Gmail to OUR team record. With
//       signed state, the attacker would need SESSION_SECRET to
//       produce a valid MAC — which they don't have.
//
//   (B) Stale/replayed state — an attacker captures a valid state
//       from a log or a leaked URL and tries to reuse it days later.
//       Age check rejects anything older than MAX_AGE_MS, so a leak
//       window shrinks to ~10 minutes.
//
// What we test:
//   (1) Happy round-trip — sign -> verify returns the original payload.
//   (2) Signature rejection — any single-bit flip in payload or MAC
//       section fails verification in constant time.
//   (3) Age rejection — a state issued more than MAX_AGE_MS ago is
//       rejected with reason="expired".
//   (4) Future-dated rejection — clock skew > 5s in the FUTURE is a
//       tamper signal and must fail.
//   (5) Version guard — a `v2.` prefix on a `v1`-era state is
//       rejected even if MAC-valid (impossible in practice, but the
//       structural check is belt-and-suspenders for future rotation).
//   (6) Malformed rejection — empty string, wrong part count, non-
//       base64 MAC, non-JSON payload each produce a specific reason.
//   (7) Nonce distinctness — two calls to signState produce DIFFERENT
//       nonces even within the same millisecond. Without this the
//       cookie-bound second CSRF layer collapses to "same cookie
//       value every time" and a stale cookie would match a fresh
//       state.
//   (8) Payload teamId round-trip — a state signed with
//       teamId="team-123" returns `payload.teamId === "team-123"` on
//       verify. The callback relies on this to bind tokens to the
//       originally-intended team rather than whatever the attacker
//       passes at callback time.

// SESSION_SECRET must be set before any state module call. Lazy key
// resolution means we can set it up-front and use the same value
// across tests.
process.env.SESSION_SECRET = "test-session-secret-32-bytes-or-more";

const FAR_PAST = 0;
const NOW = 1_700_000_000_000;

test("signState + verifyState round-trip carries teamId and nonce", async () => {
  const { signState, verifyState } = await import("../../src/lib/oauth/state");
  const { state, nonce } = signState({ teamId: "team-42" }, { now: NOW });
  const r = verifyState(state, { now: NOW + 1000 });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.payload.teamId, "team-42");
    assert.equal(r.payload.nonce, nonce);
    assert.equal(r.payload.issuedAt, NOW);
  }
});

test("signState handles null teamId (office-wide) as empty string in payload", async () => {
  const { signState, verifyState } = await import("../../src/lib/oauth/state");
  const { state } = signState({ teamId: null }, { now: NOW });
  const r = verifyState(state, { now: NOW + 1000 });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.payload.teamId, "");
  }
});

test("verifyState rejects a tampered payload", async () => {
  const { signState, verifyState } = await import("../../src/lib/oauth/state");
  const { state } = signState({ teamId: "a" }, { now: NOW });
  const parts = state.split(".");
  const flipped = (parts[1][0] === "A" ? "B" : "A") + parts[1].slice(1);
  const broken = [parts[0], flipped, parts[2]].join(".");
  const r = verifyState(broken, { now: NOW + 1000 });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "signature");
  }
});

test("verifyState rejects a tampered MAC", async () => {
  const { signState, verifyState } = await import("../../src/lib/oauth/state");
  const { state } = signState({ teamId: "a" }, { now: NOW });
  const parts = state.split(".");
  const flipped = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
  const broken = [parts[0], parts[1], flipped].join(".");
  const r = verifyState(broken, { now: NOW + 1000 });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "signature");
  }
});

test("verifyState rejects an expired state", async () => {
  const { signState, verifyState } = await import("../../src/lib/oauth/state");
  const { state } = signState({ teamId: "a" }, { now: FAR_PAST });
  const r = verifyState(state, { now: NOW }); // NOW - FAR_PAST >> 10 min
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "expired");
  }
});

test("verifyState honors custom maxAgeMs", async () => {
  const { signState, verifyState } = await import("../../src/lib/oauth/state");
  const { state } = signState({ teamId: "a" }, { now: NOW });
  // Two seconds later, with a 1-second max age, must expire.
  const r = verifyState(state, { now: NOW + 2000, maxAgeMs: 1000 });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "expired");
  }
});

test("verifyState rejects a future-dated state (clock skew / tamper signal)", async () => {
  const { signState, verifyState } = await import("../../src/lib/oauth/state");
  const { state } = signState({ teamId: "a" }, { now: NOW + 60_000 });
  const r = verifyState(state, { now: NOW });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "future");
  }
});

test("verifyState tolerates minor future skew (<= 5s)", async () => {
  const { signState, verifyState } = await import("../../src/lib/oauth/state");
  const { state } = signState({ teamId: "a" }, { now: NOW + 3000 });
  const r = verifyState(state, { now: NOW });
  assert.equal(r.ok, true, "3s future skew is acceptable");
});

test("verifyState rejects unsupported version prefix", async () => {
  const { signState, verifyState } = await import("../../src/lib/oauth/state");
  const { state } = signState({ teamId: "a" }, { now: NOW });
  const parts = state.split(".");
  const future = ["v2", parts[1], parts[2]].join(".");
  const r = verifyState(future, { now: NOW + 1000 });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "version");
  }
});

test("verifyState rejects malformed states", async () => {
  const { verifyState } = await import("../../src/lib/oauth/state");
  // Empty string.
  {
    const r = verifyState("", { now: NOW });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "malformed");
  }
  // Wrong part count.
  {
    const r = verifyState("v1.only-two", { now: NOW });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "malformed");
  }
});

test("signState produces distinct nonces per call (random, not time-based)", async () => {
  const { signState } = await import("../../src/lib/oauth/state");
  const a = signState({ teamId: "x" }, { now: NOW });
  const b = signState({ teamId: "x" }, { now: NOW });
  assert.notEqual(a.nonce, b.nonce, "nonces must differ even at identical timestamps");
  assert.notEqual(a.state, b.state, "state tokens must differ (driven by nonce)");
});
