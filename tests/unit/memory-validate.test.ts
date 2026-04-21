import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_MEMORY_POLICY, type MemoryPolicy } from "../../src/lib/memory";
import {
  MEMORY_KINDS,
  validateMemoryWrite,
} from "../../src/lib/memory/validate";

// P16-B — pure write-seam validator for durable memory.
//
// Acceptance bar (per GPT's P16-B direction):
//   - validation of envelope + required fields
//   - `kind` gating (closed set; unknown kinds rejected)
//   - `maxBodyLength` enforcement (policy-driven)
//   - provenance fields pass through unchanged (teamId,
//     sourceSessionId, sourceMessageId, createdByUserId)
//
// Contract style: returns the canonical write shape on pass, or
// `null` on ANY failure. Same pattern as widget-validate /
// directive-validate — the validator doesn't throw, so callers
// can compose it without try/catch. The server-only write helper
// (`createMemoryForTeam` in @/lib/memory/server) throws on null
// because a null at the DB edge is a caller bug, not runtime
// state; those boundary tests would require a live Prisma, so
// they stay out of this pure unit suite.

const goodTeamId = "team-abc";
const goodBody = "operator prefers morning campaign sends";

test("validate: happy path — minimal input (teamId + body) defaults kind + nulls provenance", () => {
  const out = validateMemoryWrite({ teamId: goodTeamId, body: goodBody });
  assert.ok(out, "minimal valid input should pass");
  assert.equal(out.teamId, goodTeamId);
  assert.equal(out.body, goodBody);
  // Kind defaults to the policy's defaultKind, which must be a
  // member of MEMORY_KINDS (today: "fact"). The validator pins
  // this as the CANONICAL shape — downstream prisma.create
  // consumes the value verbatim.
  assert.equal(out.kind, DEFAULT_MEMORY_POLICY.defaultKind);
  assert.equal(out.sourceSessionId, null);
  assert.equal(out.sourceMessageId, null);
  assert.equal(out.createdByUserId, null);
});

test("validate: happy path — full input with all provenance set passes through", () => {
  const out = validateMemoryWrite({
    teamId: goodTeamId,
    body: goodBody,
    kind: "fact",
    sourceSessionId: "sess-123",
    sourceMessageId: "msg-456",
    createdByUserId: "user-789",
  });
  assert.ok(out);
  assert.equal(out.sourceSessionId, "sess-123");
  assert.equal(out.sourceMessageId, "msg-456");
  assert.equal(out.createdByUserId, "user-789");
});

test("validate: envelope — non-object inputs rejected", () => {
  // The validator's first move is a plain-object check. A string /
  // array / null / undefined / primitive is structurally wrong
  // and fails closed before any field-level check runs.
  assert.equal(validateMemoryWrite(null), null);
  assert.equal(validateMemoryWrite(undefined), null);
  assert.equal(validateMemoryWrite("string"), null);
  assert.equal(validateMemoryWrite(42), null);
  assert.equal(validateMemoryWrite([]), null);
  assert.equal(validateMemoryWrite([{ teamId: goodTeamId, body: goodBody }]), null);
});

test("validate: teamId — missing / empty / whitespace / non-string rejected", () => {
  // Mirrors the `buildMemoryListQuery` invariant: no silent
  // tenancy-less writes. A missing or whitespace-only teamId must
  // fail BEFORE the row reaches Prisma, so an invalid write can
  // never produce an untenanted row.
  assert.equal(validateMemoryWrite({ body: goodBody }), null);
  assert.equal(validateMemoryWrite({ teamId: "", body: goodBody }), null);
  assert.equal(validateMemoryWrite({ teamId: "   ", body: goodBody }), null);
  assert.equal(validateMemoryWrite({ teamId: 42, body: goodBody }), null);
  assert.equal(validateMemoryWrite({ teamId: null, body: goodBody }), null);
});

test("validate: body — missing / empty / whitespace / non-string rejected", () => {
  assert.equal(validateMemoryWrite({ teamId: goodTeamId }), null);
  assert.equal(validateMemoryWrite({ teamId: goodTeamId, body: "" }), null);
  assert.equal(validateMemoryWrite({ teamId: goodTeamId, body: "   " }), null);
  assert.equal(validateMemoryWrite({ teamId: goodTeamId, body: "\n\t " }), null);
  assert.equal(validateMemoryWrite({ teamId: goodTeamId, body: 42 }), null);
  assert.equal(validateMemoryWrite({ teamId: goodTeamId, body: null }), null);
});

test("validate: body — length cap is policy.maxBodyLength (default 1024)", () => {
  // At-cap passes; over-cap fails. The cap is on the RAW length so
  // a caller can't smuggle a long body by padding with whitespace.
  const atCap = "a".repeat(DEFAULT_MEMORY_POLICY.maxBodyLength);
  const overCap = "a".repeat(DEFAULT_MEMORY_POLICY.maxBodyLength + 1);

  const okOut = validateMemoryWrite({ teamId: goodTeamId, body: atCap });
  assert.ok(okOut, "body at exact cap length should pass");
  assert.equal(okOut.body.length, DEFAULT_MEMORY_POLICY.maxBodyLength);

  assert.equal(
    validateMemoryWrite({ teamId: goodTeamId, body: overCap }),
    null,
    "body one char over cap should fail",
  );
});

test("validate: body — custom policy maxBodyLength is honored end-to-end", () => {
  const custom: MemoryPolicy = {
    ...DEFAULT_MEMORY_POLICY,
    maxBodyLength: 10,
  };
  // Under custom cap: "abcdefghij" is 10 chars — at cap, passes.
  const ok = validateMemoryWrite(
    { teamId: goodTeamId, body: "abcdefghij" },
    custom,
  );
  assert.ok(ok);
  // Over custom cap: 11 chars — fails, even though it's far below
  // the DEFAULT cap of 1024. Pins that the custom policy threads
  // through the validator without being shadowed by defaults.
  assert.equal(
    validateMemoryWrite({ teamId: goodTeamId, body: "abcdefghijk" }, custom),
    null,
  );
});

test("validate: kind gating — only MEMORY_KINDS members accepted", () => {
  // Closed-set invariant: the validator refuses any string outside
  // the allowed kinds. Expanding the set is a one-line change in
  // validate.ts PLUS updating these tests — which forces the
  // change to be intentional.
  const ok = validateMemoryWrite({
    teamId: goodTeamId,
    body: goodBody,
    kind: "fact",
  });
  assert.ok(ok);
  assert.equal(ok.kind, "fact");

  // Unknown kinds rejected, not coerced.
  assert.equal(
    validateMemoryWrite({ teamId: goodTeamId, body: goodBody, kind: "preference" }),
    null,
    "kind outside MEMORY_KINDS must be rejected",
  );
  assert.equal(
    validateMemoryWrite({ teamId: goodTeamId, body: goodBody, kind: "random" }),
    null,
  );
  assert.equal(
    validateMemoryWrite({ teamId: goodTeamId, body: goodBody, kind: "" }),
    null,
    "empty string is not a valid kind",
  );

  // Non-string kinds rejected — a caller sending `kind: 42` (wrong
  // type) fails closed rather than being coerced.
  assert.equal(
    validateMemoryWrite({ teamId: goodTeamId, body: goodBody, kind: 42 }),
    null,
  );
  assert.equal(
    validateMemoryWrite({ teamId: goodTeamId, body: goodBody, kind: null }),
    null,
  );
});

test("validate: kind — omitted uses policy.defaultKind", () => {
  const out = validateMemoryWrite({ teamId: goodTeamId, body: goodBody });
  assert.ok(out);
  assert.equal(out.kind, DEFAULT_MEMORY_POLICY.defaultKind);

  // `kind: undefined` is treated as omitted (consistent with
  // widget-validate's `optional()` helper behavior).
  const out2 = validateMemoryWrite({
    teamId: goodTeamId,
    body: goodBody,
    kind: undefined,
  });
  assert.ok(out2);
  assert.equal(out2.kind, DEFAULT_MEMORY_POLICY.defaultKind);
});

test("validate: kind — misconfigured policy.defaultKind fails closed when kind omitted", () => {
  // If a future slice wires a policy whose defaultKind isn't in
  // MEMORY_KINDS (misconfiguration), the validator must NOT write
  // an unknown kind to the DB just because the policy said so.
  // It fails closed — the caller gets a null and has to notice.
  const broken: MemoryPolicy = {
    ...DEFAULT_MEMORY_POLICY,
    defaultKind: "totally-made-up-kind",
  };
  assert.equal(
    validateMemoryWrite({ teamId: goodTeamId, body: goodBody }, broken),
    null,
    "policy.defaultKind not in MEMORY_KINDS must fail closed on kind-omitted input",
  );
  // But if the caller supplies an EXPLICIT valid kind, the bogus
  // policy default doesn't matter — the explicit kind wins.
  const okWithExplicit = validateMemoryWrite(
    { teamId: goodTeamId, body: goodBody, kind: "fact" },
    broken,
  );
  assert.ok(okWithExplicit);
  assert.equal(okWithExplicit.kind, "fact");
});

test("validate: provenance — all three optional, default to null when absent", () => {
  const out = validateMemoryWrite({ teamId: goodTeamId, body: goodBody });
  assert.ok(out);
  // Canonical shape: absent provenance is `null`, not undefined.
  // Matches the Prisma schema's `String?` columns so downstream
  // create() consumes the shape verbatim.
  assert.equal(out.sourceSessionId, null);
  assert.equal(out.sourceMessageId, null);
  assert.equal(out.createdByUserId, null);
});

test("validate: provenance — undefined / null / empty-string all normalise to null", () => {
  const out = validateMemoryWrite({
    teamId: goodTeamId,
    body: goodBody,
    sourceSessionId: undefined,
    sourceMessageId: null,
    createdByUserId: "",
  });
  assert.ok(out);
  assert.equal(out.sourceSessionId, null, "undefined -> null");
  assert.equal(out.sourceMessageId, null, "null -> null");
  assert.equal(
    out.createdByUserId,
    null,
    'empty string -> null (an empty FK would trip Prisma\'s "record not found")',
  );
});

test("validate: provenance — non-empty strings pass through AS-IS (no trim, no mutation)", () => {
  // IDs are cuids. The validator does NOT trim or sanitise — a
  // caller passing a whitespace-padded id has a bug that should
  // fail loudly at the FK edge, not be silently scrubbed here.
  const padded = "  cuid-with-whitespace  ";
  const out = validateMemoryWrite({
    teamId: goodTeamId,
    body: goodBody,
    sourceSessionId: padded,
    sourceMessageId: "plain-cuid",
    createdByUserId: "another-cuid",
  });
  assert.ok(out);
  assert.equal(out.sourceSessionId, padded, "no trim on provenance IDs");
  assert.equal(out.sourceMessageId, "plain-cuid");
  assert.equal(out.createdByUserId, "another-cuid");
});

test("validate: provenance — non-string-or-null values rejected", () => {
  // A caller sending `sourceSessionId: 42` (wrong type) fails
  // closed rather than being coerced to "42" or dropped silently.
  assert.equal(
    validateMemoryWrite({
      teamId: goodTeamId,
      body: goodBody,
      sourceSessionId: 42,
    }),
    null,
  );
  assert.equal(
    validateMemoryWrite({
      teamId: goodTeamId,
      body: goodBody,
      sourceMessageId: { nested: "object" },
    }),
    null,
  );
  assert.equal(
    validateMemoryWrite({
      teamId: goodTeamId,
      body: goodBody,
      createdByUserId: ["array"],
    }),
    null,
  );
});

test("validate: 'validate, don't rewrite' — body with surrounding whitespace preserved", () => {
  // The validator REJECTS whitespace-only bodies but PRESERVES
  // surrounding whitespace on a real body. The raw bytes the
  // operator typed go to the DB; any display-layer trimming is
  // the caller's choice, not the validator's.
  const padded = "  real content with leading/trailing spaces  ";
  const out = validateMemoryWrite({ teamId: goodTeamId, body: padded });
  assert.ok(out);
  assert.equal(out.body, padded, "body stored verbatim, not trimmed");
});

test("MEMORY_KINDS: closed set is exactly ['fact'] in P16-B", () => {
  // Pinning the exact set. Widening in a future slice (P16-C
  // retrieval-by-kind, P16-D operator-surface forms, ...) is
  // intentional only when this test + the validator are updated
  // in the same commit. Prevents a silent drift where a caller
  // assumes "preference" works and the validator says otherwise.
  assert.deepEqual([...MEMORY_KINDS], ["fact"]);
  // And the default from DEFAULT_MEMORY_POLICY must be a member —
  // otherwise `validateMemoryWrite({ teamId, body })` (kind
  // omitted) would always fail closed even with the canonical
  // policy.
  assert.ok(
    (MEMORY_KINDS as readonly string[]).includes(DEFAULT_MEMORY_POLICY.defaultKind),
    "DEFAULT_MEMORY_POLICY.defaultKind must be a MemoryKind member",
  );
});
