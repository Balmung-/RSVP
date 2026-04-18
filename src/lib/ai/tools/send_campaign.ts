import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasRole } from "@/lib/auth";
import { sendCampaign } from "@/lib/campaigns";
import type { ToolDef, ToolResult } from "./types";

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

type Channel = "email" | "sms" | "both";

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
        enum: ["email", "sms", "both"],
        description:
          "Which channel(s) to send on. Defaults to `both`. Mirrors `sendCampaign`'s semantics.",
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
    if (r.channel === "email" || r.channel === "sms" || r.channel === "both") {
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
    const where: Prisma.CampaignWhereInput = {
      AND: [ctx.campaignScope, { id: input.campaign_id }],
    };
    const campaign = await prisma.campaign.findFirst({
      where,
      select: { id: true, status: true, name: true },
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

    const total = result.email + result.sms;
    const summaryLines: string[] = [];
    summaryLines.push(
      `Sent ${total} message${total === 1 ? "" : "s"} for "${campaign.name}": ${result.email} email, ${result.sms} sms.`,
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
        skipped: result.skipped,
        failed: result.failed,
        summary: summaryLines.join(" "),
      },
    };
  },
};
