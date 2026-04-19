import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasRole } from "@/lib/auth";
import { confirmSendWidgetKey } from "../widgetKeys";
import type { ToolDef, ToolResult } from "./types";
import { loadAudience, computeBlockers } from "./send-blockers";

// Previews what `sendCampaign` WOULD do, without doing it. The
// model calls this to resolve an audience + template + count
// before asking the operator for confirmation. The `confirm_send`
// widget this emits carries every field `/api/chat/confirm`
// (Push 7) will need to re-dispatch the actual destructive
// send — campaign_id, channel, only_unsent — plus a preview the
// operator can sanity-check before clicking.
//
// WidgetKey `confirm.send.${campaign_id}` — one in-flight confirm
// per campaign. A second propose_send for the same campaign upserts
// (refreshes preview with latest audience counts) rather than
// stacking a duplicate `action` card. The confirm route reads the
// stored `toolInput` off the ChatMessage anchor row the widget
// points at via `sourceMessageId` — stream of custody stays
// server-side.
//
// Scope note — this tool is `scope: "read"` despite its name. It
// reads the campaign, counts invitees, and reports blockers; it
// never writes. The destructive edge is one step later, when the
// operator clicks the confirm button in `<ConfirmSend/>` and the
// confirm route re-dispatches a separate `send_campaign`-class
// tool with `allowDestructive: true`. Marking propose_send as
// "destructive" would have the dispatcher short-circuit its
// handler, so the preview data could never be computed. See
// `src/lib/ai/tools/index.ts:66-72` for the interception rule
// and the Push 6c notepad entry for this design decision.
//
// Counting discipline — we mirror `sendCampaign`'s job-planning
// loop line-for-line (`src/lib/campaigns.ts:218-229`) so the
// preview matches what the real send will emit. Drift here would
// mean the operator confirms "send 47" and the provider actually
// sends 52, which is the exact trust hole the confirmation gate
// exists to close. We also cross-check the `unsubscribe` table
// up-front — sendCampaign filters unsubscribes INSIDE
// `sendEmail/sendSms`, counting them as send-failures after the
// fact; for a preview we want the number the operator sees to be
// the number that actually lands, so unsubscribed contacts are
// subtracted from the ready count and reported separately.

type Channel = "email" | "sms" | "both";

type Input = {
  campaign_id: string;
  channel?: Channel;
  only_unsent?: boolean;
};

const SUBJECT_PREVIEW_CHARS = 200;
const BODY_PREVIEW_CHARS = 280;

type ChannelBreakdown = {
  ready: number;
  skipped_already_sent: number;
  skipped_unsubscribed: number;
  no_contact: number;
};

export const proposeSendTool: ToolDef<Input> = {
  name: "propose_send",
  description:
    "Preview what a campaign send would do, without sending. Resolves the audience under the operator's scope, counts invitees per channel (ready / already-sent / unsubscribed / no-contact), and emits a `confirm_send` directive the operator can review before clicking confirm. DOES NOT send — the destructive send happens on a separate confirm click. Role-gated: requires editor or admin.",
  scope: "read",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["campaign_id"],
    properties: {
      campaign_id: {
        type: "string",
        description:
          "The campaign id. Obtain from `list_campaigns` or `campaign_detail` — never paste from the operator's message.",
      },
      channel: {
        type: "string",
        enum: ["email", "sms", "both"],
        description:
          "Which channel(s) to preview. Defaults to `both`. Matches `sendCampaign`'s channel semantics.",
      },
      only_unsent: {
        type: "boolean",
        description:
          "If true (default), invitees who already have a successful invitation on the chosen channel are counted as skipped. Set false to preview a full re-send.",
      },
    },
  },
  validate(raw): Input {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("expected_object");
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.campaign_id !== "string" || r.campaign_id.length === 0) {
      throw new Error("campaign_id:string_required");
    }
    const out: Input = { campaign_id: r.campaign_id };
    if (r.channel === "email" || r.channel === "sms" || r.channel === "both") {
      out.channel = r.channel;
    }
    if (typeof r.only_unsent === "boolean") out.only_unsent = r.only_unsent;
    return out;
  },
  async handler(input, ctx): Promise<ToolResult> {
    // Role gate: only editors/admins can even PROPOSE a send. A
    // viewer seeing a ConfirmSend they couldn't actually confirm
    // would be worse than a clean refusal.
    if (!hasRole(ctx.user, "editor")) {
      return {
        output: {
          error: "forbidden",
          reason: "editor_role_required",
          summary:
            "Cannot propose a send: this operator has viewer permissions only.",
        },
      };
    }

    const channel: Channel = input.channel ?? "both";
    const onlyUnsent = input.only_unsent ?? true;

    // AND-compose with ctx.campaignScope so a non-admin asking
    // about a campaign outside their team collapses to
    // `not_found`. Same discipline as campaign_detail.
    const where: Prisma.CampaignWhereInput = {
      AND: [ctx.campaignScope, { id: input.campaign_id }],
    };
    const campaign = await prisma.campaign.findFirst({
      where,
      select: {
        id: true,
        name: true,
        status: true,
        eventAt: true,
        venue: true,
        locale: true,
        subjectEmail: true,
        templateEmail: true,
        templateSms: true,
        teamId: true,
      },
    });
    if (!campaign) {
      return {
        output: { error: "not_found", id: input.campaign_id },
      };
    }

    // Audience + unsubscribes via the shared helper. Same query
    // shape sendCampaign uses, so counts here match what the real
    // send will emit byte-for-byte. Helper is also consulted below
    // (by `computeBlockers`) and by `send_campaign` at confirm
    // time — single source of truth for both surfaces.
    const audience = await loadAudience(campaign.id);
    const { invitees, unsubEmails, unsubPhones } = audience;

    const emailBucket: ChannelBreakdown = {
      ready: 0,
      skipped_already_sent: 0,
      skipped_unsubscribed: 0,
      no_contact: 0,
    };
    const smsBucket: ChannelBreakdown = {
      ready: 0,
      skipped_already_sent: 0,
      skipped_unsubscribed: 0,
      no_contact: 0,
    };

    for (const inv of invitees) {
      const hasEmailSent = inv.invitations.some(
        (x) => x.channel === "email" && x.status !== "failed",
      );
      const hasSmsSent = inv.invitations.some(
        (x) => x.channel === "sms" && x.status !== "failed",
      );
      if (channel === "email" || channel === "both") {
        if (!inv.email) {
          emailBucket.no_contact += 1;
        } else if (onlyUnsent && hasEmailSent) {
          emailBucket.skipped_already_sent += 1;
        } else if (unsubEmails.has(inv.email)) {
          emailBucket.skipped_unsubscribed += 1;
        } else {
          emailBucket.ready += 1;
        }
      }
      if (channel === "sms" || channel === "both") {
        if (!inv.phoneE164) {
          smsBucket.no_contact += 1;
        } else if (onlyUnsent && hasSmsSent) {
          smsBucket.skipped_already_sent += 1;
        } else if (unsubPhones.has(inv.phoneE164)) {
          smsBucket.skipped_unsubscribed += 1;
        } else {
          smsBucket.ready += 1;
        }
      }
    }

    // `ready_messages` is a JOB count — one `(invitee, channel)`
    // pair is one job, matching `sendCampaign`'s planner
    // (`src/lib/campaigns.ts:218-229`) which enqueues one message
    // per pair. An invitee on channel=both with both email and SMS
    // contributes 2 to this count, not 1. Naming reflects the
    // semantics: operators see `Messages ready: 2` next to
    // `Invitees: 1` and know the card is describing sends, not
    // heads. Documented here because the previous name
    // `ready_total` was ambiguous and the ConfirmSend copy framed
    // the same number as a recipient count (GPT, Push 6c review).
    const readyMessages = emailBucket.ready + smsBucket.ready;

    // Blockers via the shared helper — same codes send_campaign
    // enforces at confirm time, same ordering the directive
    // renders. If a new blocker type is added to the helper,
    // both the preview UI here and the server-side guard in
    // send_campaign pick it up automatically.
    const blockers = computeBlockers({
      campaign: {
        status: campaign.status,
        templateEmail: campaign.templateEmail,
        templateSms: campaign.templateSms,
      },
      audience,
      channel,
      onlyUnsent,
    });

    // Preview snippets. These are server-side clipped so the
    // directive payload stays bounded; full bodies live on the
    // edit page.
    const clip = (s: string | null, max: number): string | null =>
      s ? s.trim().slice(0, max) : null;

    const summaryLines: string[] = [];
    summaryLines.push(
      `Propose send for "${campaign.name}" [${campaign.status}]: channel=${channel}, only_unsent=${onlyUnsent}.`,
    );
    summaryLines.push(
      `${invitees.length} invitee${invitees.length === 1 ? "" : "s"}; ${readyMessages} message${readyMessages === 1 ? "" : "s"} ready to send (email ${emailBucket.ready}, sms ${smsBucket.ready}).`,
    );
    if (
      emailBucket.skipped_already_sent +
        smsBucket.skipped_already_sent +
        emailBucket.skipped_unsubscribed +
        smsBucket.skipped_unsubscribed >
      0
    ) {
      summaryLines.push(
        `Skipped: already-sent ${emailBucket.skipped_already_sent + smsBucket.skipped_already_sent}, unsubscribed ${emailBucket.skipped_unsubscribed + smsBucket.skipped_unsubscribed}.`,
      );
    }
    if (blockers.length > 0) {
      summaryLines.push(`Blockers: ${blockers.join(", ")}.`);
    }
    summaryLines.push(
      `A ConfirmSend card has been rendered. The operator must click Confirm to actually send — this tool does not send.`,
    );

    // W5 — pre-terminal state. `ready` when the operator can click
    // confirm right now; `blocked` when one or more blockers must be
    // resolved first. The confirm route rewrites this to `done` or
    // `error` after dispatch (see `markConfirmSendOutcome` in
    // `src/app/api/chat/confirm/[messageId]/route.ts`). The same
    // validator rejects `submitting` as a persisted state — that one
    // is client-local during the POST window and never hits the DB.
    const state: "ready" | "blocked" = blockers.length > 0 ? "blocked" : "ready";

    const props = {
      campaign_id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      venue: campaign.venue,
      event_at: campaign.eventAt ? campaign.eventAt.toISOString() : null,
      locale: campaign.locale,
      channel,
      only_unsent: onlyUnsent,
      invitee_total: invitees.length,
      ready_messages: readyMessages,
      by_channel: {
        email: emailBucket,
        sms: smsBucket,
      },
      template_preview: {
        subject_email: clip(campaign.subjectEmail, SUBJECT_PREVIEW_CHARS),
        email_body: clip(campaign.templateEmail, BODY_PREVIEW_CHARS),
        sms_body: clip(campaign.templateSms, BODY_PREVIEW_CHARS),
      },
      blockers,
      state,
    };

    return {
      output: {
        id: campaign.id,
        name: campaign.name,
        channel,
        only_unsent: onlyUnsent,
        ready_messages: readyMessages,
        invitee_total: invitees.length,
        blockers,
        summary: summaryLines.join("\n"),
      },
      widget: {
        widgetKey: confirmSendWidgetKey(campaign.id),
        kind: "confirm_send",
        slot: "action",
        props,
      },
    };
  },
};
