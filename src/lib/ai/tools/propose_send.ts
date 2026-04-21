import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasRole } from "@/lib/auth";
import { confirmSendWidgetKey } from "../widgetKeys";
import type { ToolDef, ToolResult } from "./types";
import { loadAudience, computeBlockers } from "./send-blockers";
import { deriveProposeSendPreview } from "./propose-send-preview";
import { campaignWantsWhatsAppDocument } from "@/lib/providers/whatsapp/sendPlan";
import { isPdfUploadContentType } from "@/lib/uploads";

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

// Channel vocabulary widened in P13-D.2 to match the runtime
// orchestrators and the shared `computeBlockers` helper. `"both"`
// is preserved as email+SMS only (pre-P13 invariant — every
// legacy caller passes "both" against an email/SMS-only contract),
// and `"all"` is the new umbrella that adds WhatsApp. Narrower
// scalars ("whatsapp") pick a single channel.
type Channel = "email" | "sms" | "whatsapp" | "both" | "all";

type Input = {
  campaign_id: string;
  channel?: Channel;
  only_unsent?: boolean;
};

const SUBJECT_PREVIEW_CHARS = 200;
const BODY_PREVIEW_CHARS = 280;

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
        enum: ["email", "sms", "whatsapp", "both", "all"],
        description:
          "Which channel(s) to preview. Defaults to `both`. `both` = email + SMS (pre-P13 invariant — does NOT include WhatsApp so legacy callers cannot silently start sending Meta-brokered messages on deploy). `all` = email + SMS + WhatsApp. Scalars (`email`, `sms`, `whatsapp`) pick one channel.",
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
    if (
      r.channel === "email" ||
      r.channel === "sms" ||
      r.channel === "whatsapp" ||
      r.channel === "both" ||
      r.channel === "all"
    ) {
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
        // WhatsApp template discipline: `computeBlockers` needs
        // both fields to emit `no_whatsapp_template` when the
        // channel set includes WhatsApp and the template is not
        // fully configured. Harmless for the email/SMS paths —
        // the blocker helper only reads these when the channel
        // set includes whatsapp. `templateWhatsAppVariables` is
        // the JSON-encoded positional-var array; a non-null value
        // that fails to parse surfaces `template_vars_malformed`
        // so the operator fixes the config before clicking send.
        templateWhatsAppName: true,
        templateWhatsAppLanguage: true,
        templateWhatsAppVariables: true,
        // P17-C.5 — doc-header FK. Used to check both "is a PDF
        // attached to this campaign?" (for the Will-attach-PDF
        // readiness line) and "does that FileUpload row still exist?"
        // (via `campaignWantsWhatsAppDocument` + a follow-up Prisma
        // lookup, feeding `computeBlockers`' `no_whatsapp_document`
        // gate).
        whatsappDocumentUploadId: true,
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

    // P17-C.5 — FileUpload lookup for the doc-header preview +
    // blocker. Only runs when `campaignWantsWhatsAppDocument` returns
    // true (campaign has both template fields AND an upload id set).
    // Selects `filename` + `contentType` — the widget needs the
    // filename for the "Will attach PDF: <name>" readiness line, and
    // the blocker layer now also rejects non-PDF uploads on the pilot
    // path. Bytes stay on disk until the actual delivery-edge upload
    // (P17-C.3). A null return (FileUpload deleted since the campaign
    // was configured) feeds the `no_whatsapp_document` blocker through
    // `computeBlockers` below, so the operator sees the problem in
    // ConfirmSend rather than hitting a wall of `doc_not_found`
    // per-invitation failures.
    let docUpload: { filename: string; contentType: string } | null = null;
    let docConfigured = false;
    if (
      campaignWantsWhatsAppDocument({
        whatsappDocumentUploadId: campaign.whatsappDocumentUploadId,
        templateWhatsAppName: campaign.templateWhatsAppName,
        templateWhatsAppLanguage: campaign.templateWhatsAppLanguage,
      })
    ) {
      docConfigured = true;
      docUpload = await prisma.fileUpload.findUnique({
        // The `!` is safe: the predicate above returned true only
        // when `whatsappDocumentUploadId` is non-null non-empty.
        where: { id: campaign.whatsappDocumentUploadId! },
        select: { filename: true, contentType: true },
      });
    }

    // Blockers via the shared helper — same codes send_campaign
    // enforces at confirm time, same ordering the directive
    // renders. If a new blocker type is added to the helper,
    // both the preview UI here and the server-side guard in
    // send_campaign pick it up automatically.
    //
    // `docUploadExists` is explicitly boolean when the campaign
    // wants a doc; undefined otherwise. The computeBlockers gate
    // treats undefined as "opted out" (no blocker), so a campaign
    // that doesn't use the doc-header path never even evaluates
    // the check. A campaign that DOES want the doc but whose
    // FileUpload row is missing (`docUpload === null`) surfaces
    // `no_whatsapp_document`.
    const blockers = computeBlockers({
      campaign: {
        status: campaign.status,
        templateEmail: campaign.templateEmail,
        templateSms: campaign.templateSms,
        templateWhatsAppName: campaign.templateWhatsAppName,
        templateWhatsAppLanguage: campaign.templateWhatsAppLanguage,
        templateWhatsAppVariables: campaign.templateWhatsAppVariables,
        whatsappDocumentUploadId: campaign.whatsappDocumentUploadId,
      },
      audience,
      channel,
      onlyUnsent,
      docUploadExists: docConfigured ? docUpload !== null : undefined,
      docUploadIsPdf:
        docConfigured && docUpload !== null
          ? isPdfUploadContentType(docUpload.contentType)
          : undefined,
    });

    // P14-E — the four post-audience-load derivations (per-channel
    // bucket fold + readyMessages sum + summary-line composition +
    // ready/blocked state ternary) live in `deriveProposeSendPreview`
    // so each transformation is unit-testable without prisma /
    // `loadAudience` / `computeBlockers`. The handler consumes the
    // produced fields and still composes the widget envelope + the
    // template_preview clipping + the WhatsApp template label (fields
    // that pull from the campaign row directly and aren't derivations
    // worth extracting).
    //
    // Sibling to P14-D' (`deriveSendCampaignSummary` in
    // send-campaign-summary.ts) — that file pins the POST-dispatch
    // summary; this one pins the PRE-dispatch preview. Structurally
    // symmetric.
    const preview = deriveProposeSendPreview({
      campaignName: campaign.name,
      campaignStatus: campaign.status,
      channel,
      onlyUnsent,
      audience,
      blockers,
    });

    // Preview snippets. These are server-side clipped so the
    // directive payload stays bounded; full bodies live on the
    // edit page.
    const clip = (s: string | null, max: number): string | null =>
      s ? s.trim().slice(0, max) : null;

    // WhatsApp template identity for the preview card. Unlike the
    // email / SMS bodies (which live on the Campaign row and render
    // verbatim), the actual WhatsApp template body lives on Meta's
    // side — campaigns store only the (name, language) pair that
    // identifies an approved template. The ConfirmSend card shows
    // these so the operator can sanity-check they picked the right
    // template; the rendered message content is a property of Meta's
    // approved copy, not ours. Null when either field is missing
    // (matches the `no_whatsapp_template` blocker predicate).
    const whatsAppTemplateLabel =
      campaign.templateWhatsAppName && campaign.templateWhatsAppLanguage
        ? {
            name: campaign.templateWhatsAppName,
            language: campaign.templateWhatsAppLanguage,
          }
        : null;

    // P17-C.5 — doc-header readiness label. Sibling to
    // `whatsAppTemplateLabel` above: a compact identity object the
    // ConfirmSend widget renders as a "Will attach PDF: <filename>"
    // line so the operator can sanity-check the right file is
    // attached before confirming. Null when either (a) the campaign
    // isn't wired for the doc-header path (predicate above returned
    // false, `docUpload` stayed null and `docConfigured` stayed
    // false) OR (b) the campaign IS wired but the FileUpload row
    // is missing — in the latter case, the blocker
    // `no_whatsapp_document` will already be in the blockers list,
    // so a null label here keeps the readiness line from rendering
    // and the operator sees the blocker instead.
    const whatsAppDocumentLabel =
      docUpload !== null && isPdfUploadContentType(docUpload.contentType)
        ? { filename: docUpload.filename }
        : null;

    const props = {
      campaign_id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      venue: campaign.venue,
      event_at: campaign.eventAt ? campaign.eventAt.toISOString() : null,
      locale: campaign.locale,
      channel,
      only_unsent: onlyUnsent,
      invitee_total: preview.inviteeCount,
      ready_messages: preview.readyMessages,
      by_channel: preview.buckets,
      template_preview: {
        subject_email: clip(campaign.subjectEmail, SUBJECT_PREVIEW_CHARS),
        email_body: clip(campaign.templateEmail, BODY_PREVIEW_CHARS),
        sms_body: clip(campaign.templateSms, BODY_PREVIEW_CHARS),
        whatsapp_template: whatsAppTemplateLabel,
        whatsapp_document: whatsAppDocumentLabel,
      },
      blockers,
      state: preview.state,
    };

    return {
      output: {
        id: campaign.id,
        name: campaign.name,
        channel,
        only_unsent: onlyUnsent,
        ready_messages: preview.readyMessages,
        invitee_total: preview.inviteeCount,
        blockers,
        summary: preview.summary,
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
