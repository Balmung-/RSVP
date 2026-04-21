// P16-E.1 / P16-F — pure authorisation helper for the operator
// memory mutation actions (create, delete, and future in-place
// edits).
//
// Originally introduced as `decideMemoryDeleteAuth` in P16-E.1;
// P16-F renames it to `decideMemoryMutateAuth` because the
// decision tree is identical for any write-side mutation. The
// rename is intentional: a single helper means a future change
// to the governance rules (e.g. stricter role, extra axis) lands
// in one place and can't silently drift between create and
// delete. If create and delete ever need to diverge (e.g. admin-
// only hard-delete vs editor-wide create), that split lives in
// dedicated `decideMemory{Action}Auth` wrappers delegating to
// the same primitives — not by forking this file.
//
// Why a separate pure helper (not just a hasRole check at the
// callsite):
//   - The decision has TWO axes (role + membership) and two
//     distinct reject reasons ("not_editor" vs "not_member"). A
//     pure helper pins the decision tree in one place with unit
//     tests for each branch, rather than interleaving role + team
//     logic inline in each Server Action.
//   - The tenant-safety invariant — "mutation requires editor+
//     AND (admin OR team-member)" — is a single-line assertion
//     in the helper, which is easier to audit than tracing two
//     nested `if` branches in each page.
//   - Mirrors the `admin-query.ts` pattern from the P16-E slice:
//     shape/policy in a pure module, DB/IO at the edge.
//
// Inputs (booleans pre-computed by the caller via `hasRole`):
//   - `isEditor` — result of `hasRole(user, "editor")`, which is
//     true for BOTH editor and admin (ROLE_RANK in
//     `src/lib/auth.ts`).
//   - `isAdmin`  — result of `hasRole(user, "admin")`.
// Passing booleans (not a User object) keeps the helper
// completely pure — no Prisma / auth import needed in tests.
//
// Decision tree:
//   1. If !isEditor → reject "not_editor". Viewers must not
//      destructively govern durable memory even if they can see
//      it. This is the load-bearing check that P16-E.1 introduced
//      — the original P16-E slice permitted any team member to
//      delete, and now ALL mutations (delete + create) share the
//      same gate.
//   2. Else if isAdmin → allow (cross-team mutation is the
//      operator UI's raison d'être; the P16-E page already grants
//      admins cross-team READ, and mutation parity follows).
//   3. Else (editor, not admin) → must be a member of `teamId`.
//      - member → allow.
//      - not member → reject "not_member".
//
// Non-invariants:
//   - This helper does NOT check `id` (delete) or `body`
//     (create). Row existence and input validity are the DB /
//     validator's job. Returning "allow" here does NOT promise
//     the mutation will succeed.
//   - Cross-team admin writes are intentional, not oversight.

export type MemoryMutateAuthInput = {
  isEditor: boolean;
  isAdmin: boolean;
  teamId: string;
  memberTeamIds: readonly string[];
};

export type MemoryMutateAuthDecision =
  | { ok: true }
  | { ok: false; reason: "not_editor" | "not_member" };

export function decideMemoryMutateAuth(
  input: MemoryMutateAuthInput,
): MemoryMutateAuthDecision {
  // Defensive: a missing / malformed input object is treated as a
  // rejected viewer rather than a throw. The Server Action
  // callsites have their own form-data validation with flash
  // messages for the missing-field cases; this layer exists
  // purely to gate role + membership, and an object-shape bug
  // should NOT silently allow a mutation.
  if (!input || typeof input !== "object") {
    return { ok: false, reason: "not_editor" };
  }
  if (!input.isEditor) {
    return { ok: false, reason: "not_editor" };
  }
  if (input.isAdmin) {
    return { ok: true };
  }
  // Editor, not admin — require membership. An empty teamId or
  // a non-array memberTeamIds reduces to "not a member". The
  // upstream page code rejects empty teamIds earlier with a flash,
  // so the only way to reach this branch with teamId === "" is an
  // unexpected caller — fail closed.
  const teamId = typeof input.teamId === "string" ? input.teamId : "";
  if (teamId.length === 0) {
    return { ok: false, reason: "not_member" };
  }
  if (!Array.isArray(input.memberTeamIds)) {
    return { ok: false, reason: "not_member" };
  }
  if (input.memberTeamIds.includes(teamId)) {
    return { ok: true };
  }
  return { ok: false, reason: "not_member" };
}
