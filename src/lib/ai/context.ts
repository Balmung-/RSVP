import { cache } from "react";
import type { User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasRole } from "@/lib/auth";
import { scopedCampaignWhere } from "@/lib/teams";
import { getNotifications } from "@/lib/notifications";
import { vipWatch, VIP_LABEL, type VipTier } from "@/lib/contacts";
import { DELIVERED_FAIL_STATUSES } from "@/lib/statuses";

// "Awareness context" — the structured snapshot of what matters right
// now in the tenant, dropped into the system prompt so the assistant
// doesn't have to run a read tool just to answer "what's happening?".
//
// Every query here composes with scopedCampaignWhere — a non-admin
// operator's context block NEVER contains campaigns outside their
// team. Trust boundary: this text is stuffed into the prompt as
// TRUSTED (our-own-server-computed) content, in contrast with any
// third-party text (forwarded emails, Telegram messages) which lives
// in a separately labelled "untrusted" block when we get to Phase B.
//
// The shape is pure text. Prompt caching captures it as a single
// large block — subsequent turns within the 5-min TTL re-use the
// cached tokens. Refreshed at turn start, so "what's new?" after a
// few minutes still sees the updated feed.

export type TenantContext = {
  // Rendered markdown-ish text block ready for the system prompt.
  text: string;
  // Structured form (not sent to the model directly — useful for
  // tests and for the /api/chat route to include a cacheable
  // digest breadcrumb in EventLog).
  summary: {
    upcomingCount: number;
    pendingApprovals: number;
    liveFailures: number;
    vipCount: number;
    notifications: number;
  };
};

const HORIZON_DAYS = 7;
const VIP_LIMIT = 5;
const UPCOMING_LIMIT = 8;

export const buildContext = cache(async function buildContext(
  user: User,
): Promise<TenantContext> {
  const isAdmin = hasRole(user, "admin");
  const campaignScope = await scopedCampaignWhere(user.id, isAdmin);
  const now = new Date();
  const horizon = new Date(now.getTime() + HORIZON_DAYS * 24 * 3600_000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000);

  const [upcoming, pendingApprovals, liveFailures, vips, notifs] = await Promise.all([
    // Upcoming scoped to user.
    prisma.campaign.findMany({
      where: {
        AND: [
          campaignScope,
          { status: { in: ["draft", "active", "sending"] } },
          { eventAt: { gte: now, lte: horizon } },
        ],
      },
      orderBy: { eventAt: "asc" },
      take: UPCOMING_LIMIT,
      select: { id: true, name: true, status: true, eventAt: true, venue: true },
    }),
    // Approvals — admin-only surface. Non-admins see a fixed "n/a".
    isAdmin
      ? prisma.sendApproval.count({ where: { status: "pending" } })
      : Promise.resolve<number | null>(null),
    // Live failures in the last 7 days, team-scoped via the
    // campaign relation (matches notifications.ts).
    prisma.invitation.count({
      where: {
        status: { in: DELIVERED_FAIL_STATUSES },
        createdAt: { gte: weekAgo },
        campaign: campaignScope,
      },
    }),
    vipWatch(campaignScope),
    getNotifications(user.id, isAdmin),
  ]);

  const lines: string[] = [];
  lines.push(`## Tenant context (as of ${now.toISOString()})`);
  lines.push("");
  lines.push(
    `Viewer: ${user.fullName ?? user.email} (${user.role}). Team scope: ${
      isAdmin ? "admin — no restriction" : "team-member — sees own teams + office-wide"
    }.`,
  );
  lines.push("");

  // Upcoming campaigns
  lines.push(`### Upcoming (next ${HORIZON_DAYS} days)`);
  if (upcoming.length === 0) {
    lines.push("_None scheduled in the window._");
  } else {
    for (const c of upcoming) {
      const when = c.eventAt ? c.eventAt.toISOString() : "no date";
      const where = c.venue ? ` @ ${c.venue}` : "";
      lines.push(`- ${c.name} [${c.status}] ${when}${where}`);
    }
  }
  lines.push("");

  // Approvals
  lines.push("### Pending approvals");
  if (pendingApprovals === null) {
    lines.push("_(admin-only, not applicable to this viewer)_");
  } else if (pendingApprovals === 0) {
    lines.push("_None._");
  } else {
    lines.push(
      `${pendingApprovals} send${pendingApprovals === 1 ? "" : "s"} awaiting admin sign-off.`,
    );
  }
  lines.push("");

  // VIP watch
  lines.push(`### VIP watch (top ${VIP_LIMIT})`);
  if (vips.length === 0) {
    lines.push("_No VIP invitees on active campaigns._");
  } else {
    for (const i of vips.slice(0, VIP_LIMIT)) {
      const tier = (i.contact?.vipTier as VipTier) ?? "standard";
      const tierLabel = VIP_LABEL[tier] ?? tier;
      const state = i.response
        ? i.response.attending
          ? "attending"
          : "declined"
        : "pending";
      lines.push(
        `- ${i.contact?.fullName ?? "unknown"} (${tierLabel}) — ${i.campaign.name} — ${state}`,
      );
    }
  }
  lines.push("");

  // Deliverability
  lines.push("### Deliverability (last 7 days)");
  lines.push(
    liveFailures === 0
      ? "_All clear._"
      : `${liveFailures} live failure${liveFailures === 1 ? "" : "s"} within scope.`,
  );
  lines.push("");

  // Notification feed
  lines.push("### Notification feed");
  if (notifs.length === 0) {
    lines.push("_Nothing flagged._");
  } else {
    for (const n of notifs.slice(0, 5)) {
      lines.push(`- [${n.tone}] ${n.title}${n.detail ? ` — ${n.detail}` : ""}`);
    }
  }

  return {
    text: lines.join("\n"),
    summary: {
      upcomingCount: upcoming.length,
      pendingApprovals: pendingApprovals ?? 0,
      liveFailures,
      vipCount: vips.length,
      notifications: notifs.length,
    },
  };
});
