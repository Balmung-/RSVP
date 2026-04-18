import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { campaignStats } from "@/lib/campaigns";
import { phrase, type ActivityRecord } from "@/lib/activity";
import type { ToolDef, ToolResult } from "./types";

// Deep-read for a single campaign. Used when the operator asks
// "tell me about X" or drills into a row from the list. Returns
// the campaign's core fields, the full stats block, and the last
// 10 activity-log entries that concern it — rendered as a
// `campaign_card` directive on the client.
//
// Scope discipline: the campaign is looked up under AND-composed
// `ctx.campaignScope`. If the id resolves to a campaign outside
// the operator's team scope, the tool returns `not_found` rather
// than leaking the id's existence. NEVER trust `id` at face
// value — the model obtains it from `list_campaigns` which is
// already scope-enforced, but a malicious or confused model
// could still try a bare cuid.
//
// Activity rows: EventLog has no campaignId column, so we filter
// via `refType: "campaign", refId: <id>`. That matches the
// overview page's pattern.

type Input = { id: string };

const ACTIVITY_LIMIT = 10;

export const campaignDetailTool: ToolDef<Input> = {
  name: "campaign_detail",
  description:
    "Fetch a single campaign's details: name, status, venue, event date, full stats (invitees / responded / attending / guests / headcount / delivery counts) and the last 10 activity entries. Scope-enforced: non-admins only see campaigns in their team or office-wide.",
  scope: "read",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: {
        type: "string",
        description:
          "The campaign id. Obtain from `list_campaigns` — never paste from the operator's message.",
      },
    },
  },
  validate(raw): Input {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("expected_object");
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id.length === 0) {
      throw new Error("id:string_required");
    }
    return { id: r.id };
  },
  async handler(input, ctx): Promise<ToolResult> {
    // AND-compose: the id filter lives inside the same where as
    // the scope fragment. Two-step would be: (1) fetch row by id,
    // (2) separately re-check scope. One-step with AND preserves
    // team scoping atomically and avoids the intermediate leak
    // where "we found it, but you can't see it" becomes a
    // distinguishable response from "it doesn't exist". Both
    // collapse to `not_found` here.
    const where: Prisma.CampaignWhereInput = {
      AND: [ctx.campaignScope, { id: input.id }],
    };
    const campaign = await prisma.campaign.findFirst({
      where,
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
    if (!campaign) {
      return {
        output: { error: "not_found", id: input.id },
      };
    }

    const [stats, activityRows] = await Promise.all([
      campaignStats(campaign.id),
      prisma.eventLog.findMany({
        where: { refType: "campaign", refId: campaign.id },
        include: { actor: { select: { email: true, fullName: true } } },
        orderBy: { createdAt: "desc" },
        take: ACTIVITY_LIMIT,
      }),
    ]);

    // Pre-render activity lines server-side using `phrase()` —
    // this is the same helper the Overview and campaign detail
    // pages use, so bilingual phrasing stays consistent. We pass
    // the `tone` through; the directive renderer paints the dot.
    const activity = activityRows.map((row) => {
      const p = phrase(row as unknown as ActivityRecord);
      return {
        id: row.id,
        created_at: row.createdAt.toISOString(),
        kind: row.kind,
        tone: p.tone,
        line: p.line,
      };
    });

    const detail = {
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
      activity,
    };

    // Compact text summary for the model. Date ISO; client
    // formats per locale. Stats summarized as a single line so
    // the model doesn't recite every field.
    const when = detail.event_at ?? "no-date";
    const venue = detail.venue ? ` @ ${detail.venue}` : "";
    const lines: string[] = [];
    lines.push(`${detail.name} [${detail.status}] ${when}${venue}`);
    lines.push(
      `Stats: ${stats.responded}/${stats.total} responded, ${stats.attending} attending + ${stats.guests} guests = ${stats.headcount} headcount. Sent: ${stats.sentEmail} email / ${stats.sentSms} sms.`,
    );
    if (activity.length > 0) {
      lines.push(`${activity.length} recent activity rows attached.`);
    }

    return {
      output: { summary: lines.join("\n"), id: detail.id },
      directive: {
        kind: "campaign_card",
        props: detail,
      },
    };
  },
};
