// One source of truth for the string enums that thread through the app.
// The underlying columns are `String` in Prisma (deliberate — allows
// future additions without a migration), but every code path that
// checks a value should key off these constants so typos surface at
// compile time and the allowed-set never drifts across callers.

export const CAMPAIGN_STATUSES = [
  "draft",
  "active",
  "sending",
  "closed",
  "archived",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

// Subsets that pages use to filter "live" campaigns from the overview.
export const ACTIVE_CAMPAIGN_STATUSES: CampaignStatus[] = [
  "draft",
  "active",
  "sending",
];
export const UPCOMING_CAMPAIGN_STATUSES: CampaignStatus[] = [
  "draft",
  "active",
  "sending",
];
export const PAST_CAMPAIGN_STATUSES: CampaignStatus[] = ["closed", "archived"];

export const INVITATION_STATUSES = [
  "queued",
  "sent",
  "delivered",
  "failed",
  "bounced",
] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const DELIVERED_OK_STATUSES: InvitationStatus[] = ["sent", "delivered"];
export const DELIVERED_FAIL_STATUSES: InvitationStatus[] = [
  "failed",
  "bounced",
];

export const STAGE_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "expired",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const INBOUND_STATUSES = [
  "new",
  "needs_review",
  "processed",
  "ignored",
] as const;
export type InboundStatus = (typeof INBOUND_STATUSES)[number];
