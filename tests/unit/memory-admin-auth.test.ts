import { test } from "node:test";
import assert from "node:assert/strict";

import { decideMemoryMutateAuth } from "../../src/lib/memory/admin-auth";

// P16-E.1 / P16-F — pure authorisation decision for operator
// memory MUTATIONS (create, delete, and any future in-place
// edits). The helper was introduced in P16-E.1 as
// `decideMemoryDeleteAuth`; P16-F renamed it to
// `decideMemoryMutateAuth` because the decision tree is identical
// across write-side actions. Both the `/memories` create form and
// its delete form route through this gate.
//
// This is the load-bearing gate the P16-E.1 audit installed. The
// original P16-E slice shipped with delete available to any team
// member; viewers-on-team could destructively govern durable
// model-steering context. The pins below enforce the tightened
// contract, and P16-F extends the same contract to create.
//
// Invariants pinned here:
//   - VIEWER is rejected with exactly "not_editor". No path
//     through the tree allows a viewer to mutate, even if they're
//     a team member.
//   - ADMIN is allowed cross-team (does NOT require membership).
//     Matches the P16-E page's cross-team admin READ posture —
//     the operator UI's role is to let admins govern across all
//     teams.
//   - EDITOR requires membership. A user with editor role on one
//     team must not mutate memory on a team they don't belong to.
//   - Reject reason strings are exact ("not_editor" / "not_member")
//     so each Server Action's flash-message branch stays in sync
//     with the decision layer.
//
// Non-invariants:
//   - The helper does not consult `id` (delete) or `body` (create).
//     Row existence / input validity are DB / validator concerns.
//   - The helper does not distinguish admin-with-membership from
//     admin-without — admins are always allowed, so the
//     membership list is irrelevant on the admin branch.

test("decideMemoryMutateAuth: viewer is rejected with 'not_editor'", () => {
  // Viewer in the team (membership listed) must STILL be
  // rejected. The audit fix hinges on this case: previously the
  // upstream code permitted delete on membership alone.
  const d = decideMemoryMutateAuth({
    isEditor: false,
    isAdmin: false,
    teamId: "team-a",
    memberTeamIds: ["team-a"],
  });
  assert.deepEqual(d, { ok: false, reason: "not_editor" });
});

test("decideMemoryMutateAuth: viewer rejected even with empty membership", () => {
  // Defense: the "role check happens first" ordering matters —
  // we must reject "not_editor" (the fix) rather than fall
  // through to "not_member" (which would obscure the real reason
  // in logs / flash copy).
  const d = decideMemoryMutateAuth({
    isEditor: false,
    isAdmin: false,
    teamId: "team-a",
    memberTeamIds: [],
  });
  assert.deepEqual(d, { ok: false, reason: "not_editor" });
});

test("decideMemoryMutateAuth: admin is allowed cross-team (no membership required)", () => {
  // The operator UI grants admins cross-team READ in P16-E; the
  // delete parity follows. If this ever regresses, an admin
  // cleaning up an abandoned team's stale memory would be blocked.
  const d = decideMemoryMutateAuth({
    isEditor: true,
    isAdmin: true,
    teamId: "team-somewhere-else",
    memberTeamIds: [],
  });
  assert.deepEqual(d, { ok: true });
});

test("decideMemoryMutateAuth: admin is allowed regardless of membership list contents", () => {
  // Parity with the case above — explicit pin that a populated
  // `memberTeamIds` that happens NOT to include `teamId` still
  // resolves to allow on the admin branch.
  const d = decideMemoryMutateAuth({
    isEditor: true,
    isAdmin: true,
    teamId: "team-z",
    memberTeamIds: ["team-a", "team-b"],
  });
  assert.deepEqual(d, { ok: true });
});

test("decideMemoryMutateAuth: editor in the team is allowed", () => {
  // The normal editor flow: scoped to their team, destructively
  // edits governance data there.
  const d = decideMemoryMutateAuth({
    isEditor: true,
    isAdmin: false,
    teamId: "team-a",
    memberTeamIds: ["team-a", "team-b"],
  });
  assert.deepEqual(d, { ok: true });
});

test("decideMemoryMutateAuth: editor NOT in the team is rejected with 'not_member'", () => {
  // An editor on team-a must not be able to delete memory on
  // team-b. This would otherwise be a cross-tenant write.
  const d = decideMemoryMutateAuth({
    isEditor: true,
    isAdmin: false,
    teamId: "team-b",
    memberTeamIds: ["team-a"],
  });
  assert.deepEqual(d, { ok: false, reason: "not_member" });
});

test("decideMemoryMutateAuth: editor with empty membership is rejected with 'not_member'", () => {
  // Pathological: a user whose memberships got cleared mid-
  // session. The teamId can't be found, so we reject as
  // "not_member" (consistent with the editor branch's normal
  // rejection reason).
  const d = decideMemoryMutateAuth({
    isEditor: true,
    isAdmin: false,
    teamId: "team-a",
    memberTeamIds: [],
  });
  assert.deepEqual(d, { ok: false, reason: "not_member" });
});

test("decideMemoryMutateAuth: editor with empty teamId is rejected with 'not_member'", () => {
  // Defensive: an empty teamId reaching this layer is an upstream
  // bug (page code flashes + redirects earlier). The helper fails
  // closed as "not_member" rather than throwing or silently
  // allowing.
  const d = decideMemoryMutateAuth({
    isEditor: true,
    isAdmin: false,
    teamId: "",
    memberTeamIds: ["team-a"],
  });
  assert.deepEqual(d, { ok: false, reason: "not_member" });
});

test("decideMemoryMutateAuth: editor with non-array memberTeamIds is rejected with 'not_member'", () => {
  // Shape defence: if the caller somehow passes a non-array
  // (e.g. a Promise.all that resolved to undefined), we reject
  // rather than throw on `.includes(...)`.
  const d = decideMemoryMutateAuth({
    isEditor: true,
    isAdmin: false,
    teamId: "team-a",
    memberTeamIds: null as unknown as readonly string[],
  });
  assert.deepEqual(d, { ok: false, reason: "not_member" });
});

test("decideMemoryMutateAuth: malformed input rejects as 'not_editor' (fail-closed)", () => {
  // A null / undefined / non-object input means some upstream
  // refactor has broken the contract. Fail closed as
  // "not_editor" — the strictest reject — so it can't be
  // interpreted as an allow.
  assert.deepEqual(
    decideMemoryMutateAuth(null as unknown as Parameters<typeof decideMemoryMutateAuth>[0]),
    { ok: false, reason: "not_editor" },
  );
  assert.deepEqual(
    decideMemoryMutateAuth(undefined as unknown as Parameters<typeof decideMemoryMutateAuth>[0]),
    { ok: false, reason: "not_editor" },
  );
});

test("decideMemoryMutateAuth: role check precedes membership check (ordering pin)", () => {
  // Explicit: a viewer in the team must get "not_editor", NOT
  // "not_member". This pins the evaluation order so a future
  // refactor doesn't flip the branches and fragment the reject
  // reason (which is also the flash message the user sees).
  const d = decideMemoryMutateAuth({
    isEditor: false,
    isAdmin: false,
    teamId: "team-a",
    memberTeamIds: ["team-a"],
  });
  assert.equal(d.ok, false);
  if (!d.ok) {
    assert.equal(d.reason, "not_editor");
  }
});
