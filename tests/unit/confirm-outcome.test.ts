import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyOutcome } from "../../src/lib/ai/confirm-classify";
import type { DispatchResult } from "../../src/lib/ai/tools/types";

// Guards the Push 7 fix: a structured refusal from a handler (e.g.
// `return {output: {error: "status_not_sendable", ...}}`) comes back
// under `dispatch.ok === true`. Naively routing on `result.ok` lands
// a refusal in the "Sent" UI state and audits it as `ok: true` — a
// lie on both surfaces. classifyOutcome flips the effective outcome
// to failure when the handler's output carries an `error` string,
// while keeping real successes real.
//
// Three canonical cases the confirm route must handle:
//   1. Real success — handler output has no `error` field.
//   2. Structured refusal — handler returned ok but output has
//      `error: "<code>"`. UI, HTTP, and audit must treat as failure.
//   3. Dispatch failure — dispatch itself returned ok:false (unknown
//      tool, invalid input, handler throw). Surface the raw string.
//
// Plus: shouldReleaseClaim only fires on a structured refusal that
// is in the releasable whitelist — never on a dispatch throw
// (handler_error:*), and never on a success.

test("classifyOutcome: real success preserves ok + exposes output + summary", () => {
  const result: DispatchResult = {
    ok: true,
    result: {
      output: { summary: "Sent 3: 2 email, 1 sms", sent: 3 },
    },
  };
  const c = classifyOutcome(result);
  assert.equal(c.effectiveOk, true);
  assert.equal(c.structuredError, null);
  assert.equal(c.dispatchError, null);
  assert.equal(c.effectiveError, null);
  assert.equal(c.shouldReleaseClaim, false);
  assert.equal(c.handlerSummary, "Sent 3: 2 email, 1 sms");
  assert.deepEqual(c.output, { summary: "Sent 3: 2 email, 1 sms", sent: 3 });
});

test("classifyOutcome: structured refusal flips effectiveOk to false", () => {
  const result: DispatchResult = {
    ok: true,
    result: {
      output: {
        error: "status_not_sendable",
        summary: "Campaign must be active to send.",
      },
    },
  };
  const c = classifyOutcome(result);
  assert.equal(c.effectiveOk, false);
  assert.equal(c.structuredError, "status_not_sendable");
  assert.equal(c.dispatchError, null);
  assert.equal(c.effectiveError, "status_not_sendable");
  assert.equal(c.shouldReleaseClaim, true);
  assert.equal(c.handlerSummary, "Campaign must be active to send.");
});

test("classifyOutcome: dispatch failure surfaces as effectiveError and keeps claim", () => {
  const result: DispatchResult = {
    ok: false,
    error: "handler_error:Error: boom",
  };
  const c = classifyOutcome(result);
  assert.equal(c.effectiveOk, false);
  assert.equal(c.structuredError, null);
  assert.equal(c.dispatchError, "handler_error:Error: boom");
  assert.equal(c.effectiveError, "handler_error:Error: boom");
  // Crucial: a dispatch throw MUST NOT release the claim — the throw
  // could have happened inside sendCampaign's fan-out with partial
  // state. Retrying would double-send.
  assert.equal(c.shouldReleaseClaim, false);
  assert.equal(c.handlerSummary, null);
  assert.equal(c.output, null);
});

test("classifyOutcome: structured refusal with non-releasable code keeps claim", () => {
  // A hypothetical refusal code not in RELEASABLE_REFUSALS — must
  // still flip to failure, but the claim stays held so a retry
  // cannot re-enter send fan-out.
  const result: DispatchResult = {
    ok: true,
    result: { output: { error: "unexpected_future_code" } },
  };
  const c = classifyOutcome(result);
  assert.equal(c.effectiveOk, false);
  assert.equal(c.structuredError, "unexpected_future_code");
  assert.equal(c.effectiveError, "unexpected_future_code");
  assert.equal(c.shouldReleaseClaim, false);
});

test("classifyOutcome: output that is a plain string is not treated as a refusal", () => {
  // Read tools sometimes return `output: "some text"` — that has
  // no `error` field and must register as success.
  const result: DispatchResult = {
    ok: true,
    result: { output: "plain text summary" },
  };
  const c = classifyOutcome(result);
  assert.equal(c.effectiveOk, true);
  assert.equal(c.structuredError, null);
  assert.equal(c.handlerSummary, null);
  assert.equal(c.output, "plain text summary");
});
