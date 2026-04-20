import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REFRESH_COOLDOWN_MS,
  shouldRefreshOnVisibility,
  type VisibilityRefreshInput,
} from "../../src/components/chat/visibilityRefresh";

// P9 — tests for the cross-tab snapshot refresh gate.
//
// Why this matters:
//   - A regression in any gate silently changes UX. Skipping
//     visibility means hidden tabs hammer the endpoint; skipping
//     phase means in-flight streams get race-clobbered; skipping
//     cooldown means rapid alt-tab burns quota.
//   - The cooldown boundary is easy to flip by one tick — pin it.
//   - The clock-skew defense is defensive; if we drop it, a stale
//     lastRefreshMs (which can happen on test setups that freeze
//     Date.now but leave old refs around) blocks refresh forever.

// Helper — a baseline input that passes every gate, so each test
// can override exactly the field it's exercising.
function baseInput(
  overrides: Partial<VisibilityRefreshInput> = {},
): VisibilityRefreshInput {
  return {
    visibilityState: "visible",
    sessionId: "sess-1",
    phase: "idle",
    lastRefreshMs: 0,
    nowMs: 10_000,
    ...overrides,
  };
}

// ---- Happy path --------------------------------------------------

test("shouldRefreshOnVisibility: all gates open → true", () => {
  assert.equal(shouldRefreshOnVisibility(baseInput()), true);
});

test("shouldRefreshOnVisibility: never-refreshed (lastRefreshMs=0) always allows refresh", () => {
  // First-ever focus on a tab that never refreshed must return true
  // even if `nowMs` is tiny. Otherwise the inequality on cooldown
  // blocks the first refresh forever.
  assert.equal(
    shouldRefreshOnVisibility(baseInput({ lastRefreshMs: 0, nowMs: 1 })),
    true,
  );
});

// ---- Visibility gate ---------------------------------------------

test("shouldRefreshOnVisibility: visibilityState 'hidden' → false", () => {
  assert.equal(
    shouldRefreshOnVisibility(baseInput({ visibilityState: "hidden" })),
    false,
  );
});

test("shouldRefreshOnVisibility: visibilityState 'prerender' → false", () => {
  // Chrome uses "prerender" when speculatively loading a page; this
  // is not a user-facing visible state. Must not count.
  assert.equal(
    shouldRefreshOnVisibility(baseInput({ visibilityState: "prerender" })),
    false,
  );
});

test("shouldRefreshOnVisibility: unknown visibility string → false", () => {
  // Defensive — a future browser state we don't know about should
  // NOT trigger a refresh by default.
  assert.equal(
    shouldRefreshOnVisibility(baseInput({ visibilityState: "unloaded" })),
    false,
  );
});

// ---- Session gate ------------------------------------------------

test("shouldRefreshOnVisibility: null sessionId → false (nothing to refresh)", () => {
  assert.equal(
    shouldRefreshOnVisibility(baseInput({ sessionId: null })),
    false,
  );
});

// ---- Phase gate --------------------------------------------------

test("shouldRefreshOnVisibility: phase 'streaming' → false (would race the live SSE)", () => {
  // THE load-bearing gate for in-tab correctness. An active SSE
  // stream is writing turns/widgets; a parallel snapshot fetch
  // could overwrite mid-update state.
  assert.equal(
    shouldRefreshOnVisibility(baseInput({ phase: "streaming" })),
    false,
  );
});

test("shouldRefreshOnVisibility: phase 'hydrating' → false (already fetching)", () => {
  assert.equal(
    shouldRefreshOnVisibility(baseInput({ phase: "hydrating" })),
    false,
  );
});

// ---- Cooldown gate -----------------------------------------------

test("shouldRefreshOnVisibility: lastRefresh 1ms ago → false (within cooldown)", () => {
  assert.equal(
    shouldRefreshOnVisibility(
      baseInput({ lastRefreshMs: 9_999, nowMs: 10_000 }),
    ),
    false,
  );
});

test("shouldRefreshOnVisibility: exactly at cooldown boundary → true", () => {
  // elapsed === REFRESH_COOLDOWN_MS must pass. Off-by-one regression
  // here would silently drop a legitimate refresh every 2s.
  assert.equal(
    shouldRefreshOnVisibility(
      baseInput({
        lastRefreshMs: 10_000,
        nowMs: 10_000 + REFRESH_COOLDOWN_MS,
      }),
    ),
    true,
  );
});

test("shouldRefreshOnVisibility: one ms inside cooldown boundary → false", () => {
  assert.equal(
    shouldRefreshOnVisibility(
      baseInput({
        lastRefreshMs: 10_000,
        nowMs: 10_000 + REFRESH_COOLDOWN_MS - 1,
      }),
    ),
    false,
  );
});

test("shouldRefreshOnVisibility: REFRESH_COOLDOWN_MS pinned at 2000ms", () => {
  // A future refactor that lifts this constant would shift UX —
  // either make focus refresh chattier (low ms) or lag (high ms).
  // Pin the number so the intent is explicit.
  assert.equal(REFRESH_COOLDOWN_MS, 2000);
});

// ---- Clock-skew defense ------------------------------------------

test("shouldRefreshOnVisibility: lastRefreshMs AFTER nowMs (clock skew) → true, not blocked forever", () => {
  // If we didn't defend, a lastRefreshMs from the future would make
  // `elapsed` negative, and a naive `elapsed < COOLDOWN` would block
  // refresh forever after a system clock rewind or a test injecting
  // a stale now.
  assert.equal(
    shouldRefreshOnVisibility(
      baseInput({ lastRefreshMs: 1_000_000, nowMs: 500_000 }),
    ),
    true,
  );
});

// ---- Gate precedence ---------------------------------------------

test("shouldRefreshOnVisibility: visibility check precedes phase (hidden+streaming → false)", () => {
  // Not load-bearing for correctness (both gates block), but pins
  // that hidden tabs never check phase — the listener shouldn't
  // fire a hidden-tab refresh just because the tab is idle.
  assert.equal(
    shouldRefreshOnVisibility(
      baseInput({ visibilityState: "hidden", phase: "streaming" }),
    ),
    false,
  );
});

test("shouldRefreshOnVisibility: session check precedes cooldown (null session + fresh time → false)", () => {
  // A null-session tab should not count as eligible just because
  // the cooldown window has passed.
  assert.equal(
    shouldRefreshOnVisibility(
      baseInput({
        sessionId: null,
        lastRefreshMs: 0,
        nowMs: 1_000_000,
      }),
    ),
    false,
  );
});
