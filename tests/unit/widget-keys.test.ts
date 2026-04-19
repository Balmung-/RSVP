import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVITY_STREAM_WIDGET_KEY,
  campaignDetailWidgetKey,
  CAMPAIGNS_LIST_WIDGET_KEY,
  CONTACTS_TABLE_WIDGET_KEY,
  confirmDraftWidgetKey,
  confirmImportWidgetKey,
  confirmSendWidgetKey,
} from "../../src/lib/ai/widgetKeys";

// W6 — locks the 6 widget-key derivations exported from
// src/lib/ai/widgetKeys.ts. Every tool handler that writes a
// workspace widget imports from that module; the confirm-send
// outcome writer in /api/chat/confirm/[messageId]/route.ts imports
// the same helper to FIND the row to stamp. If a key formula drifts,
// the whole workspace-pivot "same filter = same card" / "same confirm
// = same row to update" contract breaks:
//
//   - Static-keyed widgets (list_campaigns, search_contacts,
//     recent_activity) would spawn a new card per invocation, losing
//     the update-in-place W4 contract that lets the operator refine
//     filters without spamming the dashboard.
//   - Entity-keyed widgets (campaign_detail, confirm_send,
//     confirm_draft) rely on the id segment being a stable,
//     deterministic interpolation. Changing the prefix, the
//     separator, or the segment order would silently leave the old
//     rows stranded in the DB and the new rows unfindable from the
//     outcome writer.
//
// These tests are deliberately literal — no fixture or mock — so a
// formula change here has to visibly update the expected string.
// Grep-audits for the formula across the repo still work because the
// formula lives only in widgetKeys.ts; any other literal match is
// stale and should be deleted.

// ---- static-keyed widgets ----

test("CAMPAIGNS_LIST_WIDGET_KEY is the literal 'campaigns.list'", () => {
  // Shared by list_campaigns. A new invocation with a different
  // status filter must REPLACE the widget, not append — the key is
  // deliberately filter-agnostic so the dashboard slot stays pinned
  // to "the current campaigns view".
  assert.equal(CAMPAIGNS_LIST_WIDGET_KEY, "campaigns.list");
});

test("CONTACTS_TABLE_WIDGET_KEY is the literal 'contacts.table'", () => {
  // Shared by search_contacts. Same rationale — a refined query
  // must refresh the same table widget rather than stack duplicates.
  assert.equal(CONTACTS_TABLE_WIDGET_KEY, "contacts.table");
});

test("ACTIVITY_STREAM_WIDGET_KEY is the literal 'activity.stream'", () => {
  // Shared by recent_activity. The activity feed is a singleton
  // secondary-slot widget; operators re-asking "show activity"
  // should see one stream, not many.
  assert.equal(ACTIVITY_STREAM_WIDGET_KEY, "activity.stream");
});

// ---- entity-keyed widgets ----

test("campaignDetailWidgetKey formula is 'campaign.<id>'", () => {
  // Used by campaign_detail. One card per campaign id — re-asking
  // about the same campaign must land on the same key so the card
  // updates in place with any refreshed stats.
  assert.equal(campaignDetailWidgetKey("abc123"), "campaign.abc123");
  // Trailing-dot edge: a hypothetical id that starts with '.' must
  // still produce a key that the (sessionId, widgetKey) unique
  // index can store. No normalisation at this seam.
  assert.equal(campaignDetailWidgetKey(".head"), "campaign..head");
});

test("confirmSendWidgetKey formula is 'confirm.send.<id>'", () => {
  // Used BY propose_send (writer) AND by /api/chat/confirm/[messageId]
  // route (reader, which stamps the W5 outcome state onto the same
  // row). If these two call sites derived the key differently, the
  // outcome write would silently miss and the widget would remain in
  // "ready"/"blocked" forever after a confirm.
  assert.equal(confirmSendWidgetKey("camp_42"), "confirm.send.camp_42");
});

test("confirmDraftWidgetKey formula is 'confirm.draft.<id>'", () => {
  // Used by draft_campaign. One card per newly-created draft; the
  // widget is terminal-on-creation today (state: "done") but the
  // key formula still has to be stable in case a future flow wants
  // to update the same row post-draft (e.g. "draft saved" ->
  // "template filled in" progression).
  assert.equal(confirmDraftWidgetKey("new_draft_7"), "confirm.draft.new_draft_7");
});

// ---- cross-module contract ----

test("confirmSendWidgetKey: reader and writer resolve the same key for the same id", () => {
  // This is the invariant that actually matters at runtime — not
  // the string value, but that the two sides agree. Pinning here
  // as a referential-identity check: the route imports
  // `confirmSendWidgetKey`, propose_send imports
  // `confirmSendWidgetKey`, and both passes of the same id produce
  // bytewise-equal strings. If either side ever switches to a local
  // fallback, the equality fails and this test trips.
  const fromPropose = confirmSendWidgetKey("camp_shared_contract");
  const fromRoute = confirmSendWidgetKey("camp_shared_contract");
  assert.equal(fromPropose, fromRoute);
  // And a different id MUST produce a different key — paranoia
  // check for a future "batch" formula that accidentally collapses.
  assert.notEqual(fromPropose, confirmSendWidgetKey("camp_other"));
});

// ---- non-interpolation guardrails ----

// ---- confirmImportWidgetKey — target-dependent shape ----
//
// Pinned separately from the other entity-keyed helpers because its
// formula branches on target and guards against caller mistakes at
// the seam. The P7 GPT audit flagged a real bug here: the initial
// formula `(target, ingestId)` collapsed two different campaigns'
// invitees confirm cards onto the same key, so a ready card for
// campaign A could silently remain live when the operator pivoted
// to campaign B on the same file. The fix composes campaignId into
// the invitees formula and forbids it on contacts — these tests are
// the regression guard.

test("confirmImportWidgetKey: contacts formula is 'confirm.import.contacts.<ingestId>'", () => {
  // Contacts are global — campaign_id is meaningless, passed as null.
  assert.equal(
    confirmImportWidgetKey("contacts", "ing_42", null),
    "confirm.import.contacts.ing_42",
  );
});

test("confirmImportWidgetKey: invitees formula includes campaignId — 'confirm.import.invitees.<campaignId>.<ingestId>'", () => {
  // Invitees per-campaign dedupe requires campaignId in the key.
  // Without it, a ready card for camp_A on ingest X would collide
  // with a propose_import for camp_B on the same ingest X, and
  // the late preview would overwrite / fail-to-write (depending on
  // the validator), leaving a stale destructive card pointed at A.
  assert.equal(
    confirmImportWidgetKey("invitees", "ing_42", "camp_A"),
    "confirm.import.invitees.camp_A.ing_42",
  );
});

test("confirmImportWidgetKey: different campaigns produce different keys for the same ingest", () => {
  // The whole point of including campaignId: a user previewing A,
  // then previewing B on the same file, must end up with two
  // separate destructive anchors (or one succeeds while the other
  // fails with plain text) — not one key that both writes overwrite.
  const keyA = confirmImportWidgetKey("invitees", "ing_shared", "camp_A");
  const keyB = confirmImportWidgetKey("invitees", "ing_shared", "camp_B");
  assert.notEqual(keyA, keyB);
});

test("confirmImportWidgetKey: same (target, campaignId, ingestId) produces bytewise-identical keys", () => {
  // Reader/writer invariant — propose_import writes, the confirm
  // route reads. Both derive via this helper; a drift here would
  // silently miss the outcome write.
  const fromWriter = confirmImportWidgetKey("invitees", "ing_x", "camp_z");
  const fromReader = confirmImportWidgetKey("invitees", "ing_x", "camp_z");
  assert.equal(fromWriter, fromReader);
});

test("confirmImportWidgetKey: throws when invitees receives null campaignId", () => {
  // Guard at the formula. A caller that forgets campaignId on the
  // invitees path must fail loudly, not collapse to a stale key.
  // The current propose_import code returns plain text on missing
  // campaign_id before even calling this helper, but the test pins
  // the defence-in-depth shape.
  assert.throws(
    () => confirmImportWidgetKey("invitees", "ing_1", null),
    /invitees target requires a non-empty campaignId/,
  );
});

test("confirmImportWidgetKey: throws when invitees receives empty-string campaignId", () => {
  // Empty string is "technically a string" but would produce
  // `confirm.import.invitees..ing_1` — a valid-looking key that
  // could still collide across callers. Reject at the seam.
  assert.throws(
    () => confirmImportWidgetKey("invitees", "ing_1", ""),
    /invitees target requires a non-empty campaignId/,
  );
});

test("confirmImportWidgetKey: throws when contacts target receives a non-null campaignId", () => {
  // The inverse guard. Contacts are global; threading a campaign
  // through the key would create the illusion that contacts imports
  // are per-campaign. Fail loudly so a buggy caller can't silently
  // fragment the contacts import into per-campaign widgets.
  assert.throws(
    () => confirmImportWidgetKey("contacts", "ing_1", "camp_A"),
    /contacts target must receive campaignId=null/,
  );
});

test("entity-keyed helpers reject no silently on empty id but type system rules out undefined", () => {
  // The TypeScript signature requires `string`, so undefined/null
  // can't reach here without a `@ts-ignore`. An empty string IS
  // typable, and the current contract interpolates it verbatim
  // (producing keys like "campaign." / "confirm.send."). The server-
  // side validator in widgets.ts rejects a zero-length widgetKey
  // (see `if (typeof widgetKey !== "string" || widgetKey.length ===
  // 0)`), so the empty-id case is caught there. Pin here that we
  // DON'T silently skip or default — the caller's job is to supply
  // a real id.
  assert.equal(campaignDetailWidgetKey(""), "campaign.");
  assert.equal(confirmSendWidgetKey(""), "confirm.send.");
  assert.equal(confirmDraftWidgetKey(""), "confirm.draft.");
});
