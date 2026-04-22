import { cache } from "react";
import { prisma } from "./db";
import { scopedCampaignWhere } from "./teams";
import { DELIVERED_FAIL_STATUSES } from "./statuses";

// One prioritized feed for the header bell. Everything the operator
// might otherwise chase by walking between /approvals, /deliverability,
// /inbox, and the per-campaign VIP pings. The bell's visible signal is
// binary — dot or no dot; the detail only appears when the user opens
// the panel. Matches the directive: one sharp signal, complexity
// hidden until asked for.
//
// Wrapped in React.cache so a single request that renders the Shell
// (which queries this) alongside any future caller in the same tree
// deduplicates the four Prisma counts. Per-request scope — subsequent
// requests still get fresh data.

export type NotificationItem = {
  kind: "approval" | "failures" | "inbox" | "vip";
  title: string;
  detail: string | null;
  href: string;
  tone: "warn" | "fail" | "default";
};

export const getNotifications = cache(async function getNotifications(
  userId: string,
  isWorkspaceAdmin: boolean,
  tenantId: string | null,
): Promise<NotificationItem[]> {
  if (!tenantId) return [];
  const campaignScope = await scopedCampaignWhere(userId, isWorkspaceAdmin, tenantId);
  const out: NotificationItem[] = [];

  // Approvals — admins only, because only they can decide them.
  if (isWorkspaceAdmin) {
    const pending = await prisma.sendApproval.count({
      where: { status: "pending", campaign: campaignScope },
    });
    if (pending > 0) {
      out.push({
        kind: "approval",
        title: pending === 1 ? "1 send awaiting approval" : `${pending} sends awaiting approval`,
        detail: "Review before the dispatcher can proceed.",
        href: "/approvals",
        tone: "warn",
      });
    }
  }

  // Live send failures within the caller's team scope.
  const failures = await prisma.invitation.count({
    where: {
      status: { in: DELIVERED_FAIL_STATUSES },
      createdAt: { gte: new Date(Date.now() - 7 * 24 * 3600_000) },
      campaign: campaignScope,
    },
  });
  if (failures > 0) {
    out.push({
      kind: "failures",
      title: failures === 1 ? "1 delivery failure" : `${failures} delivery failures`,
      detail: "Chase and retry.",
      href: "/deliverability",
      tone: "fail",
    });
  }

  // Inbox items needing reviewer attention.
  const inbox = await prisma.inboundMessage.count({
    where: {
      status: "needs_review",
      ...(isWorkspaceAdmin ? {} : {
        OR: [
          { inviteeId: null },
          { invitee: { campaign: campaignScope } },
        ],
      }),
    },
  });
  if (inbox > 0) {
    out.push({
      kind: "inbox",
      title: inbox === 1 ? "1 reply to review" : `${inbox} replies to review`,
      detail: "Intent unclear or unmatched sender.",
      href: "/inbox",
      tone: "warn",
    });
  }

  // VIP RSVPs from the last 24h — so protocol knows to follow up.
  const vipSince = new Date(Date.now() - 24 * 3600_000);
  const vipCount = await prisma.response.count({
    where: {
      respondedAt: { gte: vipSince },
      campaign: campaignScope,
      invitee: { contact: { vipTier: { in: ["royal", "minister", "vip"] } } },
    },
  });
  if (vipCount > 0) {
    out.push({
      kind: "vip",
      title: vipCount === 1 ? "1 VIP response" : `${vipCount} VIP responses`,
      detail: "In the last 24 hours.",
      href: "/overview",
      tone: "default",
    });
  }

  return out;
});
