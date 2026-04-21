// P16-E — pure UI helpers for the operator memory surface.
//
// This file is the SHAPE side of the operator memory page, the
// mirror of `@/lib/ai/memory-context.ts` for the chat recall
// path. Its job is to take already-fetched rows (with provenance
// relations included — see `listMemoriesForTeamsWithProvenance`
// in `./server`) and produce:
//
//   - a team-ordered grouping, matching the caller's teamId
//     sequence so the page can render in a predictable order
//     (non-admins: by membership order; admins: by team-name
//     order, whichever the caller chose);
//   - a single-line "provenance" string per memory for the
//     "Added by X · From session Y" affordance.
//
// Pure on purpose:
//   - unit-testable without DB setup;
//   - safe to import from server components OR (if a future
//     client-side memory widget lands) from client bundles too;
//   - keeps the display strings in ONE place so wording drift
//     doesn't fragment between the page and any future preview
//     / export / CSV surface.
//
// Stability contract: the functions here are stable-ordering by
// construction. A re-render with the same inputs yields the same
// outputs (including the order of entries in each team group).
// That makes snapshot / full-shape tests trivial and keeps the
// operator's scroll position meaningful across refreshes.

import type { MemoryWithProvenance } from "./server";

// Stable fallback when a teamId maps to no name (team deleted
// between the user's membership lookup and the memory page
// render). Matches the chat-recall renderer's label for
// cross-surface consistency — an operator eyeballing two UIs
// shouldn't see two different placeholders.
export const UNKNOWN_TEAM_LABEL_UI = "(team name unavailable)";

// Group memories by teamId, preserving the caller's teamId
// ORDER (not alphabetical, not by row count, not by newest
// memory). Teams with zero memories are dropped so the renderer
// doesn't emit empty sections; ordering of the surviving teams
// still matches the input. Per-team memory order is preserved
// exactly — the DB query already ordered by `updatedAt desc`,
// and this helper does not re-sort.
//
// Why preserve input order instead of alphabetising:
//   - For a non-admin, the natural order is their team-
//     membership order (which itself reflects join date in
//     `teamIdsForUser`) — their "home" team first.
//   - For an admin, the page can pass a name-sorted teamId list
//     to get alphabetical. The decision lives at the call site,
//     not here.
//   - A silent alpha-sort inside would surprise callers who
//     passed a deliberate order.
export function groupMemoriesByTeam(
  memories: readonly MemoryWithProvenance[],
  teamIdOrder: readonly string[],
): Array<{ teamId: string; memories: MemoryWithProvenance[] }> {
  if (!Array.isArray(memories) || memories.length === 0) return [];
  if (!Array.isArray(teamIdOrder) || teamIdOrder.length === 0) return [];
  const byTeam = new Map<string, MemoryWithProvenance[]>();
  for (const m of memories) {
    if (!m || typeof m !== "object" || typeof m.teamId !== "string") continue;
    const arr = byTeam.get(m.teamId) ?? [];
    arr.push(m);
    byTeam.set(m.teamId, arr);
  }
  const out: Array<{ teamId: string; memories: MemoryWithProvenance[] }> = [];
  for (const tid of teamIdOrder) {
    if (typeof tid !== "string" || tid.length === 0) continue;
    const arr = byTeam.get(tid);
    if (arr && arr.length > 0) {
      out.push({ teamId: tid, memories: arr });
    }
  }
  return out;
}

// Resolve a team name from the map the caller assembled. Fallback
// is stable and does NOT leak the teamId (matches the chat-
// recall renderer's contract — the teamId is a DB concern, not
// a human-facing identifier).
export function resolveTeamNameForUi(
  teamId: string,
  teamsById: ReadonlyMap<string, string | null>,
): string {
  const raw = teamsById.get(teamId);
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return UNKNOWN_TEAM_LABEL_UI;
}

// Produce the single-line provenance display for one memory.
// Shape:
//   "Added by <name-or-email> · From session <title-or-short-id>"
// Rules:
//   - `createdByUser`: prefer `fullName` when non-empty, fall
//     back to `email`, then to null (no "Added by" clause).
//   - `sourceSession`: prefer `title` when non-empty-after-trim,
//     fall back to the first 8 chars of the session id so the
//     operator still has something clickable/identifiable;
//     falls back to null (no "From session" clause) only if the
//     relation itself is null.
//   - With no info at all → returns `null`. The page renders
//     "No author recorded" in that branch; keeping null here
//     (instead of returning the placeholder string) lets the UI
//     style it differently (muted tone).
// Separator is " · " (middle dot with spaces) to match the rest
// of the admin UI (approvals uses the same separator between
// requester/count/time).
export function describeMemoryProvenance(
  memory: Pick<MemoryWithProvenance, "createdByUser" | "sourceSession">,
): string | null {
  if (!memory || typeof memory !== "object") return null;
  const parts: string[] = [];
  const u = memory.createdByUser;
  if (u && typeof u === "object") {
    const name =
      typeof u.fullName === "string" && u.fullName.trim().length > 0
        ? u.fullName.trim()
        : typeof u.email === "string" && u.email.trim().length > 0
          ? u.email.trim()
          : null;
    if (name) parts.push(`Added by ${name}`);
  }
  const s = memory.sourceSession;
  if (s && typeof s === "object") {
    const title =
      typeof s.title === "string" && s.title.trim().length > 0
        ? s.title.trim()
        : typeof s.id === "string" && s.id.length > 0
          ? s.id.slice(0, 8)
          : null;
    if (title) parts.push(`From session ${title}`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}
