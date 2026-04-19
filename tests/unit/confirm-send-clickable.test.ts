import { test } from "node:test";
import assert from "node:assert/strict";

import { isConfirmSendClickable } from "../../src/components/chat/directives/ConfirmSend";

// W5 regression — GPT audit on 3e95ce4 flagged that the ConfirmSend
// button's disabled predicate (`!canConfirm && state.phase !== "error"`)
// allowed the Retry POST even when blockers or a missing anchor would
// make the send doomed to refuse server-side. W5 made that worse: the
// server now persists `state: "error"` onto the widget row, so after a
// refused send the operator could reload and click Retry into a card
// that already has blockers present.
//
// The fix extracts a single `isConfirmSendClickable` predicate used
// both for the `disabled` attribute AND the button-style branch, so
// they can't drift. These tests pin the matrix so any future edit
// that loosens the predicate trips the suite.
//
// Regimes that MUST be clickable:
//   - idle + anchor + no blockers + ready_messages > 0
//   - error + anchor + no blockers
// Everything else is disabled.

test("idle — clickable only when anchor + no blockers + ready_messages > 0", () => {
  assert.equal(
    isConfirmSendClickable({
      phase: "idle",
      hasAnchor: true,
      hasBlockers: false,
      readyMessages: 5,
    }),
    true,
    "idle happy path should be clickable",
  );
  assert.equal(
    isConfirmSendClickable({
      phase: "idle",
      hasAnchor: false,
      hasBlockers: false,
      readyMessages: 5,
    }),
    false,
    "idle without anchor — button has nowhere to POST",
  );
  assert.equal(
    isConfirmSendClickable({
      phase: "idle",
      hasAnchor: true,
      hasBlockers: true,
      readyMessages: 5,
    }),
    false,
    "idle with blockers — must be gated client-side, server would refuse",
  );
  assert.equal(
    isConfirmSendClickable({
      phase: "idle",
      hasAnchor: true,
      hasBlockers: false,
      readyMessages: 0,
    }),
    false,
    "idle with zero ready messages — POST would be a pointless round-trip",
  );
});

test("error — clickable only when anchor + no blockers (no readyMessages floor)", () => {
  // Retry deliberately doesn't check readyMessages > 0. The server is
  // the authority on whether a send now has messages ready; the client
  // stays out of the way and lets the retry round-trip so a transient
  // outcome reconciles fast.
  assert.equal(
    isConfirmSendClickable({
      phase: "error",
      hasAnchor: true,
      hasBlockers: false,
      readyMessages: 0,
    }),
    true,
    "error + anchor + no blockers — retry is live even if readyMessages is stale",
  );
  assert.equal(
    isConfirmSendClickable({
      phase: "error",
      hasAnchor: true,
      hasBlockers: false,
      readyMessages: 5,
    }),
    true,
  );
  // THE regression GPT flagged. Pre-fix, this returned "clickable"
  // because the disabled predicate was `!canConfirm && phase !== "error"`.
  assert.equal(
    isConfirmSendClickable({
      phase: "error",
      hasAnchor: true,
      hasBlockers: true,
      readyMessages: 5,
    }),
    false,
    "error with blockers must NOT be clickable — GPT-flagged regression on 3e95ce4",
  );
  assert.equal(
    isConfirmSendClickable({
      phase: "error",
      hasAnchor: false,
      hasBlockers: false,
      readyMessages: 5,
    }),
    false,
    "error without anchor — still no POST target",
  );
});

test("sending / sent — never clickable regardless of other inputs", () => {
  // `sending` is the transient window during the client POST. A second
  // click would fire a duplicate request against a route whose atomic
  // single-use guard would refuse it, but the UI shouldn't invite the
  // click.
  assert.equal(
    isConfirmSendClickable({
      phase: "sending",
      hasAnchor: true,
      hasBlockers: false,
      readyMessages: 5,
    }),
    false,
  );
  // `sent` is the terminal success morph — the button is replaced by
  // the "Sent" pill, but pin the predicate anyway so a future refactor
  // that puts the button back can't accidentally resend.
  assert.equal(
    isConfirmSendClickable({
      phase: "sent",
      hasAnchor: true,
      hasBlockers: false,
      readyMessages: 5,
    }),
    false,
  );
});
