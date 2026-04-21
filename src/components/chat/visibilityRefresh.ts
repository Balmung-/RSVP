import type { Phase } from "./types";

// P9 — cross-tab / non-SSE consistency.
//
// When an operator has /chat open in two tabs on the same session and
// takes a mutation action in tab A (/confirm, /dismiss, or a tool
// that creates an import widget), tab A's live SSE stream reflects
// the change. Tab B — sitting in the background — has no way to
// know. Before this helper, tab B stayed stuck on the pre-mutation
// widget state until the operator sent another message or manually
// reloaded.
//
// The narrow solution: when tab B regains visibility (user alt-tabs
// back, unhides the tab, etc.), re-fetch the current session's
// authoritative snapshot from GET /api/chat/session/:id and replace
// the local turns + widgets with the server's view.
//
// Why a separate pure decision helper:
//   - A `visibilitychange` listener closes over React state; testing
//     the gate logic through a live document.visibilityState would
//     need a jsdom harness. A data-in, boolean-out helper is cheap
//     to test without any DOM.
//   - Gate logic has several load-bearing conditions (visibility,
//     session presence, phase, cooldown) and a regression in any of
//     them fails silently. Pinning each as a test keeps the behavior
//     locked.
//
// Gates (all must pass for refresh to fire):
//   - `visibilityState === "visible"` — the tab actually has user
//     attention. Skipping hidden tabs matters for battery + for
//     the "prerender" state Chrome uses when it speculatively loads
//     a page.
//   - `sessionId` is set — a fresh /chat workspace with no session
//     has nothing to refresh.
//   - `phase === "idle"` — a mid-hydrate or mid-stream fetch MUST
//     NOT be interrupted by a parallel snapshot fetch that would
//     race-condition the turns/widgets state.
//   - cooldown elapsed — a user rapidly alt-tabbing between apps
//     would otherwise fire N requests per second. 2s is short
//     enough that "switched back after a few seconds to see the
//     update" works, long enough that repeated flicker doesn't
//     hammer the endpoint.
//
// Clock-skew defense: if `lastRefreshMs > nowMs` (a test injects a
// stale `now`, or a system clock rewinds mid-session), we treat
// the cooldown as elapsed rather than blocking forever.
//
// In-flight guard (P9-fix for GPT blocker on 489a4df):
//   - `lastRefreshMs` only advances AFTER a successful apply. The
//     fetch has a 50-200ms RTT window. If the operator goes
//     visible -> hidden -> visible quickly before the first GET
//     settles, the second visibility event sees the same stale
//     `lastRefreshMs` (often still the 0 sentinel) and the gate
//     fires a DUPLICATE /api/chat/session/:id request.
//   - The apply-time guards (sessionIdRef, phaseRef) prevent stale
//     overwrite but NOT duplicate request fan-out. That breaks the
//     cooldown's "at most one refresh per 2s" guarantee.
//   - `refreshInFlight` is an optimistic attempt latch flipped true
//     at attempt time (before the fetch is even sent) and cleared
//     when the fetch settles. Second visibility event during the
//     first fetch sees the latch and skips.

export type VisibilityRefreshInput = {
  visibilityState: string;
  sessionId: string | null;
  phase: Phase;
  // Timestamp of the last successful refresh; 0 if the tab has never
  // refreshed. Using a numeric epoch (not a Date) keeps the helper
  // trivially serialisable and the tests deterministic.
  lastRefreshMs: number;
  // True while a refresh fetch is pending (set before the fetch is
  // fired, cleared when it settles). Prevents duplicate-request fan-out
  // when the operator rapidly toggles visibility.
  refreshInFlight: boolean;
  nowMs: number;
};

export const REFRESH_COOLDOWN_MS = 2000;
export const LIVE_SNAPSHOT_POLL_MS = 10000;

export function shouldRefreshOnVisibility(
  input: VisibilityRefreshInput,
): boolean {
  if (input.visibilityState !== "visible") return false;
  if (!input.sessionId) return false;
  if (input.phase !== "idle") return false;
  // In-flight guard must sit BEFORE the cooldown math. The cooldown
  // starts from the last SUCCESSFUL apply, not the last attempt, so
  // on a very first attempt (lastRefreshMs=0 sentinel) the cooldown
  // gate would otherwise allow a second fetch to piggyback on the
  // first one's in-flight window.
  if (input.refreshInFlight) return false;

  // lastRefreshMs === 0 is the "never refreshed" sentinel. A fresh
  // tab mount at low nowMs (tests, or a page loaded moments after
  // perf.timeOrigin) would otherwise fall inside the cooldown window
  // against zero and silently skip the very first focus refresh.
  if (input.lastRefreshMs === 0) return true;

  const elapsed = input.nowMs - input.lastRefreshMs;
  // elapsed < 0 (stale lastRefreshMs relative to now) — allow the
  // refresh rather than block forever. A real regression here would
  // be `elapsed < REFRESH_COOLDOWN_MS` silently swallowing a legit
  // focus event because of a prior clock hiccup.
  if (elapsed >= 0 && elapsed < REFRESH_COOLDOWN_MS) return false;

  return true;
}

export type PollRefreshInput = {
  visibilityState: string;
  sessionId: string | null;
  phase: Phase;
  refreshInFlight: boolean;
};

export function shouldRefreshOnPoll(
  input: PollRefreshInput,
): boolean {
  if (input.visibilityState !== "visible") return false;
  if (!input.sessionId) return false;
  if (input.phase !== "idle") return false;
  if (input.refreshInFlight) return false;
  return true;
}
