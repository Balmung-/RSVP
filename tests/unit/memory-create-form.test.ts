import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCreateMemoryForm } from "../../src/lib/memory/form";
import type { MemoryPolicy } from "../../src/lib/memory/policy";

// P16-F — pure parser for the operator memory create form.
//
// Pins the field-level error reporting contract the Server Action
// relies on for per-reason flash messages, plus the canonical
// `MemoryWriteInput` shape produced on success. The helper is
// the one thin wrapper between FormData and `createMemoryForTeam`
// — any drift here shows up as either a worse flash-message UX
// (silent fall-through of a bad field) or a silent DB reshape
// (e.g. body trimmed unexpectedly).
//
// Invariants:
//   - missing teamId / empty body / oversized body return distinct
//     tagged-union reasons, not the validator's bare `null`;
//   - a successful parse ALWAYS returns a shape that will pass
//     `validateMemoryWrite` (teamId trimmed, body non-empty,
//     length within cap, kind = "fact", provenance nulls);
//   - body is stored AS-IS (no trim) to match
//     "validate, don't rewrite" from the validator;
//   - teamId IS trimmed because cuids never contain whitespace;
//   - provenance fields `sourceSessionId` / `sourceMessageId` are
//     ALWAYS null here — form writes have no chat context.
//
// Non-invariants (deliberately not pinned):
//   - Specific copy for the flash message; lives in the Server
//     Action, not this pure layer.
//   - Interaction with the validator beyond shape compatibility.
//     The validator has its own test file; this one only pins
//     the hand-off contract.

// ---- happy path ----------------------------------------------

test("parseCreateMemoryForm: happy path — canonical shape on pass", () => {
  const r = parseCreateMemoryForm({
    rawTeamId: "team-a",
    rawBody: "VIP list is frozen for the Eid campaign",
    createdByUserId: "user-1",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.input, {
    teamId: "team-a",
    body: "VIP list is frozen for the Eid campaign",
    kind: "fact",
    sourceSessionId: null,
    sourceMessageId: null,
    createdByUserId: "user-1",
  });
});

test("parseCreateMemoryForm: kind is hard-coded to 'fact' (no override via args)", () => {
  // Defensive: the form doesn't expose a kind selector; passing
  // one through args is a bug that must NOT widen the kind set.
  // If this test regresses, a silent drift is possible (tool
  // accidentally sets kind via form data and bypasses the
  // MEMORY_KINDS closed set).
  // The cast launders the unexpected `rawKind` field past TS —
  // the parser's own signature doesn't accept it, but if a caller
  // bypasses TS (e.g. plain JS tests, or an untyped FormData
  // caller), the extra field must silently fall through to the
  // hard-coded "fact".
  const r = parseCreateMemoryForm({
    rawTeamId: "team-a",
    rawBody: "body",
    createdByUserId: "user-1",
    rawKind: "preference",
  } as unknown as Parameters<typeof parseCreateMemoryForm>[0]);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.input.kind, "fact");
});

test("parseCreateMemoryForm: trims teamId (CUIDs don't have whitespace)", () => {
  const r = parseCreateMemoryForm({
    rawTeamId: "  team-a  ",
    rawBody: "body",
    createdByUserId: "user-1",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.input.teamId, "team-a");
});

test("parseCreateMemoryForm: does NOT trim body (validate, don't rewrite)", () => {
  // The validator stores the body as-is. If the form helper
  // silently trimmed, the DB would have the trimmed version
  // but the validator has a pin that storage is not rewritten —
  // a future export surface would disagree with the operator's
  // intent.
  const r = parseCreateMemoryForm({
    rawTeamId: "team-a",
    rawBody: "  VIP list  ",
    createdByUserId: "user-1",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.input.body, "  VIP list  ");
});

test("parseCreateMemoryForm: provenance source fields are always null", () => {
  // Form writes never carry chat provenance; those fields are for
  // a future `remember_fact` tool. Drift here would let a bad
  // tool leak non-chat writes with fake session ids.
  const r = parseCreateMemoryForm({
    rawTeamId: "team-a",
    rawBody: "body",
    createdByUserId: "user-1",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.input.sourceSessionId, null);
  assert.equal(r.input.sourceMessageId, null);
});

test("parseCreateMemoryForm: createdByUserId empty string normalised to null", () => {
  // Matches the validator's provenance normalisation: empty
  // string becomes null (Prisma FK can't be an empty string, and
  // we shouldn't silently save a dangling attribution).
  const r = parseCreateMemoryForm({
    rawTeamId: "team-a",
    rawBody: "body",
    createdByUserId: "",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.input.createdByUserId, null);
});

// ---- missing team --------------------------------------------

test("parseCreateMemoryForm: missing teamId returns 'missing_team'", () => {
  const r = parseCreateMemoryForm({
    rawTeamId: "",
    rawBody: "body",
    createdByUserId: "user-1",
  });
  assert.deepEqual(r, { ok: false, reason: "missing_team" });
});

test("parseCreateMemoryForm: whitespace-only teamId returns 'missing_team'", () => {
  const r = parseCreateMemoryForm({
    rawTeamId: "   ",
    rawBody: "body",
    createdByUserId: "user-1",
  });
  assert.deepEqual(r, { ok: false, reason: "missing_team" });
});

test("parseCreateMemoryForm: non-string teamId returns 'missing_team'", () => {
  const r = parseCreateMemoryForm({
    rawTeamId: 42 as unknown as string,
    rawBody: "body",
    createdByUserId: "user-1",
  });
  assert.deepEqual(r, { ok: false, reason: "missing_team" });
});

// ---- missing body --------------------------------------------

test("parseCreateMemoryForm: missing body returns 'missing_body'", () => {
  const r = parseCreateMemoryForm({
    rawTeamId: "team-a",
    rawBody: "",
    createdByUserId: "user-1",
  });
  assert.deepEqual(r, { ok: false, reason: "missing_body" });
});

test("parseCreateMemoryForm: whitespace-only body returns 'missing_body'", () => {
  // Operator hits save on a blank textarea that got auto-filled
  // with a space. The trim check catches this rather than
  // silently saving a whitespace memory.
  const r = parseCreateMemoryForm({
    rawTeamId: "team-a",
    rawBody: "   \n  \t ",
    createdByUserId: "user-1",
  });
  assert.deepEqual(r, { ok: false, reason: "missing_body" });
});

test("parseCreateMemoryForm: non-string body returns 'missing_body'", () => {
  const r = parseCreateMemoryForm({
    rawTeamId: "team-a",
    rawBody: null as unknown as string,
    createdByUserId: "user-1",
  });
  assert.deepEqual(r, { ok: false, reason: "missing_body" });
});

// ---- body too long -------------------------------------------

test("parseCreateMemoryForm: oversized body returns 'body_too_long'", () => {
  const r = parseCreateMemoryForm({
    rawTeamId: "team-a",
    rawBody: "a".repeat(1025), // DEFAULT_MEMORY_POLICY.maxBodyLength = 1024
    createdByUserId: "user-1",
  });
  assert.deepEqual(r, { ok: false, reason: "body_too_long" });
});

test("parseCreateMemoryForm: body at exactly maxBodyLength passes", () => {
  // Boundary pin: 1024-char body is accepted; 1025 is rejected.
  const r = parseCreateMemoryForm({
    rawTeamId: "team-a",
    rawBody: "a".repeat(1024),
    createdByUserId: "user-1",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.input.body.length, 1024);
});

test("parseCreateMemoryForm: length check uses RAW bytes, not trimmed", () => {
  // A 1025-char body of whitespace-padded content (say 1020 chars
  // of real content plus 5 chars of leading/trailing whitespace)
  // must be rejected, not silently trimmed + accepted. This
  // mirrors the validator's raw-length check.
  const padded = "  " + "a".repeat(1020) + "   "; // 1025 chars
  const r = parseCreateMemoryForm({
    rawTeamId: "team-a",
    rawBody: padded,
    createdByUserId: "user-1",
  });
  assert.deepEqual(r, { ok: false, reason: "body_too_long" });
});

test("parseCreateMemoryForm: custom policy override applies", () => {
  // A test / future slice can pass a tighter policy for, e.g.,
  // a premium-tier team cap. Passing through proves the knob.
  const tightPolicy: MemoryPolicy = {
    defaultKind: "fact",
    listDefaultLimit: 50,
    listMaxLimit: 500,
    recallDefaultLimit: 12,
    recallMaxLimit: 50,
    recallScanMaxLimit: 200,
    maxBodyLength: 10,
    adminListMaxLimit: 500,
  };
  const r = parseCreateMemoryForm({
    rawTeamId: "team-a",
    rawBody: "this is definitely longer than ten chars",
    createdByUserId: "user-1",
    policy: tightPolicy,
  });
  assert.deepEqual(r, { ok: false, reason: "body_too_long" });
});

// ---- reason precedence ---------------------------------------

test("parseCreateMemoryForm: 'missing_team' takes precedence over 'missing_body'", () => {
  // Both fields empty — team check runs first (mirrors the order
  // an operator fills the form: team selector is at the top).
  // Drift here would surface a less-helpful flash ("body
  // required" when the real issue is "no team selected").
  const r = parseCreateMemoryForm({
    rawTeamId: "",
    rawBody: "",
    createdByUserId: "user-1",
  });
  assert.deepEqual(r, { ok: false, reason: "missing_team" });
});

test("parseCreateMemoryForm: 'missing_body' takes precedence over 'body_too_long'", () => {
  // Pathological: whitespace-only body of 2000 chars. Both the
  // missing-body AND body-too-long checks would match; the
  // missing-body reason wins because it's the more actionable
  // hint ("actually type something").
  const r = parseCreateMemoryForm({
    rawTeamId: "team-a",
    rawBody: " ".repeat(2000),
    createdByUserId: "user-1",
  });
  assert.deepEqual(r, { ok: false, reason: "missing_body" });
});

// ---- defensive -----------------------------------------------

test("parseCreateMemoryForm: null/undefined args fail-closed as 'missing_team'", () => {
  assert.deepEqual(
    parseCreateMemoryForm(null as unknown as Parameters<typeof parseCreateMemoryForm>[0]),
    { ok: false, reason: "missing_team" },
  );
  assert.deepEqual(
    parseCreateMemoryForm(undefined as unknown as Parameters<typeof parseCreateMemoryForm>[0]),
    { ok: false, reason: "missing_team" },
  );
});
