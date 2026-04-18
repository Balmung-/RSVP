import { prisma } from "./db";
import { DELIVERED_OK_STATUSES, DELIVERED_FAIL_STATUSES } from "./statuses";
import type { Prisma } from "@prisma/client";

// Shared "live failure" logic for /deliverability, the campaign
// workspace banner, and the daily digest. A failure is "live" only
// if no later attempt succeeded on the same (invitee, channel) —
// this was previously three near-identical copies across the
// codebase; consolidating keeps the definition unambiguous.
//
// Default lookback is 60 days so ancient bounces don't drown the
// views. Callers can scope further by passing a Campaign where
// input (team scoping).

const DEFAULT_LOOKBACK_DAYS = 60;

type FailureRow = {
  id: string;
  inviteeId: string;
  channel: string;
  createdAt: Date;
  status: string;
  campaignId: string;
  error: string | null;
};

export type LiveFailuresOptions = {
  lookbackDays?: number;
  campaignWhere?: Prisma.CampaignWhereInput;
  campaignId?: string;
  status?: "failed" | "bounced";
  channel?: "email" | "sms";
  take?: number;
};

// Returns every failing/bounced Invitation row that has NOT been
// superseded by a later sent/delivered on the same (invitee, channel).
// The caller gets the raw Invitation subset so pages can include more
// relations if needed.
export async function liveFailures(opts: LiveFailuresOptions = {}): Promise<FailureRow[]> {
  const lookback = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const since = new Date(Date.now() - lookback * 24 * 60 * 60 * 1000);

  const failures = await prisma.invitation.findMany({
    where: {
      status: opts.status ? opts.status : { in: DELIVERED_FAIL_STATUSES },
      createdAt: { gte: since },
      ...(opts.channel ? { channel: opts.channel } : {}),
      ...(opts.campaignId ? { campaignId: opts.campaignId } : {}),
      ...(opts.campaignWhere ? { campaign: opts.campaignWhere } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      inviteeId: true,
      channel: true,
      createdAt: true,
      status: true,
      campaignId: true,
      error: true,
    },
    ...(opts.take ? { take: opts.take } : {}),
  });
  if (failures.length === 0) return [];

  const laterOk = await prisma.invitation.groupBy({
    by: ["inviteeId", "channel"],
    where: {
      inviteeId: { in: failures.map((f) => f.inviteeId) },
      status: { in: DELIVERED_OK_STATUSES },
      ...(opts.campaignId ? { campaignId: opts.campaignId } : {}),
    },
    _max: { createdAt: true },
  });
  const okAt = new Map<string, Date>();
  for (const g of laterOk) {
    if (g._max.createdAt) okAt.set(`${g.inviteeId}:${g.channel}`, g._max.createdAt);
  }
  return failures.filter((f) => {
    const ok = okAt.get(`${f.inviteeId}:${f.channel}`);
    return !ok || ok < f.createdAt;
  });
}

// Quick count per-campaign for the workspace banner.
export async function liveFailureCount(campaignId: string): Promise<{
  total: number;
  email: number;
  sms: number;
}> {
  const rows = await liveFailures({ campaignId });
  let email = 0;
  let sms = 0;
  for (const f of rows) {
    if (f.channel === "email") email++;
    else if (f.channel === "sms") sms++;
  }
  return { total: email + sms, email, sms };
}

// Variant for pages that already ran their own findMany with specific
// relations (e.g. the /deliverability list that pulls invitee + campaign
// subsets). Returns only the rows not superseded by a later success.
// One groupBy over the candidate set, same shape as liveFailures().
export async function filterLiveFailures<
  T extends { inviteeId: string; channel: string; createdAt: Date },
>(
  failures: T[],
  scope: { campaignId?: string } = {},
): Promise<T[]> {
  if (failures.length === 0) return [];
  const laterOk = await prisma.invitation.groupBy({
    by: ["inviteeId", "channel"],
    where: {
      inviteeId: { in: failures.map((f) => f.inviteeId) },
      status: { in: DELIVERED_OK_STATUSES },
      ...(scope.campaignId ? { campaignId: scope.campaignId } : {}),
    },
    _max: { createdAt: true },
  });
  const okAt = new Map<string, Date>();
  for (const g of laterOk) {
    if (g._max.createdAt) okAt.set(`${g.inviteeId}:${g.channel}`, g._max.createdAt);
  }
  return failures.filter((f) => {
    const ok = okAt.get(`${f.inviteeId}:${f.channel}`);
    return !ok || ok < f.createdAt;
  });
}
