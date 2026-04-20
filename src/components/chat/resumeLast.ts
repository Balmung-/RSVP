import type { SessionListItem } from "@/app/api/chat/sessions/handler";

// Pure helper for P4-B's "resume last active session" behavior.
//
// When ChatWorkspace mounts WITHOUT a `?session=` param, it fetches
// the session list and calls `selectResumeSessionId(sessions)` to
// decide which one to auto-hydrate. Returns null for a first-time
// operator (empty list) — the caller then leaves the workspace in
// its fresh-session state (null sessionId, empty turns/widgets,
// composer ready for a first ask).
//
// Why a separate pure helper:
//   - The "pick newest" rule is about to grow defensively (skip
//     malformed rows, defend against a future server re-sort), and
//     inlining it in a useEffect would leave it untestable.
//   - A unit test can pin the exact shape without a React harness.
//
// Contract (what the caller depends on):
//   - Returns a non-empty string id when the list has at least one
//     valid row.
//   - Returns null when: list is empty, list is not an array (bad
//     response body), all rows are malformed.
//   - When ordering matters (multiple valid rows), returns the id
//     of the row with the LARGEST `updatedAt`. Tie-breaker: the
//     row that appears first in the input.
//
// The server's Prisma query orders by `updatedAt desc`, so index 0
// is already correct. We scan-and-compare anyway so a hypothetical
// middleware re-sort (e.g. a future response transformer alphabetizing
// titles) can't silently break resume-last.

export function selectResumeSessionId(
  sessions: ReadonlyArray<SessionListItem> | undefined | null,
): string | null {
  if (!Array.isArray(sessions) || sessions.length === 0) return null;

  let best: SessionListItem | null = null;
  for (const s of sessions) {
    if (!isValidSession(s)) continue;
    if (best === null) {
      best = s;
      continue;
    }
    // ISO 8601 strings sort lexicographically in chronological
    // order, so plain string compare is safe and avoids a Date
    // construction per row.
    if (s.updatedAt > best.updatedAt) {
      best = s;
    }
  }
  return best ? best.id : null;
}

function isValidSession(s: unknown): s is SessionListItem {
  if (!s || typeof s !== "object") return false;
  const obj = s as Partial<SessionListItem>;
  if (typeof obj.id !== "string" || obj.id.length === 0) return false;
  if (typeof obj.updatedAt !== "string" || obj.updatedAt.length === 0) {
    return false;
  }
  return true;
}
