import { channelSetFor } from "@/lib/campaigns";
import type { Audience } from "./send-blockers";

// Pure derivations from a pre-loaded audience + pre-computed blocker
// list into the per-channel breakdown, ready-message count, summary
// lines, and ready/blocked state that `propose_send.ts`'s handler
// emits on its widget props + output.summary. Extracted so the bucket
// fold, the `readyMessages` sum, the summary-line composition, and
// the state ternary are unit-testable without prisma / `loadAudience`
// / `computeBlockers`.
//
// Sibling to `send-campaign-summary.ts` (P14-D'). That file pins the
// POST-dispatch summary derivation; this one pins the PRE-dispatch
// preview derivation — structurally symmetric, same extraction
// pattern, same byte-for-byte behaviour preservation discipline.
//
// Four distinct transformations the handler does post-audience-load:
//
//   1. Per-invitee, per-channel bucket fold — each invitee falls into
//      EXACTLY ONE of four buckets per wanted channel:
//        { ready, skipped_already_sent, skipped_unsubscribed, no_contact }
//      Precedence (matches sendCampaign's planner byte-for-byte):
//        no_contact → skipped_already_sent → skipped_unsubscribed → ready
//      A regression flipping the precedence would mis-bucket a
//      recipient who is BOTH already-sent AND unsubscribed: currently
//      that's skipped_already_sent (first gate wins), and swapping
//      would paint them as skipped_unsubscribed — misleading the
//      operator about WHY the recipient was skipped.
//
//   2. Channel-filter gating — a bucket only accumulates if the
//      caller's `channel` input includes that bucket's channel via
//      `channelSetFor`. `"both"` is the pre-P13 vocabulary (email +
//      SMS only) and must NOT silently widen to include WhatsApp.
//      A regression that unconditionally ran all three filters would
//      paint "0 whatsapp" on a scalar "email" send — confusing about
//      whether WhatsApp was considered at all.
//
//   3. `readyMessages` sum — `email.ready + sms.ready + whatsapp.ready`.
//      This is a JOB count (one (invitee, channel) pair = one job),
//      matching sendCampaign's planner. An invitee on channel=all
//      with email + phone contributes 3. A regression dropping the
//      WhatsApp bucket would under-count the operator-facing ready
//      count on "all" / "whatsapp" sends.
//
//   4. Summary-line composition — four possible lines, with the
//      `readyParts` per-channel segment filtered to include only
//      requested channels, conditional `Skipped` line on
//      `alreadySent + unsubscribed > 0`, conditional `Blockers` line
//      on `blockers.length > 0`, and an always-emitted ConfirmSend
//      tail pointer.
//
// Intentionally does NOT cover:
//
//   - The role / scope gates that run BEFORE audience load (belong
//     to the route layer).
//   - The `not_found` refusal shape (fixed literal, not a derivation).
//   - The `computeBlockers` call itself (already extracted + tested in
//     `send-blockers.ts` + `send-blockers-whatsapp.test.ts`).
//   - The `loadAudience` query shape (already extracted in
//     `send-blockers.ts`).
//   - The `template_preview` clipping (simple `slice(0, N)`).
//   - The widget envelope composition (covered at emission by
//     `validateWidgetProps` in `widget-validate.ts`).

// The channel vocabulary mirrors propose_send.ts Input.channel and
// SendCampaignChannel in campaigns.ts. Kept as a closed literal so a
// regression adding a new channel must consciously extend THIS file
// + the handler + the campaigns orchestrator together — a compile-
// time triangle. Matches `SendCampaignChannelInput` in
// send-campaign-summary.ts (P14-D') for symmetry.
export type ProposeSendChannelInput =
  | "email"
  | "sms"
  | "whatsapp"
  | "both"
  | "all";

// The four-bucket shape. Exported so the widget validator / directive
// validator / future callers can reference it. Matches the structural
// shape pinned in `directive-validate.ts`'s `by_channel` check.
export type ChannelBreakdown = {
  ready: number;
  skipped_already_sent: number;
  skipped_unsubscribed: number;
  no_contact: number;
};

// What the helper produces. The handler slots `buckets` onto the
// widget's `by_channel`, `readyMessages` onto `ready_messages`,
// `inviteeCount` onto `invitee_total`, `summary` onto output.summary,
// and `state` onto the widget's state field.
export type ProposeSendPreview = {
  buckets: {
    email: ChannelBreakdown;
    sms: ChannelBreakdown;
    whatsapp: ChannelBreakdown;
  };
  readyMessages: number;
  inviteeCount: number;
  summaryLines: string[];
  summary: string;
  state: "ready" | "blocked";
};

export function deriveProposeSendPreview(args: {
  campaignName: string;
  campaignStatus: string;
  channel: ProposeSendChannelInput;
  onlyUnsent: boolean;
  audience: Audience;
  blockers: string[];
}): ProposeSendPreview {
  const {
    campaignName,
    campaignStatus,
    channel,
    onlyUnsent,
    audience,
    blockers,
  } = args;
  const { invitees, unsubEmails, unsubPhones } = audience;

  // Resolve the channel set via the shared resolver so `"both"` /
  // `"all"` / scalar channels collapse to the same concrete Set the
  // real send path uses. This keeps the bucket loop byte-for-byte
  // symmetric with `hasReadyMessage` in send-blockers.ts and with
  // the per-channel dispatch branches in `sendCampaign`.
  const chans = channelSetFor(channel);
  const wantsEmail = chans.has("email");
  const wantsSms = chans.has("sms");
  const wantsWhatsApp = chans.has("whatsapp");

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
  // WhatsApp bucket is computed identically to the SMS bucket
  // (same `phoneE164` contact field, same `unsubPhones` shared
  // set per the Unsubscribe table's channel-less phone column).
  // The only difference is the `invitations.channel === "whatsapp"`
  // filter for already-sent detection — an invitee who received
  // an SMS does not count as "already sent WhatsApp" and vice
  // versa. This mirrors the planner's channel-scoped dedupe.
  const whatsAppBucket: ChannelBreakdown = {
    ready: 0,
    skipped_already_sent: 0,
    skipped_unsubscribed: 0,
    no_contact: 0,
  };

  for (const inv of invitees) {
    // The "already-sent" check excludes `status === "failed"` rows
    // so a failed attempt doesn't lock an invitee out of a resend.
    // Same predicate across all three channels — the only difference
    // is the channel string.
    const hasEmailSent = inv.invitations.some(
      (x) => x.channel === "email" && x.status !== "failed",
    );
    const hasSmsSent = inv.invitations.some(
      (x) => x.channel === "sms" && x.status !== "failed",
    );
    const hasWhatsAppSent = inv.invitations.some(
      (x) => x.channel === "whatsapp" && x.status !== "failed",
    );
    // Per-channel fold. Precedence per channel:
    //   (a) no_contact — missing the relevant contact field
    //   (b) skipped_already_sent — onlyUnsent AND has a non-failed
    //       invitation on this channel
    //   (c) skipped_unsubscribed — contact is on the unsub set
    //   (d) ready — fell through all three gates
    // These are mutually exclusive (if/else if/else if/else), so an
    // invitee lands in exactly one bucket per wanted channel.
    if (wantsEmail) {
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
    if (wantsSms) {
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
    if (wantsWhatsApp) {
      if (!inv.phoneE164) {
        whatsAppBucket.no_contact += 1;
      } else if (onlyUnsent && hasWhatsAppSent) {
        whatsAppBucket.skipped_already_sent += 1;
      } else if (unsubPhones.has(inv.phoneE164)) {
        whatsAppBucket.skipped_unsubscribed += 1;
      } else {
        whatsAppBucket.ready += 1;
      }
    }
  }

  // `readyMessages` is a JOB count — one `(invitee, channel)` pair is
  // one job. Matches sendCampaign's planner. An invitee on channel=all
  // with email + phone contributes 3 (email, sms, whatsapp). A
  // regression dropping the WhatsApp bucket would silently under-count
  // the operator-facing number on "whatsapp" / "all" sends.
  const readyMessages =
    emailBucket.ready + smsBucket.ready + whatsAppBucket.ready;
  const inviteeCount = invitees.length;

  // Summary lines — four possible lines:
  //   1. ALWAYS: "Propose send for "name" [status]: channel=..., only_unsent=...."
  //   2. ALWAYS: "N invitee(s); M message(s) ready to send (<readyParts>)."
  //   3. CONDITIONAL on skippedAlreadySent + skippedUnsub > 0:
  //      "Skipped: already-sent X, unsubscribed Y."
  //   4. CONDITIONAL on blockers.length > 0: "Blockers: <joined>."
  //   5. ALWAYS: "A ConfirmSend card has been rendered..."
  const summaryLines: string[] = [];
  summaryLines.push(
    `Propose send for "${campaignName}" [${campaignStatus}]: channel=${channel}, only_unsent=${onlyUnsent}.`,
  );

  // Per-channel breakdown in the summary is built dynamically so
  // scalar channels (e.g. `"whatsapp"`) don't say "email 0, sms 0,
  // whatsapp N" — the model's transcript should mirror what the
  // operator asked for. `"both"` says "email N, sms M" (not whatsapp);
  // `"all"` adds the third entry. Insertion order is fixed:
  // email → sms → whatsapp.
  const readyParts: string[] = [];
  if (wantsEmail) readyParts.push(`email ${emailBucket.ready}`);
  if (wantsSms) readyParts.push(`sms ${smsBucket.ready}`);
  if (wantsWhatsApp) readyParts.push(`whatsapp ${whatsAppBucket.ready}`);
  summaryLines.push(
    `${inviteeCount} invitee${inviteeCount === 1 ? "" : "s"}; ${readyMessages} message${readyMessages === 1 ? "" : "s"} ready to send (${readyParts.join(", ")}).`,
  );

  const skippedAlreadySent =
    emailBucket.skipped_already_sent +
    smsBucket.skipped_already_sent +
    whatsAppBucket.skipped_already_sent;
  const skippedUnsub =
    emailBucket.skipped_unsubscribed +
    smsBucket.skipped_unsubscribed +
    whatsAppBucket.skipped_unsubscribed;
  if (skippedAlreadySent + skippedUnsub > 0) {
    summaryLines.push(
      `Skipped: already-sent ${skippedAlreadySent}, unsubscribed ${skippedUnsub}.`,
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
  // `error` after dispatch (see `markConfirmSendOutcome`). The same
  // validator rejects `submitting` as a persisted state — that one
  // is client-local during the POST window and never hits the DB.
  const state: "ready" | "blocked" = blockers.length > 0 ? "blocked" : "ready";

  // Join with newlines — matches the pre-P14-E inline handler code
  // path. The summary lands on the tool's `output.summary` which the
  // AI transcript consumes verbatim.
  const summary = summaryLines.join("\n");

  return {
    buckets: {
      email: emailBucket,
      sms: smsBucket,
      whatsapp: whatsAppBucket,
    },
    readyMessages,
    inviteeCount,
    summaryLines,
    summary,
    state,
  };
}
