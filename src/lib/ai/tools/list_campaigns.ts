import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { bulkCampaignStats } from "@/lib/campaigns";
import { CAMPAIGNS_LIST_WIDGET_KEY } from "../widgetKeys";
import type { ToolDef, ToolResult } from "./types";

// First real tool: enumerate campaigns the operator can see, with
// headline stats. Read-only, scope-enforced: the ctx.campaignScope
// fragment (produced by scopedCampaignWhere) is AND-ed into the
// prisma WHERE so non-admins on a team only ever see their team's
// campaigns plus office-wide (teamId=null) ones.
//
// The handler returns BOTH a compact text summary for the model
// (feeds back as tool_result content, so the model can phrase things
// naturally) AND a `campaign_list` workspace widget the client pins
// into the `primary` dashboard slot. The model doesn't have to
// narrate every field — the UI carries the weight.
//
// WidgetKey `campaigns.list` is stable — re-invoking the tool UPSERTS
// in place, so an operator refining "only upcoming" replaces the old
// list rather than stacking a second card. If the tool later needs to
// fan out per-filter lists they'd each pick their own key.
//
// Input shape is hand-written JSON Schema (not zod). Optional runtime
// validate() coerces strings / numbers and clamps the limit.

type CampaignStatus = "draft" | "active" | "sending" | "closed" | "archived";

type Input = {
  status?: CampaignStatus[];
  upcoming_only?: boolean;
  limit?: number;
};

const ALL_STATUSES: readonly CampaignStatus[] = [
  "draft",
  "active",
  "sending",
  "closed",
  "archived",
];
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const DEFAULT_STATUSES: CampaignStatus[] = ["draft", "active", "sending"];

// Pure WHERE-clause builder, exported so the Push 2 regression can be
// unit-tested without spinning up Prisma. Composition is AND — never
// object-spread — so the team-scope OR in `ctx.campaignScope` is NOT
// clobbered when `upcoming_only` adds its own OR clause. (Spreading
// two OR-keyed objects drops the first one silently, which is
// exactly the leak that shipped and was fixed here.)
export function buildListCampaignsWhere(
  input: Pick<Input, "status" | "upcoming_only">,
  ctx: { campaignScope: Prisma.CampaignWhereInput },
  now: Date = new Date(),
): Prisma.CampaignWhereInput {
  const statuses = input.status ?? DEFAULT_STATUSES;
  const andClauses: Prisma.CampaignWhereInput[] = [
    ctx.campaignScope,
    { status: { in: statuses } },
  ];
  if (input.upcoming_only) {
    andClauses.push({
      OR: [{ eventAt: null }, { eventAt: { gte: now } }],
    });
  }
  return { AND: andClauses };
}

export const listCampaignsTool: ToolDef<Input> = {
  name: "list_campaigns",
  description:
    "List campaigns the current user can see, optionally filtered by status or to upcoming events only. Returns name, status, event date, venue, and headline stats (total invitees, responded count, headcount including guests). Scope is enforced server-side.",
  scope: "read",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      status: {
        type: "array",
        items: {
          type: "string",
          enum: ["draft", "active", "sending", "closed", "archived"],
        },
        description:
          "Campaign statuses to include. Defaults to [draft, active, sending] when omitted.",
      },
      upcoming_only: {
        type: "boolean",
        description:
          "When true, only campaigns whose eventAt is in the future (or null) are returned. Useful for 'what's coming up' queries.",
      },
      limit: {
        type: "number",
        description: `Max rows to return (1–${MAX_LIMIT}). Defaults to ${DEFAULT_LIMIT}.`,
      },
    },
  },
  validate(raw): Input {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("expected_object");
    }
    const r = raw as Record<string, unknown>;
    const out: Input = {};
    if (Array.isArray(r.status)) {
      const picked = r.status.filter(
        (s): s is CampaignStatus =>
          typeof s === "string" && (ALL_STATUSES as readonly string[]).includes(s),
      );
      if (picked.length) out.status = picked;
    }
    if (typeof r.upcoming_only === "boolean") out.upcoming_only = r.upcoming_only;
    if (typeof r.limit === "number" && Number.isFinite(r.limit)) {
      out.limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(r.limit)));
    }
    return out;
  },
  async handler(input, ctx): Promise<ToolResult> {
    const statuses = input.status ?? DEFAULT_STATUSES;
    const limit = input.limit ?? DEFAULT_LIMIT;

    // WHERE composed by the pure `buildListCampaignsWhere` helper so
    // the Push 2 scope-leak regression is covered by a unit test.
    const where = buildListCampaignsWhere(input, ctx);

    const campaigns = await prisma.campaign.findMany({
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

    const statsById = await bulkCampaignStats(campaigns.map((c) => c.id));

    const items = campaigns.map((c) => {
      const s = statsById.get(c.id) ?? { total: 0, responded: 0, headcount: 0 };
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        event_at: c.eventAt ? c.eventAt.toISOString() : null,
        venue: c.venue,
        team_id: c.teamId,
        stats: {
          total: s.total,
          responded: s.responded,
          headcount: s.headcount,
        },
      };
    });

    // Compact text summary for the model. One campaign per line;
    // dates are ISO (UTC) — the model will reformat per locale.
    const lines: string[] = [];
    if (items.length === 0) {
      lines.push(
        input.upcoming_only
          ? "No upcoming campaigns match the current scope + filters."
          : "No campaigns match the current scope + filters.",
      );
    } else {
      lines.push(`${items.length} campaign${items.length === 1 ? "" : "s"}:`);
      for (const it of items) {
        const when = it.event_at ?? "no-date";
        const venue = it.venue ? ` @ ${it.venue}` : "";
        lines.push(
          `- ${it.name} [${it.status}] ${when}${venue} — ${it.stats.responded}/${it.stats.total} responded, ${it.stats.headcount} headcount`,
        );
      }
    }

    const props = {
      items,
      filters: {
        status: statuses,
        upcoming_only: Boolean(input.upcoming_only),
        limit,
      },
    };

    return {
      output: { summary: lines.join("\n"), count: items.length },
      widget: {
        widgetKey: CAMPAIGNS_LIST_WIDGET_KEY,
        kind: "campaign_list",
        slot: "primary",
        props,
      },
    };
  },
};
