import type { Prisma } from "@prisma/client";
import { phrase, type ActivityRecord } from "@/lib/activity";
import type { Widget } from "./widgets";
import { deriveActivityScope } from "./tools/activity-scope";

type CampaignStatus = "draft" | "active" | "sending" | "closed" | "archived";

const DEFAULT_CAMPAIGN_LIMIT = 20;
const MAX_CAMPAIGN_LIMIT = 50;
const DEFAULT_CAMPAIGN_STATUSES: CampaignStatus[] = [
  "draft",
  "active",
  "sending",
];

const DEFAULT_ACTIVITY_DAYS = 7;
const MAX_ACTIVITY_DAYS = 30;
const DEFAULT_ACTIVITY_LIMIT = 20;
const MAX_ACTIVITY_LIMIT = 50;
const ACTIVITY_STREAM_CAMPAIGN_CAP = 1000;

const CAMPAIGN_DETAIL_ACTIVITY_LIMIT = 10;
const CAMPAIGN_DETAIL_INVITEE_SCAN_CAP = 2000;

function buildCampaignListWhere(
  input: {
    status?: CampaignStatus[];
    upcoming_only?: boolean;
  },
  campaignScope: Prisma.CampaignWhereInput,
  now: Date,
): Prisma.CampaignWhereInput {
  const statuses = input.status ?? DEFAULT_CAMPAIGN_STATUSES;
  const andClauses: Prisma.CampaignWhereInput[] = [
    campaignScope,
    { status: { in: statuses } },
  ];
  if (input.upcoming_only) {
    andClauses.push({
      OR: [{ eventAt: null }, { eventAt: { gte: now } }],
    });
  }
  return { AND: andClauses };
}

export type LiveSnapshotPrismaLike = {
  campaign: {
    findMany(args: {
      where: Prisma.CampaignWhereInput;
      orderBy?: Array<Record<string, "asc" | "desc">>;
      take?: number;
      select: Record<string, boolean>;
    }): Promise<
      Array<{
        id: string;
        name?: string | null;
        status?: string | null;
        eventAt?: Date | null;
        venue?: string | null;
        teamId?: string | null;
      }>
    >;
    findFirst(args: {
      where: Prisma.CampaignWhereInput;
      select: Record<string, boolean>;
    }): Promise<{
      id: string;
      name: string;
      description: string | null;
      status: string;
      eventAt: Date | null;
      venue: string | null;
      locale: string | null;
      teamId: string | null;
      createdAt: Date;
      updatedAt: Date;
    } | null>;
  };
  invitee: {
    count(args: { where: Prisma.InviteeWhereInput }): Promise<number>;
    findMany(args: {
      where: Prisma.InviteeWhereInput;
      select: { id: true };
    }): Promise<Array<{ id: string }>>;
    groupBy(args: {
      by: ["campaignId"];
      where: Prisma.InviteeWhereInput;
      _count: { _all: true };
    }): Promise<Array<{ campaignId: string; _count: { _all: number } }>>;
  };
  response: {
    count(args: { where: Prisma.ResponseWhereInput }): Promise<number>;
    groupBy(args: {
      by: ["campaignId"];
      where: Prisma.ResponseWhereInput;
      _count: { _all: true };
      _sum?: { guestsCount: true };
    }): Promise<
      Array<{
        campaignId: string;
        _count: { _all: number };
        _sum?: { guestsCount: number | null };
      }>
    >;
    aggregate(args: {
      where: Prisma.ResponseWhereInput;
      _sum: { guestsCount: true };
    }): Promise<{ _sum: { guestsCount: number | null } }>;
  };
  eventLog: {
    findMany(args: {
      where: Prisma.EventLogWhereInput;
      include: { actor: { select: { email: true; fullName: true } } };
      orderBy: { createdAt: "desc" };
      take: number;
    }): Promise<
      Array<{
        id: string;
        kind: string;
        refType: string | null;
        refId: string | null;
        data: string | null;
        createdAt: Date;
        actor: { email: string; fullName: string | null } | null;
      }>
    >;
  };
  campaignStage: {
    findMany(args: {
      where: { campaignId: string };
      select: { id: true };
    }): Promise<Array<{ id: string }>>;
  };
  invitation: {
    count(args: { where: Prisma.InvitationWhereInput }): Promise<number>;
  };
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeCampaignListFilters(
  widget: Widget,
): {
  status?: CampaignStatus[];
  upcoming_only?: boolean;
  limit?: number;
} {
  const filters = isPlainObject(widget.props.filters)
    ? widget.props.filters
    : null;
  const status = Array.isArray(filters?.status)
    ? filters.status.filter(
        (s): s is CampaignStatus =>
          s === "draft" ||
          s === "active" ||
          s === "sending" ||
          s === "closed" ||
          s === "archived",
      )
    : undefined;
  const upcoming_only =
    typeof filters?.upcoming_only === "boolean"
      ? filters.upcoming_only
      : undefined;
  const limit =
    typeof filters?.limit === "number" && Number.isFinite(filters.limit)
      ? Math.max(1, Math.min(MAX_CAMPAIGN_LIMIT, Math.floor(filters.limit)))
      : undefined;
  return {
    status: status && status.length > 0 ? status : undefined,
    upcoming_only,
    limit,
  };
}

function normalizeActivityFilters(
  widget: Widget,
): { days: number; limit: number } {
  const filters = isPlainObject(widget.props.filters)
    ? widget.props.filters
    : null;
  const days =
    typeof filters?.days === "number" && Number.isFinite(filters.days)
      ? Math.max(1, Math.min(MAX_ACTIVITY_DAYS, Math.floor(filters.days)))
      : DEFAULT_ACTIVITY_DAYS;
  const limit =
    typeof filters?.limit === "number" && Number.isFinite(filters.limit)
      ? Math.max(1, Math.min(MAX_ACTIVITY_LIMIT, Math.floor(filters.limit)))
      : DEFAULT_ACTIVITY_LIMIT;
  return { days, limit };
}

async function computeBulkCampaignStats(
  prismaLike: LiveSnapshotPrismaLike,
  ids: string[],
): Promise<Map<string, { total: number; responded: number; headcount: number }>> {
  const out = new Map<
    string,
    { total: number; responded: number; headcount: number }
  >();
  for (const id of ids) {
    out.set(id, { total: 0, responded: 0, headcount: 0 });
  }
  if (ids.length === 0) return out;

  const [invitees, responses, attending] = await Promise.all([
    prismaLike.invitee.groupBy({
      by: ["campaignId"],
      where: { campaignId: { in: ids } },
      _count: { _all: true },
    }),
    prismaLike.response.groupBy({
      by: ["campaignId"],
      where: { campaignId: { in: ids } },
      _count: { _all: true },
    }),
    prismaLike.response.groupBy({
      by: ["campaignId"],
      where: { campaignId: { in: ids }, attending: true },
      _count: { _all: true },
      _sum: { guestsCount: true },
    }),
  ]);

  for (const row of invitees) {
    const stat = out.get(row.campaignId);
    if (stat) stat.total = row._count._all;
  }
  for (const row of responses) {
    const stat = out.get(row.campaignId);
    if (stat) stat.responded = row._count._all;
  }
  for (const row of attending) {
    const stat = out.get(row.campaignId);
    if (stat) {
      stat.headcount = row._count._all + (row._sum?.guestsCount ?? 0);
    }
  }

  return out;
}

async function computeCampaignStats(
  prismaLike: LiveSnapshotPrismaLike,
  campaignId: string,
) {
  const [
    total,
    responded,
    attending,
    declined,
    sentEmail,
    sentSms,
    sentWhatsApp,
    guestsAgg,
  ] = await Promise.all([
    prismaLike.invitee.count({ where: { campaignId } }),
    prismaLike.response.count({ where: { campaignId } }),
    prismaLike.response.count({ where: { campaignId, attending: true } }),
    prismaLike.response.count({ where: { campaignId, attending: false } }),
    prismaLike.invitation.count({
      where: {
        campaignId,
        channel: "email",
        status: { in: ["sent", "delivered"] },
      },
    }),
    prismaLike.invitation.count({
      where: {
        campaignId,
        channel: "sms",
        status: { in: ["sent", "delivered"] },
      },
    }),
    prismaLike.invitation.count({
      where: {
        campaignId,
        channel: "whatsapp",
        status: { in: ["sent", "delivered"] },
      },
    }),
    prismaLike.response.aggregate({
      where: { campaignId, attending: true },
      _sum: { guestsCount: true },
    }),
  ]);
  const guests = guestsAgg._sum.guestsCount ?? 0;
  return {
    total,
    responded,
    pending: total - responded,
    attending,
    declined,
    guests,
    headcount: attending + guests,
    sentEmail,
    sentSms,
    sentWhatsApp,
  };
}

async function rebuildCampaignListWidget(
  prismaLike: LiveSnapshotPrismaLike,
  campaignScope: Prisma.CampaignWhereInput,
  widget: Widget,
  now: Date,
): Promise<Widget> {
  const input = normalizeCampaignListFilters(widget);
  const statuses = input.status ?? DEFAULT_CAMPAIGN_STATUSES;
  const limit = input.limit ?? DEFAULT_CAMPAIGN_LIMIT;
  const where = buildCampaignListWhere(input, campaignScope, now);
  const campaigns = await prismaLike.campaign.findMany({
    where,
    orderBy: [
      { status: "asc" },
      { eventAt: "asc" },
      { createdAt: "desc" },
    ],
    take: limit,
    select: {
      id: true,
      name: true,
      status: true,
      eventAt: true,
      venue: true,
      teamId: true,
    },
  });
  const statsById = await computeBulkCampaignStats(
    prismaLike,
    campaigns.map((c) => c.id),
  );
  return {
    ...widget,
    props: {
      items: campaigns.map((c) => {
        const stats = statsById.get(c.id) ?? {
          total: 0,
          responded: 0,
          headcount: 0,
        };
        return {
          id: c.id,
          name: c.name ?? "",
          status: c.status ?? "draft",
          event_at: c.eventAt ? c.eventAt.toISOString() : null,
          venue: c.venue ?? null,
          team_id: c.teamId ?? null,
          stats,
        };
      }),
      filters: {
        status: statuses,
        upcoming_only: Boolean(input.upcoming_only),
        limit,
      },
    },
  };
}

async function rebuildCampaignCardWidget(
  prismaLike: LiveSnapshotPrismaLike,
  campaignScope: Prisma.CampaignWhereInput,
  widget: Widget,
): Promise<Widget | null> {
  const campaignId =
    typeof widget.props.id === "string" && widget.props.id.length > 0
      ? widget.props.id
      : null;
  if (!campaignId) return null;

  const campaign = await prismaLike.campaign.findFirst({
    where: { AND: [campaignScope, { id: campaignId }] },
    select: {
      id: true,
      name: true,
      description: true,
      status: true,
      eventAt: true,
      venue: true,
      locale: true,
      teamId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!campaign) return null;

  const [stageIds, inviteeCount] = await Promise.all([
    prismaLike.campaignStage.findMany({
      where: { campaignId: campaign.id },
      select: { id: true },
    }),
    prismaLike.invitee.count({ where: { campaignId: campaign.id } }),
  ]);
  const inviteeIds =
    inviteeCount <= CAMPAIGN_DETAIL_INVITEE_SCAN_CAP
      ? (
          await prismaLike.invitee.findMany({
            where: { campaignId: campaign.id },
            select: { id: true },
          })
        ).map((i) => i.id)
      : null;
  const { activityWhere, inviteeScanCapped } = deriveActivityScope({
    campaignId: campaign.id,
    stageIds,
    inviteeIds,
  });

  const [stats, activityRows] = await Promise.all([
    computeCampaignStats(prismaLike, campaign.id),
    prismaLike.eventLog.findMany({
      where: activityWhere,
      include: { actor: { select: { email: true, fullName: true } } },
      orderBy: { createdAt: "desc" },
      take: CAMPAIGN_DETAIL_ACTIVITY_LIMIT,
    }),
  ]);

  return {
    ...widget,
    props: {
      id: campaign.id,
      name: campaign.name,
      description: campaign.description,
      status: campaign.status,
      event_at: campaign.eventAt ? campaign.eventAt.toISOString() : null,
      venue: campaign.venue,
      locale: campaign.locale,
      team_id: campaign.teamId,
      created_at: campaign.createdAt.toISOString(),
      updated_at: campaign.updatedAt.toISOString(),
      stats,
      activity: activityRows.map((row) => {
        const p = phrase(row as unknown as ActivityRecord);
        return {
          id: row.id,
          created_at: row.createdAt.toISOString(),
          kind: row.kind,
          tone: p.tone,
          line: p.line,
        };
      }),
      invitee_scan_capped: inviteeScanCapped,
    },
  };
}

async function rebuildActivityStreamWidget(
  prismaLike: LiveSnapshotPrismaLike,
  campaignScope: Prisma.CampaignWhereInput,
  isAdmin: boolean,
  widget: Widget,
  now: Date,
): Promise<Widget> {
  const { days, limit } = normalizeActivityFilters(widget);
  const since = new Date(now.getTime() - days * 86_400_000);
  const visibleCampaignIds = isAdmin
    ? null
    : (
        await prismaLike.campaign.findMany({
          where: campaignScope,
          select: { id: true },
          orderBy: [{ updatedAt: "desc" }],
          take: ACTIVITY_STREAM_CAMPAIGN_CAP,
        })
      ).map((c) => c.id);
  const where: Prisma.EventLogWhereInput = {
    createdAt: { gte: since },
    ...(visibleCampaignIds === null
      ? {}
      : {
          OR: [
            { refType: null },
            {
              refType: {
                notIn: ["campaign", "invitation", "invitee", "stage", "response"],
              },
            },
            { refType: "campaign", refId: { in: visibleCampaignIds } },
          ],
        }),
  };
  const rows = await prismaLike.eventLog.findMany({
    where,
    include: { actor: { select: { email: true, fullName: true } } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return {
    ...widget,
    props: {
      items: rows.map((row) => {
        const p = phrase(row as unknown as ActivityRecord);
        return {
          id: row.id,
          created_at: row.createdAt.toISOString(),
          kind: row.kind,
          ref_type: row.refType,
          ref_id: row.refId,
          tone: p.tone,
          line: p.line,
          actor: row.actor
            ? {
                email: row.actor.email,
                full_name: row.actor.fullName,
              }
            : null,
        };
      }),
      filters: { days, limit },
    },
  };
}

export async function refreshLiveSnapshotWidgets(
  deps: { prismaLike: LiveSnapshotPrismaLike },
  args: {
    widgets: Widget[];
    campaignScope: Prisma.CampaignWhereInput;
    isAdmin: boolean;
    now?: Date;
  },
): Promise<Widget[]> {
  const now = args.now ?? new Date();
  const refreshed = await Promise.all(
    args.widgets.map(async (widget) => {
      switch (widget.kind) {
        case "campaign_list":
          return rebuildCampaignListWidget(
            deps.prismaLike,
            args.campaignScope,
            widget,
            now,
          );
        case "campaign_card":
          return rebuildCampaignCardWidget(
            deps.prismaLike,
            args.campaignScope,
            widget,
          );
        case "activity_stream":
          return rebuildActivityStreamWidget(
            deps.prismaLike,
            args.campaignScope,
            args.isAdmin,
            widget,
            now,
          );
        default:
          return widget;
      }
    }),
  );
  return refreshed.filter((widget): widget is Widget => widget !== null);
}
