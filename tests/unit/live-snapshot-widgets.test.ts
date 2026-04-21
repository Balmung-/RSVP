import { test } from "node:test";
import assert from "node:assert/strict";
import type { Widget } from "../../src/lib/ai/widgets";
import {
  refreshLiveSnapshotWidgets,
  type LiveSnapshotPrismaLike,
} from "../../src/lib/ai/live-snapshot-widgets";

const NOW = new Date("2026-04-21T10:00:00.000Z");

function makeWidget(
  kind: Widget["kind"],
  props: Record<string, unknown>,
  overrides: Partial<Widget> = {},
): Widget {
  return {
    widgetKey: overrides.widgetKey ?? `w.${kind}`,
    kind,
    slot: overrides.slot ?? "primary",
    props,
    order: overrides.order ?? 0,
    sourceMessageId: overrides.sourceMessageId ?? null,
    createdAt: overrides.createdAt ?? NOW.toISOString(),
    updatedAt: overrides.updatedAt ?? NOW.toISOString(),
  };
}

function makePrisma(): LiveSnapshotPrismaLike {
  const campaigns = [
    {
      id: "c-1",
      name: "Summit",
      description: "Annual summit",
      status: "active",
      eventAt: new Date("2026-05-01T10:00:00.000Z"),
      venue: "Cairo",
      locale: "ar",
      teamId: "team-1",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-21T09:00:00.000Z"),
    },
    {
      id: "c-2",
      name: "Dinner",
      description: null,
      status: "draft",
      eventAt: null,
      venue: null,
      locale: "ar",
      teamId: "team-1",
      createdAt: new Date("2026-04-02T00:00:00.000Z"),
      updatedAt: new Date("2026-04-20T09:00:00.000Z"),
    },
  ];
  const campaignStages = [{ id: "stage-1", campaignId: "c-1" }];
  const invitees = [
    { id: "i-1", campaignId: "c-1" },
    { id: "i-2", campaignId: "c-1" },
    { id: "i-3", campaignId: "c-2" },
  ];
  const responses = [
    { campaignId: "c-1", attending: true, guestsCount: 2, respondedAt: NOW },
    {
      campaignId: "c-1",
      attending: false,
      guestsCount: 0,
      respondedAt: new Date("2026-04-20T08:00:00.000Z"),
    },
  ];
  const invitations = [
    {
      campaignId: "c-1",
      channel: "email",
      status: "delivered",
    },
    {
      campaignId: "c-1",
      channel: "sms",
      status: "sent",
    },
    {
      campaignId: "c-1",
      channel: "whatsapp",
      status: "delivered",
    },
  ];
  const eventLogs = [
    {
      id: "e-1",
      kind: "invite.delivered",
      refType: "invitation",
      refId: "inv-1",
      data: JSON.stringify({ channel: "whatsapp" }),
      createdAt: NOW,
      actor: null,
    },
    {
      id: "e-2",
      kind: "invite.sent",
      refType: "campaign",
      refId: "c-1",
      data: JSON.stringify({ channel: "email" }),
      createdAt: new Date("2026-04-20T12:00:00.000Z"),
      actor: null,
    },
  ];

  const campaignVisible = (where: unknown, campaignId: string) => {
    const obj = where as {
      AND?: Array<Record<string, unknown>>;
      id?: { in?: string[] };
    };
    if (Array.isArray(obj.AND) && obj.AND.length > 0) {
      const first = obj.AND[0] as { id?: { in?: string[] } };
      if (Array.isArray(first.id?.in)) return first.id.in.includes(campaignId);
    }
    if (Array.isArray(obj.id?.in)) return obj.id.in.includes(campaignId);
    return true;
  };

  return {
    campaign: {
      async findMany(args) {
        const filtered = campaigns.filter((c) =>
          campaignVisible(args.where, c.id),
        );
        return filtered.map((c) => {
          const out: Record<string, unknown> = {};
          for (const key of Object.keys(args.select)) {
            if (args.select[key]) out[key] = c[key as keyof typeof c];
          }
          return out as {
            id: string;
            name?: string | null;
            status?: string | null;
            eventAt?: Date | null;
            venue?: string | null;
            teamId?: string | null;
          };
        });
      },
      async findFirst(args) {
        const exactId =
          Array.isArray((args.where as { AND?: Array<{ id?: string }> }).AND) &&
          typeof (args.where as { AND: Array<{ id?: string }> }).AND[1]?.id ===
            "string"
            ? (args.where as { AND: Array<{ id?: string }> }).AND[1].id
            : null;
        const found = campaigns.find(
          (c) => c.id === exactId && campaignVisible(args.where, c.id),
        );
        if (!found) return null;
        return found;
      },
    },
    invitee: {
      async count(args) {
        const where = args.where as Record<string, unknown>;
        return invitees.filter((i) => {
          if ("campaignId" in where && typeof where.campaignId === "string") {
            return i.campaignId === where.campaignId;
          }
          if ("campaign" in where && where.campaign && campaignVisible(where.campaign, i.campaignId)) {
            return true;
          }
          return false;
        }).length;
      },
      async findMany(args) {
        return invitees
          .filter((i) => i.campaignId === args.where.campaignId)
          .map((i) => ({ id: i.id }));
      },
      async groupBy(args) {
        const where = args.where as { campaignId: { in: string[] } };
        return where.campaignId.in.map((campaignId: string) => ({
          campaignId,
          _count: {
            _all: invitees.filter((i) => i.campaignId === campaignId).length,
          },
        }));
      },
    },
    response: {
      async count(args) {
        const where = args.where as Record<string, unknown>;
        return responses.filter((r) => {
          if ("campaignId" in where && typeof where.campaignId === "string") {
            if (r.campaignId !== where.campaignId) return false;
          }
          if ("campaign" in where && where.campaign && !campaignVisible(where.campaign, r.campaignId)) {
            return false;
          }
          if ("attending" in where && typeof where.attending === "boolean") {
            if (r.attending !== where.attending) return false;
          }
          if (
            "respondedAt" in where &&
            where.respondedAt &&
            typeof where.respondedAt === "object" &&
            "gte" in where.respondedAt &&
            where.respondedAt.gte instanceof Date
          ) {
            if (r.respondedAt < where.respondedAt.gte) return false;
          }
          return true;
        }).length;
      },
      async groupBy(args) {
        const where = args.where as Record<string, unknown>;
        const campaignIds = (where.campaignId as { in: string[] }).in;
        return campaignIds.map((campaignId: string) => {
          const filtered = responses.filter((r) => {
            if (r.campaignId !== campaignId) return false;
            if ("attending" in where && typeof where.attending === "boolean") {
              return r.attending === where.attending;
            }
            return true;
          });
          return {
            campaignId,
            _count: { _all: filtered.length },
            _sum:
              "attending" in where && where.attending === true
                ? {
                    guestsCount: filtered.reduce(
                      (sum, row) => sum + row.guestsCount,
                      0,
                    ),
                  }
                : undefined,
          };
        });
      },
      async aggregate(args) {
        const filtered = responses.filter(
          (r) =>
            r.campaignId === args.where.campaignId && r.attending === true,
        );
        return {
          _sum: {
            guestsCount: filtered.reduce(
              (sum, row) => sum + row.guestsCount,
              0,
            ),
          },
        };
      },
    },
    eventLog: {
      async findMany(args) {
        const filtered = eventLogs.filter((row) => {
          const where = args.where as Record<string, unknown>;
          const createdAt =
            "createdAt" in where ? (where.createdAt as { gte?: Date }) : null;
          if (createdAt?.gte instanceof Date && row.createdAt < createdAt.gte) {
            return false;
          }
          if (row.refType === "campaign" && Array.isArray(where.OR)) {
            return where.OR.some((clause) => {
              const c = clause as {
                refType?: string | null;
                refId?: { in?: string[] };
              };
              if (c.refType === "campaign" && Array.isArray(c.refId?.in)) {
                return c.refId.in.includes(row.refId ?? "");
              }
              return false;
            });
          }
          return true;
        });
        return filtered.slice(0, args.take);
      },
    },
    campaignStage: {
      async findMany(args) {
        return campaignStages
          .filter((s) => s.campaignId === args.where.campaignId)
          .map((s) => ({ id: s.id }));
      },
    },
    invitation: {
      async count(args) {
        return invitations.filter((inv) => {
          if (inv.campaignId !== args.where.campaignId) return false;
          if ("channel" in args.where && args.where.channel) {
            return inv.channel === args.where.channel;
          }
          return true;
        }).length;
      },
    },
  };
}

test("refreshLiveSnapshotWidgets refreshes campaign_list stats in place", async () => {
  const widgets = [
    makeWidget(
      "campaign_list",
      {
        items: [],
        filters: { status: ["draft", "active"], upcoming_only: false, limit: 10 },
      },
      { widgetKey: "campaigns.list" },
    ),
  ];
  const [next] = await refreshLiveSnapshotWidgets(
    { prismaLike: makePrisma() },
    { widgets, campaignScope: { id: { in: ["c-1", "c-2"] } }, isAdmin: true, now: NOW },
  );
  assert.equal(next.widgetKey, "campaigns.list");
  const items = next.props.items as Array<{
    id: string;
    stats: { total: number; responded: number; headcount: number };
  }>;
  assert.equal(items.length, 2);
  const summit = items.find((it) => it.id === "c-1");
  assert.deepEqual(summit?.stats, { total: 2, responded: 2, headcount: 3 });
});

test("refreshLiveSnapshotWidgets drops campaign_card when campaign is no longer visible", async () => {
  const widgets = [
    makeWidget(
      "campaign_card",
      { id: "c-1", name: "Stale" },
      { widgetKey: "campaign.c-1" },
    ),
  ];
  const next = await refreshLiveSnapshotWidgets(
    { prismaLike: makePrisma() },
    { widgets, campaignScope: { id: { in: ["c-2"] } }, isAdmin: false, now: NOW },
  );
  assert.equal(next.length, 0);
});

test("refreshLiveSnapshotWidgets refreshes activity_stream items from live EventLog", async () => {
  const widgets = [
    makeWidget(
      "activity_stream",
      { items: [], filters: { days: 7, limit: 5 } },
      { widgetKey: "activity.stream", slot: "secondary" },
    ),
  ];
  const [next] = await refreshLiveSnapshotWidgets(
    { prismaLike: makePrisma() },
    { widgets, campaignScope: { id: { in: ["c-1"] } }, isAdmin: false, now: NOW },
  );
  assert.equal(next.kind, "activity_stream");
  const items = next.props.items as Array<{ id: string; line: string }>;
  assert.equal(items.length, 2);
  assert.equal(items[0].id, "e-1");
});
