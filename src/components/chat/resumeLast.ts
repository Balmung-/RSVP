import type { SessionListItem } from "@/app/api/chat/sessions/handler";

// Pure helpers for P4-B's "resume last active session" behavior.
//
// When ChatWorkspace mounts WITHOUT a `?session=` param, it fetches
// the session list and calls `decideResumeAction({...})` to decide
// whether to auto-hydrate the newest session or stand down. The
// decision is pure + data-in so the hook-level effect is a thin
// shell and the race-sensitive cases are directly testable.
//
// Why two helpers (`decideResumeAction` + `selectResumeSessionId`):
//   - `selectResumeSessionId` answers "given this list, which id is
//     newest?" — no knowledge of the current workspace state.
//   - `decideResumeAction` answers "given the current workspace
//     state AND a session list, should we resume / wait / stand
//     down?" — this is where the race gates live.
//
// Contract for `selectResumeSessionId`:
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
//
// Contract for `decideResumeAction`:
//   - "resume" — no obstructing state, at least one valid session:
//     the caller should hydrate the returned id.
//   - "wait"   — sessions list hasn't arrived yet. The caller should
//     leave its "decided" latch unset so the effect can fire again
//     once the list populates.
//   - "standdown" — something about the current workspace state
//     blocks resume (operator has a URL session, an active session,
//     existing turns, or a non-empty composer draft). The caller
//     should latch its "decided" flag so a later sessions-list
//     arrival doesn't retroactively yank the workspace.
//
// Why "draft" is a gate:
//   An operator can land on /chat, start typing before the async
//   /api/chat/sessions fetch resolves, and then have their draft
//   stranded under the wrong session context when the auto-resume
//   swaps turns + widgets out from under them. Gating on a
//   non-whitespace draft keeps the composer sacred: once the
//   operator has invested keystrokes, we don't move the workspace
//   they're drafting into.

export type ResumeDecisionInput = {
  sessions: ReadonlyArray<SessionListItem> | undefined | null;
  currentSessionId: string | null;
  turnCount: number;
  draft: string;
  hasUrlSession: boolean;
};

export type ResumeDecision =
  | { action: "resume"; sessionId: string }
  | { action: "wait" }
  | { action: "standdown" };

export function decideResumeAction(
  input: ResumeDecisionInput,
): ResumeDecision {
  // URL-hydrate is already handling this mount — stand down so we
  // don't fire a parallel hydrate that fights the URL one.
  if (input.hasUrlSession) return { action: "standdown" };

  // Active session id already set (operator picked, or a hydrate
  // already resolved). Resume is moot.
  if (input.currentSessionId !== null) return { action: "standdown" };

  // Turns populated means the operator already sent a message on
  // a fresh workspace — don't rewrite their in-progress session.
  if (input.turnCount > 0) return { action: "standdown" };

  // Composer draft in progress — blocking resume here is THE
  // race fix: if we resumed, `hydrateSession` would swap turns +
  // widgets but leave the `input` state untouched, stranding the
  // draft under a session context the operator did not pick.
  if (typeof input.draft === "string" && input.draft.trim().length > 0) {
    return { action: "standdown" };
  }

  // Sessions list not here yet — DO NOT stand down. The caller
  // should leave its decided-latch unset so this same decision
  // re-fires once the list populates. Distinguishing "wait" from
  // "standdown" is load-bearing: on a slow network the list
  // arrives after the initial render, and we need to pick it up.
  if (!Array.isArray(input.sessions) || input.sessions.length === 0) {
    return { action: "wait" };
  }

  const id = selectResumeSessionId(input.sessions);
  if (id) return { action: "resume", sessionId: id };

  // List present but every row is malformed. Stand down — we have
  // no valid id to resume, and "wait" would re-fire forever.
  return { action: "standdown" };
}

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
