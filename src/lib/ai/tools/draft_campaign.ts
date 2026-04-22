import { prisma } from "@/lib/db";
import { hasRole } from "@/lib/auth";
import { teamsEnabled, teamIdsForUser } from "@/lib/teams";
import { confirmDraftWidgetKey } from "../widgetKeys";
import type { ToolDef, ToolResult } from "./types";

// Creates a draft Campaign row from a small set of human-shaped
// fields (name, optional venue, event date, description, locale,
// team). Mirrors the guards in `src/app/campaigns/new/page.tsx` so
// AI-initiated drafts land in the same shape as editor-created ones.
//
// On success the handler emits a `confirm_draft` widget into the
// `action` slot, keyed by `confirm.draft.${id}` — one card per
// draft so multiple drafts created in the same session coexist.
// The operator clicks through to the edit page from the card;
// there's no destructive follow-up to anchor against (the draft is
// already persisted), so the widget is purely informational.
//
//   - `editor` role is required. Viewers are rejected with a
//     structured `forbidden` output that the model can explain to
//     the operator — no throw, so the chat loop keeps its footing.
//   - `teamId` must resolve to a team the user actually belongs to
//     (admins pass through). Without this guard an editor could
//     orphan a draft into someone else's team by hallucinating an
//     id, defeating `scopedCampaignWhere`.
//   - `locale` defaults to `ctx.locale` so the draft inherits the
//     operator's current admin locale — the existing create page
//     does the same via form default.
//
// The rest of the campaign fields (templates, branding, subject,
// stages) are intentionally left for the operator to fill on the
// edit page. Drafts are meant to be a 10-second capture — the AI
// has just enough to give the operator a starting row.

type Input = {
  name: string;
  description?: string;
  venue?: string;
  event_at?: string;
  locale?: "en" | "ar";
  team_id?: string;
};

const MAX_NAME = 200;
const MAX_VENUE = 200;
const MAX_DESCRIPTION = 2000;

export const draftCampaignTool: ToolDef<Input> = {
  name: "draft_campaign",
  description:
    "Create a new campaign in draft status. Requires at minimum a name; accepts optional venue, event date (ISO 8601), description, locale (en|ar), and team id. Returns the new campaign's id and a card so the operator can open the draft for further editing. Role-gated: requires editor or admin. Non-admins can only assign the draft to a team they belong to.",
  scope: "write",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: {
        type: "string",
        description: `Campaign title, 1–${MAX_NAME} characters. Required.`,
      },
      description: {
        type: "string",
        description: `Optional short description, up to ${MAX_DESCRIPTION} characters.`,
      },
      venue: {
        type: "string",
        description: `Optional venue string, up to ${MAX_VENUE} characters.`,
      },
      event_at: {
        type: "string",
        description:
          "Optional ISO 8601 datetime for the event (e.g. 2026-04-20T18:00:00Z or 2026-04-20T21:00:00+03:00). Malformed values are ignored rather than rejected.",
      },
      locale: {
        type: "string",
        enum: ["en", "ar"],
        description:
          "Primary locale for the campaign. Defaults to the operator's current admin locale.",
      },
      team_id: {
        type: "string",
        description:
          "Optional team id to scope the draft. Obtain from `list_campaigns` output or context; non-admins can only use teams they belong to. Omit to create an office-wide draft.",
      },
    },
  },
  validate(raw): Input {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("expected_object");
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.name !== "string" || r.name.trim().length === 0) {
      throw new Error("name:string_required");
    }
    const out: Input = { name: r.name };
    if (typeof r.description === "string") out.description = r.description;
    if (typeof r.venue === "string") out.venue = r.venue;
    if (typeof r.event_at === "string") out.event_at = r.event_at;
    if (r.locale === "en" || r.locale === "ar") out.locale = r.locale;
    if (typeof r.team_id === "string" && r.team_id.length > 0) {
      out.team_id = r.team_id;
    }
    return out;
  },
  async handler(input, ctx): Promise<ToolResult> {
    // Role gate. `hasRole(user, "editor")` is true for editor + admin
    // (see `ROLE_RANK` in `src/lib/auth.ts`). Viewers get a structured
    // forbidden instead of a throw so the model can explain and the
    // chat loop keeps its footing.
    if (!hasRole(ctx.user, "editor")) {
      return {
        output: {
          error: "forbidden",
          reason: "editor_role_required",
          summary:
            "Cannot create a draft: this operator has viewer permissions only.",
        },
      };
    }

    // Team gate. Same pattern as `src/app/campaigns/new/page.tsx`:
    // admins may assign any team; non-admins are restricted to teams
    // they belong to. A hallucinated id from a non-admin collapses to
    // `forbidden` rather than silently nulling the team — otherwise
    // the model could "work around" scoping by omitting team_id and
    // the draft would land office-wide instead of where the operator
    // expected.
    let teamId: string | null = null;
    if (input.team_id && teamsEnabled()) {
      if (ctx.isAdmin) {
        teamId = input.team_id;
      } else {
        const allowed = new Set(await teamIdsForUser(ctx.user.id, ctx.user.activeTenantId ?? null));
        if (!allowed.has(input.team_id)) {
          return {
            output: {
              error: "forbidden",
              reason: "team_not_allowed",
              team_id: input.team_id,
              summary:
                "Cannot assign draft to that team: operator is not a member.",
            },
          };
        }
        teamId = input.team_id;
      }
    }

    // Parse event_at. `new Date(iso)` handles both `Z` and `+HH:MM`
    // offsets correctly; NaN means we couldn't parse the string and
    // we'd rather drop the field than 400 the whole call. The model
    // gets back `event_at_ignored: true` so it can decide to retry.
    let eventAt: Date | null = null;
    let eventAtIgnored = false;
    if (input.event_at) {
      const d = new Date(input.event_at);
      if (Number.isNaN(d.getTime())) {
        eventAtIgnored = true;
      } else {
        eventAt = d;
      }
    }

    const name = input.name.trim().slice(0, MAX_NAME);
    const description =
      input.description?.trim().slice(0, MAX_DESCRIPTION) || null;
    const venue = input.venue?.trim().slice(0, MAX_VENUE) || null;
    const locale: "en" | "ar" = input.locale ?? ctx.locale;

    const created = await prisma.campaign.create({
      data: {
        tenantId: ctx.user.activeTenantId!,
        name,
        description,
        venue,
        eventAt,
        locale,
        status: "draft",
        teamId,
      },
      select: {
        id: true,
        name: true,
        description: true,
        venue: true,
        eventAt: true,
        locale: true,
        status: true,
        teamId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const summaryLines: string[] = [];
    summaryLines.push(
      `Created draft campaign "${created.name}" (id ${created.id}).`,
    );
    if (created.eventAt) {
      summaryLines.push(`Event at: ${created.eventAt.toISOString()}.`);
    }
    if (created.venue) summaryLines.push(`Venue: ${created.venue}.`);
    if (eventAtIgnored) {
      summaryLines.push(
        `Note: event_at was malformed and ignored. Set it on the edit page or call again with ISO 8601.`,
      );
    }
    summaryLines.push(
      `Open /campaigns/${created.id} to edit details, attach templates, and schedule stages.`,
    );

    const props = {
      id: created.id,
      name: created.name,
      description: created.description,
      venue: created.venue,
      event_at: created.eventAt ? created.eventAt.toISOString() : null,
      locale: created.locale,
      status: created.status,
      team_id: created.teamId,
      created_at: created.createdAt.toISOString(),
      event_at_ignored: eventAtIgnored,
      // W5 — drafts are terminal-on-creation: the row is already in
      // the DB by the time this widget emits, so the only valid state
      // is `done`. The renderer uses this to match the confirm_send
      // state-machine branch instead of hard-coding a per-kind cue.
      state: "done" as const,
    };

    return {
      output: {
        id: created.id,
        name: created.name,
        status: created.status,
        event_at_ignored: eventAtIgnored,
        summary: summaryLines.join("\n"),
      },
      widget: {
        widgetKey: confirmDraftWidgetKey(created.id),
        kind: "confirm_draft",
        slot: "action",
        props,
      },
    };
  },
};
