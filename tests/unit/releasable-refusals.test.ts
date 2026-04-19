import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RELEASABLE_REFUSALS,
  isReleasableRefusal,
} from "../../src/lib/ai/confirm-classify";

// Guards the releasable-refusals whitelist. These eight codes — and
// only these — represent send_campaign handler refusals that
// happened BEFORE sendCampaign()'s per-invitee fan-out began, so
// releasing the single-use claim is safe: a retry cannot double-
// send because nothing sent the first time. Any other error
// (including uncaught dispatch throws surfaced as `handler_error:*`)
// could have left partial state and MUST keep the claim held.
//
// Two sources must stay in sync with this list:
//   - `src/lib/ai/tools/send_campaign.ts` preflight guards:
//     forbidden, not_found, status_not_sendable, send_in_flight
//   - `src/lib/ai/tools/send-blockers.ts::computeBlockers` codes
//     that send_campaign re-enforces at confirm time: no_invitees,
//     no_ready_messages, no_email_template, no_sms_template
//
// If someone adds a new blocker to computeBlockers or a new
// preflight refusal to send_campaign, they must consciously decide
// whether it's releasable and update both this set and, if
// releasable, add it here. That's the whole point of the pin.

const EXPECTED_RELEASABLE = [
  "forbidden",
  "not_found",
  "status_not_sendable",
  "send_in_flight",
  "no_invitees",
  "no_ready_messages",
  "no_email_template",
  "no_sms_template",
] as const;

test("RELEASABLE_REFUSALS matches the pinned whitelist exactly", () => {
  // Size pin first — catches silent additions that bypass review.
  assert.equal(
    RELEASABLE_REFUSALS.size,
    EXPECTED_RELEASABLE.length,
    `RELEASABLE_REFUSALS size drifted — added a new blocker? review whether it should release the claim, then update this test and the constant together`,
  );
  for (const code of EXPECTED_RELEASABLE) {
    assert.ok(
      RELEASABLE_REFUSALS.has(code),
      `RELEASABLE_REFUSALS missing expected code: ${code}`,
    );
  }
});

test("isReleasableRefusal recognises every whitelisted code", () => {
  for (const code of EXPECTED_RELEASABLE) {
    assert.equal(
      isReleasableRefusal(code),
      true,
      `expected ${code} to be releasable`,
    );
  }
});

test("isReleasableRefusal rejects dispatch-throw strings", () => {
  // Dispatch-layer throws surface as `handler_error:*` strings. Even
  // though they look refusal-shaped, they MUST NOT release the claim
  // because the throw could have been mid-fan-out.
  assert.equal(isReleasableRefusal("handler_error:Error: boom"), false);
  assert.equal(isReleasableRefusal("unknown_tool:foo"), false);
  assert.equal(isReleasableRefusal("invalid_input:expected_object"), false);
  assert.equal(isReleasableRefusal("needs_confirmation"), false);
});

test("isReleasableRefusal is null/undefined-safe", () => {
  assert.equal(isReleasableRefusal(null), false);
  assert.equal(isReleasableRefusal(undefined), false);
  assert.equal(isReleasableRefusal(""), false);
});

test("isReleasableRefusal rejects an arbitrary unknown code", () => {
  assert.equal(isReleasableRefusal("some_future_error"), false);
});
