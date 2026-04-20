import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasRole } from "@/lib/auth";
import { sendCampaign } from "@/lib/campaigns";
import type { ToolDef, ToolResult } from "./types";
import { loadAudience, computeBlockers } from "./send-blockers";

// The destructive companion to `propose_send`. Same input shape; the
// difference is that this tool actually dispatches messages through
// the provider (email / sms) and flips campaign status draft|active →
// sending → active on success.
//
// Dispatch semantics — `scope: "destructive"` is load-bearing:
//   - On first invocation (from the model, unsolicited), the
//     dispatcher in `src/lib/ai/tools/index.ts:68-73` short-circuits
//     with a `needs_confirmation` error BEFORE the handler runs. The
//     chat route then either renders a `confirm_send` directive
//     (via a paired `propose_send` call the model should have made
//     first) or surfaces the error as a tool_result so the model
//     can recover.
//   - On operator-initiated invocation (confirm button click →
//     /api/chat/confirm/[messageId]), the route re-dispatches with
//     `allowDestructive: true` — the short-circuit is bypassed and
//     the handler runs for real.
// Importantly, this tool is NOT called by the model directly in the
// happy path. The model's role is to call `propose_send` (read), the
// operator's role is to click the button the ConfirmSend directive
// renders, and the confirm route's role is to translate that click
// into a `send_campaign` call with the destructive gate released.
//
// Scope duplication with propose_send is deliberate — `propose_send`
// is `scope: "read"` specifically so the dispatcher lets its handler
// run and produce preview data (a destructive scope would intercept
// it and prevent the preview). See the propose_send file-top comment
// for the long form.

// Channel vocabulary mirrors `propose_send`'s Input type and
// `SendCampaignChannel` in `@/lib/campaigns`. `"both"` is preserved
// as email+SMS (pre-P13 invariant); `"all"` is the umbrella that
// adds WhatsApp. Scalar values pick a single channel.
type Channel = "email" | "sms" | "whatsapp" | "both" | "all";

type Input = {
  campaign_id: string;
  channel?: Channel;
  only_unsent?: boolean;
};

export const sendCampaignTool: ToolDef<Input> = {
  name: "send_campaign",
  description:
    "Actually send a campaign's invitations. DESTRUCTIVE — requires operator confirmation. In normal flow the model does NOT call this directly: it calls `propose_send` to render a ConfirmSend directive, and the operator clicks the button to trigger this tool via the confirm route. The dispatcher short-circuits unsolicited calls with `needs_confirmation`. Role-gated: requires editor or admin. Status must be draft or active (sending / closed / archived are locked).",
  scope: "destructive",
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
          "Which channel(s) to send on. Defaults to `both`. `both` = email + SMS (pre-P13 invariant — legacy callers remain on two-channel semantics). `all` = email + SMS + WhatsApp. Scalars pick one channel. Mirrors `sendCampaign`'s `SendCampaignChannel` vocabulary.",
      },
      only_unsent: {
        type: "boolean",
        description:
          "If true (default), invitees with a prior successful invitation on the chosen channel are skipped. Set false to force a full re-send.",
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
    // Role gate mirrors `propose_send`. The confirm route also checks
    // auth up-front, but this gate is belt-and-braces — a future
    // direct-dispatch path (e.g. an admin CLI) should still be
    // refused on viewer credentials.
    if (!hasRole(ctx.user, "editor")) {
      return {
        output: {
          error: "forbidden",
          reason: "editor_role_required",
          summary: "Refused: operator has viewer permissions only.",
        },
      };
    }

    const channel: Channel = input.channel ?? "both";
    const onlyUnsent = input.only_unsent ?? true;

    // AND-compose with ctx.campaignScope so a non-admin trying to
    // send a campaign outside their team collapses to `not_found`.
    // Same discipline as `propose_send` / `campaign_detail`.
    //
    // Widened select: `templateEmail` / `templateSms` are read so
    // we can re-enforce propose_send's blockers below. Without
    // those fields we'd have to trust the client-side blocker
    // disable (see the "Blocker re-check" block further down).
    const where: Prisma.CampaignWhereInput = {
      AND: [ctx.campaignScope, { id: input.campaign_id }],
    };
    const campaign = await prisma.campaign.findFirst({
      where,
      select: {
        id: true,
        status: true,
        name: true,
        templateEmail: true,
        templateSms: true,
        // Needed by `computeBlockers` to emit `no_whatsapp_template`
        // when the channel set includes WhatsApp. Selected
        // unconditionally here (rather than gated on channel) so
        // the blocker helper's server-side re-check is complete
        // regardless of what `channel` the caller asked for — a
        // forged/rehydrated POST asking for "whatsapp" still hits
        // the blocker path correctly. `templateWhatsAppVariables`
        // feeds the same helper's `template_vars_malformed` gate
        // (mirrors the planner's Rule 1 inner parse step so a
        // malformed JSON config is refused at confirm time rather
        // than at provider dispatch).
        templateWhatsAppName: true,
        templateWhatsAppLanguage: true,
        templateWhatsAppVariables: true,
      },
    });
    if (!campaign) {
      return {
        output: {
          error: "not_found",
          id: input.campaign_id,
          summary: `Refused: campaign ${input.campaign_id} is not in this operator's scope.`,
        },
      };
    }

    // Status re-check. `sendCampaign` uses a CAS lock
    // (`src/lib/campaigns.ts:196-199`) so a bad status returns
    // `locked: true` rather than throwing. We still surface a clean
    // "not sendable" error when we can see it up-front — the
    // operator's Campaign status may have shifted between
    // `propose_send` (which renders ConfirmSend) and this confirm
    // click. Without this recheck the directive would say "ready"
    // and the send would no-op with `locked: true`, which is
    // technically correct but looks like a silent failure to the
    // operator.
    //
    // Kept as a dedicated `status_not_sendable` code (rather than
    // folding into the generic `blocked` path below) because the
    // confirm route's release-on-refusal whitelist has an entry
    // for this exact code — any rename would need a paired change
    // there. Keeping them separate also makes the audit stream
    // easy to filter: `data.error === "status_not_sendable"` is a
    // "wrong state" vs a "missing template" refusal.
    const sendableStatuses = new Set(["draft", "active"]);
    if (!sendableStatuses.has(campaign.status)) {
      return {
        output: {
          error: "status_not_sendable",
          status: campaign.status,
          summary: `Refused: campaign "${campaign.name}" is in status "${campaign.status}" — only draft or active can send.`,
        },
      };
    }

    // Blocker re-check. `propose_send` surfaces blockers
    // (`no_email_template`, `no_sms_template`, `no_invitees`,
    // `no_ready_messages`) to the ConfirmSend directive, which
    // disables the button. That client-side disable is NOT a
    // security boundary — a forged POST or a bad history
    // rehydrate could hit /api/chat/confirm pointing at a
    // blocked preview row. Without a server-side re-check,
    // sendCampaign falls back to default localized copy when a
    // template is missing (`src/lib/preview.ts:60-61,80` uses
    // `templateEmail || L.email.body`), so a blocked campaign
    // would still deliver real messages using the fallback
    // text. (GPT flagged this on the Push 7 fix review.)
    //
    // We consult the same `computeBlockers` helper propose_send
    // uses, so the two surfaces cannot drift — a new blocker
    // type gets rendered by propose_send AND enforced here in
    // the same commit.
    //
    // Status is filtered out — we already returned
    // `status_not_sendable` above for that case, and keeping
    // those two codes distinct is deliberate (see comment on
    // the status gate). Any remaining blocker becomes the
    // structured error code; the full list is attached so the
    // audit record / future UI can show them all.
    const audience = await loadAudience(campaign.id);
    const blockers = computeBlockers({
      campaign: {
        status: campaign.status,
        templateEmail: campaign.templateEmail,
        templateSms: campaign.templateSms,
        templateWhatsAppName: campaign.templateWhatsAppName,
        templateWhatsAppLanguage: campaign.templateWhatsAppLanguage,
        templateWhatsAppVariables: campaign.templateWhatsAppVariables,
      },
      audience,
      channel,
      onlyUnsent,
    });
    const nonStatusBlockers = blockers.filter(
      (b) => !b.startsWith("status_locked:"),
    );
    if (nonStatusBlockers.length > 0) {
      return {
        output: {
          error: nonStatusBlockers[0],
          blockers: nonStatusBlockers,
          summary: `Refused: "${campaign.name}" cannot be sent — ${nonStatusBlockers.join(", ")}.`,
        },
      };
    }

    // Actually send. `sendCampaign` handles the CAS lock, the
    // per-invitee fan-out, and the status transition back to active.
    // It throws only on DB / provider fatal errors; operational
    // misses (unsubscribed, missing contact, provider 4xx) are
    // counted as `failed` in the returned tally.
    const result = await sendCampaign(campaign.id, { channel, onlyUnsent });

    if (result.locked) {
      // Another send is in flight for the same campaign (CAS
      // failed). Surface cleanly so the operator can retry later.
      return {
        output: {
          error: "send_in_flight",
          summary: `Refused: a send is already in flight for "${campaign.name}". Try again in a moment.`,
        },
      };
    }

    // `total` is the sum of successful deliveries across all
    // dispatched channels. `sendCampaign`'s return gained a
    // `whatsapp: number` counter in P13-C (additive widening — old
    // callers ignoring unknown keys see no change); fold it in here
    // so the operator-visible tally matches what actually landed.
    const total = result.email + result.sms + result.whatsapp;
    const summaryLines: string[] = [];
    // Per-channel breakdown in the summary is only emitted for the
    // channels the caller asked for (so a `"whatsapp"` scalar send
    // doesn't say "0 email, 0 sms, N whatsapp"). The check uses the
    // same `channelSetFor` resolution `computeBlockers` and
    // `sendCampaign` use, keeping the three surfaces symmetric.
    const breakdown: string[] = [];
    if (channel === "email" || channel === "both" || channel === "all") {
      breakdown.push(`${result.email} email`);
    }
    if (channel === "sms" || channel === "both" || channel === "all") {
      breakdown.push(`${result.sms} sms`);
    }
    if (channel === "whatsapp" || channel === "all") {
      breakdown.push(`${result.whatsapp} whatsapp`);
    }
    summaryLines.push(
      `Sent ${total} message${total === 1 ? "" : "s"} for "${campaign.name}": ${breakdown.join(", ")}.`,
    );
    if (result.skipped > 0) summaryLines.push(`Skipped ${result.skipped}.`);
    if (result.failed > 0) {
      summaryLines.push(
        `Failed ${result.failed} — see the campaign's activity page for per-invitee errors.`,
      );
    }

    return {
      output: {
        id: campaign.id,
        name: campaign.name,
        channel,
        only_unsent: onlyUnsent,
        email: result.email,
        sms: result.sms,
        // Additive field — pre-P13 consumers reading only `email` /
        // `sms` / `skipped` / `failed` see identical behaviour on
        // two-channel sends (whatsapp stays 0). A `"whatsapp"` or
        // `"all"` send surfaces the counter so the confirm route's
        // outcome writer can persist it onto the widget blob and
        // the transcript can cite it.
        whatsapp: result.whatsapp,
        skipped: result.skipped,
        failed: result.failed,
        summary: summaryLines.join(" "),
      },
    };
  },
};
