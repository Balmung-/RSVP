import { prisma } from "./db";

// Shared arrivals feed: same shape served by the API, the workspace
// arrivals tab, and the full-bleed kiosk. The `version` string is
// ETag-shaped — idle pollers get a cheap 304 without re-decoding the
// body. One source of truth so those three surfaces never drift.

export type ArrivalsFeed = {
  version: string;
  totals: {
    expected: number;
    arrived: number;
    pending: number;
    expectedGuests: number;
    arrivedGuests: number;
  };
  rows: Array<{
    id: string;
    name: string;
    title: string | null;
    organization: string | null;
    token: string;
    guestsCount: number;
    checkedInAt: string | null;
  }>;
};

export async function buildArrivalsFeed(
  campaignId: string,
  opts: { take?: number } = {},
): Promise<ArrivalsFeed> {
  const [responses, agg, arrivedCount, arrivedGuestsAgg] = await Promise.all([
    prisma.response.findMany({
      where: { campaignId, attending: true },
      include: {
        invitee: { select: { fullName: true, title: true, organization: true, rsvpToken: true } },
      },
      orderBy: [{ checkedInAt: "desc" }, { respondedAt: "desc" }],
      take: opts.take ?? 500,
    }),
    prisma.response.aggregate({
      where: { campaignId, attending: true },
      _sum: { guestsCount: true },
      _count: { _all: true },
      _max: { checkedInAt: true, respondedAt: true },
    }),
    prisma.response.count({
      where: { campaignId, attending: true, checkedInAt: { not: null } },
    }),
    prisma.response.aggregate({
      where: { campaignId, attending: true, checkedInAt: { not: null } },
      _sum: { guestsCount: true },
    }),
  ]);

  return {
    version: [
      agg._max.checkedInAt?.toISOString() ?? "",
      agg._max.respondedAt?.toISOString() ?? "",
      agg._count._all,
    ].join("|"),
    totals: {
      expected: agg._count._all,
      arrived: arrivedCount,
      pending: agg._count._all - arrivedCount,
      expectedGuests: agg._sum.guestsCount ?? 0,
      arrivedGuests: arrivedGuestsAgg._sum.guestsCount ?? 0,
    },
    rows: responses.map((r) => ({
      id: r.id,
      name: r.invitee.fullName,
      title: r.invitee.title,
      organization: r.invitee.organization,
      token: r.invitee.rsvpToken,
      guestsCount: r.guestsCount,
      checkedInAt: r.checkedInAt?.toISOString() ?? null,
    })),
  };
}
