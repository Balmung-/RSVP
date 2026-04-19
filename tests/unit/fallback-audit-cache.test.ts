import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldEmitFallbackAudit,
  __resetFallbackAuditCacheForTests,
  __FALLBACK_AUDIT_DEDUP_WINDOW_MS,
} from "../../src/lib/providers/email/fallback-audit-cache";

// Pins the dedup contract introduced after GPT flagged the B3
// fallback audit as per-invitee noise. Without dedup, a 500-
// recipient campaign whose team mailbox is missing would write
// 500 identical `gmail.routing.fallback` rows — the exact
// "one condition, many rows" anti-pattern that buries the signal
// operators need ("connect team X's mailbox"). Each test reset
// the cache so assertions are independent of run order.

function beforeEach() {
  __resetFallbackAuditCacheForTests();
}

test("first emission for a team returns true (the condition is newly observed)", () => {
  beforeEach();
  assert.equal(shouldEmitFallbackAudit("team-a", 1_000_000), true);
});

test("second emission within window returns false (suppresses per-invitee spam)", () => {
  beforeEach();
  assert.equal(shouldEmitFallbackAudit("team-a", 1_000_000), true);
  assert.equal(shouldEmitFallbackAudit("team-a", 1_000_100), false);
  assert.equal(shouldEmitFallbackAudit("team-a", 1_050_000), false);
});

test("emission exactly at the window boundary still suppresses (> not >=)", () => {
  // Boundary probe. The helper uses strict `>` so "equal to window"
  // is still within the dedup period. Without this test a future
  // refactor to `>=` would silently let one extra audit through
  // per boundary-hit send.
  beforeEach();
  const t0 = 1_000_000;
  assert.equal(shouldEmitFallbackAudit("team-a", t0), true);
  const onBoundary = t0 + __FALLBACK_AUDIT_DEDUP_WINDOW_MS;
  assert.equal(shouldEmitFallbackAudit("team-a", onBoundary), false);
});

test("emission past the window returns true (condition re-surfaces)", () => {
  beforeEach();
  const t0 = 1_000_000;
  assert.equal(shouldEmitFallbackAudit("team-a", t0), true);
  const justPast = t0 + __FALLBACK_AUDIT_DEDUP_WINDOW_MS + 1;
  assert.equal(shouldEmitFallbackAudit("team-a", justPast), true);
});

test("different teamIds dedup independently", () => {
  // A campaign for team-a and a campaign for team-b running in the
  // same window must each get their own audit — they're distinct
  // operator-actionable conditions ("connect team-a's mailbox" vs
  // "connect team-b's"). If we keyed on (nothing) or (window-only),
  // only the first team's audit would land.
  beforeEach();
  assert.equal(shouldEmitFallbackAudit("team-a", 1_000_000), true);
  assert.equal(shouldEmitFallbackAudit("team-b", 1_000_100), true);
  // And each stays deduped within its own window.
  assert.equal(shouldEmitFallbackAudit("team-a", 1_000_200), false);
  assert.equal(shouldEmitFallbackAudit("team-b", 1_000_300), false);
});

test("re-emission after expiry resets the window (sliding, not fixed)", () => {
  // The window is "since last emission", not "since first ever
  // emission." A persistent condition emits once, then again after
  // one window, then again, etc. — at a steady periodic cadence,
  // not one emission at startup and silence forever.
  beforeEach();
  const t0 = 1_000_000;
  const step = __FALLBACK_AUDIT_DEDUP_WINDOW_MS + 1;
  assert.equal(shouldEmitFallbackAudit("team-a", t0), true);
  assert.equal(shouldEmitFallbackAudit("team-a", t0 + step), true);
  assert.equal(shouldEmitFallbackAudit("team-a", t0 + 2 * step), true);
  // And still deduped within each new window.
  assert.equal(shouldEmitFallbackAudit("team-a", t0 + 2 * step + 10), false);
});

test("reset-for-tests fully clears the cache (no leakage across files)", () => {
  beforeEach();
  assert.equal(shouldEmitFallbackAudit("team-a", 1_000_000), true);
  __resetFallbackAuditCacheForTests();
  // After reset, the SAME (teamId, timestamp) should be "first
  // emission" again — otherwise the helper would be irreparable
  // for test reuse.
  assert.equal(shouldEmitFallbackAudit("team-a", 1_000_100), true);
});
