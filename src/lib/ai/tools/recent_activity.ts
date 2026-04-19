import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { phrase, type ActivityRecord } from "@/lib/activity";
import { ACTIVITY_STREAM_WIDGET_KEY } from "../widgetKeys";
import type { ToolDef, ToolResult } from "./types";

// The last N EventLog rows that this operator can see. Matches the
// scope discipline on the Overview page: admins see everything,
// non-admins see rows whose `refType` is not campaign-bound OR
// whose `refId` resolves to a campaign inside their team scope.
//
// EventLog has no `campaignId` column, so team scoping is
// implemented as "cap the list of visible campaign ids, then
// OR-filter on refType/refId" — identical pattern to
// `src/app/page.tsx`. We keep the 1000-id cap there too;
// without it a very large tenant could blow past Postgres's
// bound-parameter ceiling in the IN clause.
//
// Payload: each row is pre-rendered via `phrase()` so the same
// bilingual phrasing the Overview shows also reaches the model
// and the `activity_stream` widget. The raw `kind` + `data` are
// preserved for future richer rendering.
//
// The widget lands in the `secondary` slot — activity is contextual
// companion reading next to whatever `primary` is showing (a
// campaign card, a contact table). WidgetKey `activity.stream` is
// stable; re-invoking refreshes in place.

type Input = {
  days?: number;
  limit?: number;
};

const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const VISIBLE_CAMPAIGN_CAP = 1000;

export const recentActivityTool: ToolDef<Input> = {
  name: "recent_activity",
  description:
    "Return the most recent activity-log entries visible to the operator. Defaults to the last 7 days, capped at 20 rows. Scope-enforced: non-admins only see entries for campaigns in their team or office-wide, plus generic non-campaign events (logins, user admin, etc).",
  scope: "read",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      days: {
        type: "number",
        description: `Look-back window in days (1–${MAX_DAYS}). Defaults to ${DEFAULT_DAYS}.`,
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
    if (typeof r.days === "number" && Number.isFinite(r.days)) {
      out.days = Math.max(1, Math.min(MAX_DAYS, Math.floor(r.days)));
    }
    if (typeof r.limit === "number" && Number.isFinite(r.limit)) {
      out.limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(r.limit)));
    }
    return out;
  },
  async handler(input, ctx): Promise<ToolResult> {
    const days = input.days ?? DEFAULT_DAYS;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const since = new Date(Date.now() - days * 86_400_000);

    // For admins we skip the visible-id cap entirely; their where
    // clause is just the time window. Non-admins get the
    // OR-filtered refType/refId rule from the Overview.
    const visibleCampaignIds = ctx.isAdmin
      ? null
      : (
          await prisma.campaign.findMany({
            where: ctx.campaignScope,
            select: { id: true },
            orderBy: { updatedAt: "desc" },
            take: VISIBLE_CAMPAIGN_CAP,
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
                  notIn: [
                    "campaign",
                    "invitation",
                    "invitee",
                    "stage",
                    "response",
                  ],
                },
              },
              { refType: "campaign", refId: { in: visibleCampaignIds } },
            ],
          }),
    };

    const rows = await prisma.eventLog.findMany({
      where,
      include: { actor: { select: { email: true, fullName: true } } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const items = rows.map((row) => {
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
    });

    const lines: string[] = [];
    if (items.length === 0) {
      lines.push(`No activity in the last ${days} day${days === 1 ? "" : "s"}.`);
    } else {
      lines.push(
        `${items.length} activity row${items.length === 1 ? "" : "s"} (last ${days} day${days === 1 ? "" : "s"}):`,
      );
      for (const it of items) {
        lines.push(`- [${it.tone}] ${it.line}`);
      }
    }

    return {
      output: { summary: lines.join("\n"), count: items.length },
      widget: {
        widgetKey: ACTIVITY_STREAM_WIDGET_KEY,
        kind: "activity_stream",
        slot: "secondary",
        props: { items, filters: { days, limit } },
      },
    };
  },
};
