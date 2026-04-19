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

// P6 — file ingest workspace surfaces. Keys are derived from the
// FileIngest row id (stable across re-extractions because the
// orchestrator upserts on fileUploadId). A second call to
// `summarize_file` with the same ingest replaces the same digest
// card; a second call to `review_file_import` for the same target
// replaces the same review.
//
// Separate helpers because the two widgets can coexist on the
// dashboard — the digest in `secondary` (quick reference), the
// review in `primary` (main subject during an import). If a future
// reshuffling wants both in the same slot, the replacement rules
// live in the reducer, not in the key — keys are identity, not
// layout.
export function fileDigestWidgetKey(ingestId: string): string {
  return `file.digest.${ingestId}`;
}

// Target-scoped key so the same file can have a `contacts` review
// AND a separate `invitees` review coexisting. Most uploads pick one
// target; this is belt-and-braces for operators who explicitly pivot.
export function importReviewWidgetKey(
  target: "contacts" | "invitees" | "campaign_metadata",
  ingestId: string,
): string {
  return `import.review.${target}.${ingestId}`;
}

// P7 — commit-confirmation card. Like `confirm_send`, it's entity-
// scoped so a second propose_import for the SAME destructive target
// upserts the SAME action card rather than stacking duplicates.
//
// Key composition:
//   - contacts  → `confirm.import.contacts.${ingestId}` — the
//                 contact book is global, so (target, ingest) is a
//                 unique destructive target on its own.
//   - invitees  → `confirm.import.invitees.${campaignId}.${ingestId}` —
//                 each campaign is a separate destructive target, so
//                 campaign_id is part of the identity. Without it, a
//                 previously emitted ready card for campaign A could
//                 silently remain live when the operator pivots to
//                 campaign B on the same file (ready-card-for-A ghost
//                 problem GPT's P7 audit flagged).
//
// Guards at the seam — a caller that forgets to pass campaignId on
// invitees (or passes one on contacts) fails loudly here, not with a
// silent key collision. This is the one place the invariant lives;
// moving it would reintroduce the drift.
//
// `campaign_metadata` is intentionally excluded from this seam:
// metadata imports stay read-only in P7 (the `draft_campaign` tool
// is the authorised write path for Campaign rows). The type union
// pins that contract at the compiler.
export function confirmImportWidgetKey(
  target: "contacts" | "invitees",
  ingestId: string,
  campaignId: string | null,
): string {
  if (target === "invitees") {
    if (!campaignId) {
      throw new Error(
        "confirmImportWidgetKey: invitees target requires a non-empty campaignId",
      );
    }
    return `confirm.import.invitees.${campaignId}.${ingestId}`;
  }
  if (campaignId !== null) {
    throw new Error(
      "confirmImportWidgetKey: contacts target must receive campaignId=null (contacts are global)",
    );
  }
  return `confirm.import.contacts.${ingestId}`;
}
