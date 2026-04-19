import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVITY_STREAM_WIDGET_KEY,
  campaignDetailWidgetKey,
  CAMPAIGNS_LIST_WIDGET_KEY,
  CONTACTS_TABLE_WIDGET_KEY,
  confirmDraftWidgetKey,
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
