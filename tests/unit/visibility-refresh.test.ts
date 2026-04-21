import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LIVE_SNAPSHOT_POLL_MS,
  REFRESH_COOLDOWN_MS,
  shouldRefreshOnPoll,
  shouldRefreshOnVisibility,
  type PollRefreshInput,
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
    refreshInFlight: false,
    nowMs: 10_000,
    ...overrides,
  };
}

function basePollInput(
  overrides: Partial<PollRefreshInput> = {},
): PollRefreshInput {
  return {
    visibilityState: "visible",
    sessionId: "sess-1",
    phase: "idle",
    refreshInFlight: false,
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

// ---- In-flight guard (P9-fix for GPT blocker on 489a4df) -----------
//
// The regression GPT flagged: `lastRefreshMs` only advances on a
// SUCCESSFUL apply. During the 50-200ms fetch RTT, a second
// visibility event would see the same stale timestamp (often still
// the 0 sentinel) and fire a duplicate GET /api/chat/session/:id.
// The apply-time guards prevent stale overwrite but not duplicate
// request fan-out. The `refreshInFlight` flag is an optimistic
// attempt latch set before the fetch and cleared on settle.

test("shouldRefreshOnVisibility: refreshInFlight true → false (duplicate-request guard)", () => {
  // Even with every other gate open — including the never-refreshed
  // sentinel that bypasses cooldown — an in-flight fetch must block
  // a second attempt. Without this, the cooldown guarantee is broken
  // on the very first attempt because lastRefreshMs is still 0.
  assert.equal(
    shouldRefreshOnVisibility(baseInput({ refreshInFlight: true })),
    false,
  );
});

test("shouldRefreshOnVisibility: refreshInFlight true + cooldown elapsed → false (latch beats cooldown)", () => {
  // The latch must sit BEFORE the cooldown math, not after. If a
  // future refactor reordered the checks, a long-pending fetch would
  // let a parallel attempt fire after 2s — defeating the guarantee.
  assert.equal(
    shouldRefreshOnVisibility(
      baseInput({
        refreshInFlight: true,
        lastRefreshMs: 1_000,
        nowMs: 1_000 + REFRESH_COOLDOWN_MS + 500,
      }),
    ),
    false,
  );
});

test("shouldRefreshOnVisibility: first visible → true, second visible while in-flight → false (the exact scenario)", () => {
  // This is the direct regression test GPT asked for: "first
  // visibility event starts refresh, second visible event before
  // settle does not start another GET."
  //
  // Step 1: clean tab, never refreshed, not in flight — gate opens.
  const firstAttempt = baseInput({
    lastRefreshMs: 0,
    refreshInFlight: false,
  });
  assert.equal(shouldRefreshOnVisibility(firstAttempt), true);

  // Step 2: the caller flips the latch true BEFORE firing the fetch,
  // then the operator quickly hides+re-shows the tab. The fetch has
  // not settled, so lastRefreshMs is still 0. The latch must block
  // the second attempt.
  const secondAttemptMidFlight = baseInput({
    lastRefreshMs: 0,
    refreshInFlight: true,
  });
  assert.equal(shouldRefreshOnVisibility(secondAttemptMidFlight), false);

  // Step 3: fetch settles, lastRefreshMs advances to the attempt
  // time, latch clears. Third attempt within the cooldown window
  // should now be blocked by cooldown (not by the latch).
  const thirdAttemptAfterSettle = baseInput({
    lastRefreshMs: 10_000,
    nowMs: 10_000 + 500,
    refreshInFlight: false,
  });
  assert.equal(shouldRefreshOnVisibility(thirdAttemptAfterSettle), false);
});

test("LIVE_SNAPSHOT_POLL_MS pinned at 10000ms", () => {
  assert.equal(LIVE_SNAPSHOT_POLL_MS, 10_000);
});

test("shouldRefreshOnPoll: visible + session + idle + not in flight → true", () => {
  assert.equal(shouldRefreshOnPoll(basePollInput()), true);
});

test("shouldRefreshOnPoll: hidden tab → false", () => {
  assert.equal(
    shouldRefreshOnPoll(basePollInput({ visibilityState: "hidden" })),
    false,
  );
});

test("shouldRefreshOnPoll: null session → false", () => {
  assert.equal(
    shouldRefreshOnPoll(basePollInput({ sessionId: null })),
    false,
  );
});

test("shouldRefreshOnPoll: streaming phase → false", () => {
  assert.equal(
    shouldRefreshOnPoll(basePollInput({ phase: "streaming" })),
    false,
  );
});

test("shouldRefreshOnPoll: in-flight fetch → false", () => {
  assert.equal(
    shouldRefreshOnPoll(basePollInput({ refreshInFlight: true })),
    false,
  );
});
