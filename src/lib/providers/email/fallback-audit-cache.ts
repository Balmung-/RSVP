// In-process dedup cache for the Gmail adapter's
// `gmail.routing.fallback` audit (B3 fix).
//
// Problem the cache solves:
//   The Gmail adapter is called once per invitee. When a team
//   campaign's team mailbox isn't connected, EVERY one of its
//   sends trips the team_miss_fallback_office branch. Without
//   dedup, a 500-invitee campaign writes 500 identical fallback
//   rows — which is log spam, not an operator signal. GPT's audit
//   of B3 (dc339c3) flagged this at the wrong granularity: one
//   condition, one log row.
//
// Shape of the fix:
//   - Emit at most once per (requestedTeamId) per DEDUP_WINDOW_MS.
//   - Cache is process-scoped and in-memory; no DB, no config.
//   - A deploy reset surfaces the condition again (desirable — ops
//     may have acted since).
//   - After the window expires while the condition persists, the
//     audit re-fires. Ops get a periodic reminder rather than a
//     single "and then nothing" signal.
//   - Multiple worker processes each emit once per window.
//     Tolerable: worst case N workers × 1 row each, still down
//     from N×recipients.
//
// Why key on requestedTeamId and not (requestedTeamId, fellBackTo):
//   Today the only fallback destination is office_wide, so a
//   second dimension adds no signal. If a future fix introduces
//   multi-step fallback (team -> sibling-team -> office), extend
//   the key rather than logging per step.
//
// Why 10 minutes:
//   - Longer than a typical campaign send loop, so most runs emit
//     exactly one audit even for 1k+ recipients.
//   - Short enough that a persistent condition across the day
//     still produces meaningful periodic reminders (roughly one
//     per operator-attention interval) rather than a single
//     morning log line that might be scrolled past.
//   - Tunable here, not via env — env knobs on audit dedup rarely
//     earn their config-surface cost.
//
// Cache growth: bounded by the number of distinct teamIds that
// have ever hit fallback in this process's lifetime. For our
// protocol-office scale (dozens of teams, not millions) this is
// trivial. No eviction needed.

const DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes.

const lastEmittedAt = new Map<string, number>();

export function shouldEmitFallbackAudit(
  requestedTeamId: string,
  nowMs: number = Date.now(),
): boolean {
  const last = lastEmittedAt.get(requestedTeamId);
  if (last === undefined || nowMs - last > DEDUP_WINDOW_MS) {
    lastEmittedAt.set(requestedTeamId, nowMs);
    return true;
  }
  return false;
}

// Test-only. Clears the dedup cache so each test starts from a
// known state. Zero production callers; exported as __-prefixed
// to signal "only for tests" without inventing a full test-double
// abstraction.
export function __resetFallbackAuditCacheForTests(): void {
  lastEmittedAt.clear();
}

// Exposed for tests that want to assert boundary behavior without
// re-deriving the constant.
export const __FALLBACK_AUDIT_DEDUP_WINDOW_MS = DEDUP_WINDOW_MS;
