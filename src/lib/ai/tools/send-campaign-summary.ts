// Pure derivations from a `sendCampaign()` result tally into the
// operator-visible summary + output shape that `send_campaign.ts`'s
// handler emits. Extracted so the sum-total, per-channel breakdown
// filter, and summary-line composition are unit-testable without
// prisma / the campaigns orchestrator / provider dispatch.
//
// Three distinct transformations the handler does post-dispatch:
//
//   1. Sum-total across every dispatched channel — `email + sms +
//      whatsapp`. A regression dropping `whatsapp` silently under-
//      counts the operator-facing total on a "whatsapp" or "all"
//      send; visible in the transcript and on the widget outcome.
//
//   2. Per-channel breakdown filter — which channels appear in the
//      "Sent N messages: Xe, Ys, Zw" line. Rule: a channel appears
//      IFF the caller's `channel` input requested it (`"email"` →
//      email only; `"both"` → email+sms; `"all"` → email+sms+whatsapp;
//      scalars are single-channel). A regression that unconditionally
//      includes all three channels would paint a "0 whatsapp" on an
//      email-only send — worst-case operator confusion about whether
//      WhatsApp was attempted.
//
//   3. Summary-line composition — the grammar branch ("1 message" /
//      "N messages"), the conditional `skipped`/`failed` lines, and
//      the join rule. Mostly cosmetic but operator-visible, and the
//      join rule matters for the audit stream (summary is persisted
//      and replayed).
//
// Intentionally does NOT cover:
//
//   - The role / scope / blocker / status gates that run BEFORE
//     dispatch. Those are either extracted separately (`computeBlockers`
//     in send-blockers.ts) or interleaved with prisma and tested at
//     the route level.
//   - The `send_in_flight` / `forbidden` / `not_found` refusal
//     shapes. Those are fixed-literal outputs above the dispatch
//     call, not derivations.
//   - The confirm-flow's `outcome` blob derivation (lives in
//     confirm-flow.ts:247-278 and is covered by confirm-single-use.test.ts).

// The channel vocabulary mirrors send_campaign.ts Input.channel and
// SendCampaignChannel in campaigns.ts. Kept as a closed literal so a
// regression adding a new channel must consciously extend THIS file
// + the handler + the campaigns orchestrator together — a compile-
// time triangle.
export type SendCampaignChannelInput =
  | "email"
  | "sms"
  | "whatsapp"
  | "both"
  | "all";

// Shape of the dispatch tally `sendCampaign()` returns on the
// non-locked happy path. Only the five counters — `locked` is
// branched on before this helper is called.
export type SendCampaignDispatchResult = {
  email: number;
  sms: number;
  whatsapp: number;
  skipped: number;
  failed: number;
};

// What the helper produces. `summary` is the joined string that
// lands on the handler's `output.summary`; `summaryLines` and
// `breakdown` are exposed separately for the tests and for any
// future caller that wants to re-compose (e.g. a richer widget).
export type SendCampaignSummary = {
  total: number;
  breakdown: string[];
  summaryLines: string[];
  summary: string;
};

export function deriveSendCampaignSummary(args: {
  campaignName: string;
  channel: SendCampaignChannelInput;
  result: SendCampaignDispatchResult;
}): SendCampaignSummary {
  const { campaignName, channel, result } = args;

  // (1) Sum across every dispatched channel. WhatsApp folds in
  // additively — pre-P13 callers who ignored `whatsapp` would have
  // seen `total = email + sms`, but the P13-C widening landed this
  // counter on every success response and it must participate in
  // the operator-visible total.
  const total = result.email + result.sms + result.whatsapp;

  // (2) Per-channel breakdown filter. The three conditions are
  // mutually-non-exclusive (a "both" send matches both the email
  // branch and the sms branch) but each channel string appears at
  // most once in the breakdown — that's the guarantee operators
  // rely on to parse the line visually.
  //
  // Rule: a channel appears IFF the caller's `channel` input
  // requested it. Encodes as:
  //   - email:    "email" | "both" | "all"
  //   - sms:      "sms" | "both" | "all"
  //   - whatsapp: "whatsapp" | "all"
  // Note that "both" deliberately EXCLUDES whatsapp — it's the
  // pre-P13 legacy channel vocabulary and widening it silently
  // would break callers that expect two-channel semantics.
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

  // (3) Summary-line composition. Three possible lines:
  //   - ALWAYS: "Sent N message(s) for "name": <breakdown>."
  //   - CONDITIONAL on skipped > 0: "Skipped N."
  //   - CONDITIONAL on failed > 0: "Failed N — see the campaign's activity page for per-invitee errors."
  //
  // The grammar branch ("message" vs "messages") matches English
  // pluralization — `total === 1` is the only singular case.
  const summaryLines: string[] = [];
  summaryLines.push(
    `Sent ${total} message${total === 1 ? "" : "s"} for "${campaignName}": ${breakdown.join(", ")}.`,
  );
  if (result.skipped > 0) summaryLines.push(`Skipped ${result.skipped}.`);
  if (result.failed > 0) {
    summaryLines.push(
      `Failed ${result.failed} — see the campaign's activity page for per-invitee errors.`,
    );
  }

  // Join with a single space — matches the pre-P14-D' inline code
  // path. The confirm-flow's outcome writer persists this string on
  // the widget's `outcome.summary` field, where the widget validator
  // requires a non-empty string; the join here guarantees that for
  // any finite `total` / `result`.
  const summary = summaryLines.join(" ");

  return { total, breakdown, summaryLines, summary };
}
