// Centralised `widgetKey` formulas for the 6 AI-visible workspace
// widgets. Importing from this module is the ONLY supported way to
// derive a widget key — inline string/template literals elsewhere
// drift out of sync with the formula and break "same filter = same
// widget row" (the W4 update-in-place contract) or "outcome writer
// can find the ready card" (the W5 persisted-state contract) in
// subtle, test-invisible ways.
//
// Why a module rather than a per-tool export: the keys are a
// cross-cutting protocol between writers (tool handlers) and
// readers (the workspace reducer, the hydrate handler, the
// `/api/chat/confirm/<messageId>` outcome marker that looks up the
// confirm_send widget by key to stamp its state). Co-locating
// formulas here is the only way to make GPT audits catch drift —
// a grep for `widgetKey: \`confirm.send.` across the repo would
// miss a silently renamed handler.
//
// Static-keyed widgets collapse to a module constant. Entity-keyed
// widgets expose a helper that takes the id and returns the formed
// key. IDs are never sanitised at this seam (no URL-encoding, no
// truncation) — the upstream schema already guarantees DB-row IDs
// are cuid/slug-safe and the key column in Prisma is a plain
// String unique-on-(sessionId, widgetKey). If that assumption ever
// changes, it changes here and propagates via TypeScript, not by
// re-finding every template literal in the tools directory.

export const CAMPAIGNS_LIST_WIDGET_KEY = "campaigns.list";
export const CONTACTS_TABLE_WIDGET_KEY = "contacts.table";
export const ACTIVITY_STREAM_WIDGET_KEY = "activity.stream";

// W7 — persistent workspace summary pinned to the `summary` slot.
// One row per chat session, updated in-place by `refreshWorkspaceSummary`
// after any mutation that could move its counters. The key is static
// (not per-entity) so every refresh upserts the SAME row — the whole
// point of the rollup is a single stable card operators can skim.
export const WORKSPACE_SUMMARY_WIDGET_KEY = "workspace.summary";

export function campaignDetailWidgetKey(campaignId: string): string {
  return `campaign.${campaignId}`;
}

export function confirmSendWidgetKey(campaignId: string): string {
  return `confirm.send.${campaignId}`;
}

export function confirmDraftWidgetKey(campaignId: string): string {
  return `confirm.draft.${campaignId}`;
}
