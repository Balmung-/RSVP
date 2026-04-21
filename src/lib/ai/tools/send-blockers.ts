import { prisma } from "@/lib/db";
import { channelSetFor, type SendCampaignChannel } from "@/lib/campaigns";
import { campaignWantsWhatsAppDocument } from "@/lib/providers/whatsapp/sendPlan";

// Shared blocker truth for the propose_send → ConfirmSend →
// send_campaign path.
//
// Why it exists: propose_send surfaces a set of blockers to the UI
// (the ConfirmSend directive renders them and disables the button).
// send_campaign must re-enforce the same blockers server-side at
// confirm time, because the client-side disable is not a security
// boundary — a forged POST or a bad history rehydrate could hit
// /api/chat/confirm with a messageId that pointed at a blocked
// preview. Without a server-side re-check, sendCampaign falls back
// to default localized copy when a template is missing
// (`src/lib/preview.ts:60-61,80` uses `templateEmail || defaultBody`),
// so a "no_email_template" blocker that only lives in the directive
// payload would still let real messages land using fallback text.
//
// Keeping both callers on the same helper closes the drift risk:
// if a new blocker type gets added here, propose_send renders it
// AND send_campaign enforces it automatically. No chance of one
// surface surfacing a blocker the other forgot about.
//
// Scope: this helper is deliberately narrow. It does NOT:
//   - resolve the campaign under the operator's team scope
//     (caller does that with ctx.campaignScope)
//   - role-gate (caller does that with hasRole(...))
//   - compute per-channel breakdowns (propose_send does that
//     inline because it needs bucket counts for the directive,
//     not just blocker presence)
// It takes pre-loaded data so the caller can batch the audience
// load with its other reads.

// Channel vocabulary matches `SendCampaignChannel` — single source
// of truth. See `src/lib/campaigns.ts` for the type + the
// `channelSetFor(...)` resolver. Narrower callers (e.g. an older
// AI tool that still only accepts "email" | "sms" | "both") pass
// a subtype through; the helper stays channel-shape-agnostic.
export type Channel = SendCampaignChannel;

// Narrow campaign shape — only the fields this helper reads.
// Callers select these explicitly so the Prisma cost is visible.
//
// WhatsApp fields (templateWhatsAppName + templateWhatsAppLanguage)
// are both required for the planner to take the template path. We
// treat the campaign as "WhatsApp-configured" iff both are set and
// non-empty — matches `decideWhatsAppMessage`'s Rule 1 predicate.
// Stored here rather than derived from a boolean so the blocker
// code can stay stateless, and so the tool layer's Prisma selects
// are visible in one place.
export type CampaignForBlockers = {
  status: string;
  templateEmail: string | null;
  templateSms: string | null;
  templateWhatsAppName: string | null;
  templateWhatsAppLanguage: string | null;
  // JSON-encoded `string[]` of positional expressions the planner
  // interpolates into Meta's `{{1}}` / `{{2}}` template slots. Stored
  // as a string so it can be saved verbatim through Prisma, parsed
  // lazily at send time. A null value means "template takes zero
  // variables" (perfectly valid); a non-null value that fails to
  // parse as a string array is a config bug — the planner refuses
  // with `template_vars_malformed` and `computeBlockers` surfaces it
  // here so the operator sees the problem in the ConfirmSend card
  // instead of after clicking.
  templateWhatsAppVariables: string | null;
  // P17-C.5 — FK to the FileUpload row carrying the invitation PDF.
  // Used in combination with templateWhatsAppName + templateWhatsAppLanguage
  // by `campaignWantsWhatsAppDocument` (gate predicate) to decide
  // whether the doc-header path is active. When a campaign wants the
  // doc but the row is missing (deleted since configuration), the
  // blocker layer emits `no_whatsapp_document` so the operator fixes
  // the config rather than hitting a per-invitation `doc_not_found`
  // failure at the delivery edge.
  whatsappDocumentUploadId: string | null;
};

// Narrow invitee shape. `invitations` is an array of
// { channel, status } used to check "already-sent" state.
export type InviteeForAudience = {
  email: string | null;
  phoneE164: string | null;
  invitations: { channel: string; status: string }[];
};

export type Audience = {
  invitees: InviteeForAudience[];
  unsubEmails: Set<string>;
  unsubPhones: Set<string>;
};

// Load the invitee + unsubscribe data needed to evaluate blockers.
// Matches sendCampaign's audience view byte-for-byte — same join
// shape, same unsubscribe cross-check — so the blocker decision
// here and the actual send decision in sendCampaign cannot diverge.
// The unsubscribe query uses OR(email IN (...), phone IN (...))
// in one round-trip; two Set lookups at evaluation time.
export async function loadAudience(campaignId: string): Promise<Audience> {
  const invitees = await prisma.invitee.findMany({
    where: { campaignId },
    include: { invitations: true },
  });
  const emails = invitees
    .map((i) => i.email)
    .filter((v): v is string => !!v);
  const phones = invitees
    .map((i) => i.phoneE164)
    .filter((v): v is string => !!v);
  const unsubRows =
    emails.length + phones.length === 0
      ? []
      : await prisma.unsubscribe.findMany({
          where: {
            OR: [
              ...(emails.length > 0 ? [{ email: { in: emails } }] : []),
              ...(phones.length > 0 ? [{ phoneE164: { in: phones } }] : []),
            ],
          },
          select: { email: true, phoneE164: true },
        });
  const unsubEmails = new Set<string>();
  const unsubPhones = new Set<string>();
  for (const u of unsubRows) {
    if (u.email) unsubEmails.add(u.email);
    if (u.phoneE164) unsubPhones.add(u.phoneE164);
  }
  return { invitees, unsubEmails, unsubPhones };
}

// Does any (invitee, channel) pair pass the per-message filter?
// Mirrors sendCampaign's planner: missing contact → skip,
// already-sent-and-only-unsent → skip, unsubscribed → skip,
// otherwise ready.
//
// This is a short-circuit scan — we stop at the first ready pair.
// propose_send needs full per-channel counts for the directive and
// does its own loop (inline); this helper only exists to answer
// "is the count > 0". Keeping it short-circuit means even large
// campaigns blocker-check in near-constant time if ready messages
// exist.
function hasReadyMessage(args: {
  invitees: InviteeForAudience[];
  unsubEmails: Set<string>;
  unsubPhones: Set<string>;
  channel: Channel;
  onlyUnsent: boolean;
}): boolean {
  const { invitees, unsubEmails, unsubPhones, channel, onlyUnsent } = args;
  // Use the shared channel-set resolver so "both" / "all" / scalar
  // channels all collapse to the same concrete Set the real send
  // would use. A drift here would mean the blocker says "ready" but
  // the send finds no jobs, or vice versa.
  const chans = channelSetFor(channel);
  const wantsEmail = chans.has("email");
  const wantsSms = chans.has("sms");
  // WhatsApp shares phoneE164 + the unsubscribed-phone set with SMS.
  // The unsubscribe table doesn't distinguish SMS-vs-WhatsApp today
  // (one `phoneE164` column, no `channel` discriminator), so an
  // invitee who opts out via SMS STOP is considered unsubscribed for
  // WhatsApp too. That's the conservative default: a recipient who
  // asked not to receive messages on their phone shouldn't be
  // switched to a different channel hitting the same phone.
  const wantsWhatsApp = chans.has("whatsapp");
  for (const inv of invitees) {
    const hasEmailSent = inv.invitations.some(
      (x) => x.channel === "email" && x.status !== "failed",
    );
    const hasSmsSent = inv.invitations.some(
      (x) => x.channel === "sms" && x.status !== "failed",
    );
    const hasWhatsAppSent = inv.invitations.some(
      (x) => x.channel === "whatsapp" && x.status !== "failed",
    );
    if (
      wantsEmail &&
      inv.email &&
      !(onlyUnsent && hasEmailSent) &&
      !unsubEmails.has(inv.email)
    ) {
      return true;
    }
    if (
      wantsSms &&
      inv.phoneE164 &&
      !(onlyUnsent && hasSmsSent) &&
      !unsubPhones.has(inv.phoneE164)
    ) {
      return true;
    }
    if (
      wantsWhatsApp &&
      inv.phoneE164 &&
      !(onlyUnsent && hasWhatsAppSent) &&
      !unsubPhones.has(inv.phoneE164)
    ) {
      return true;
    }
  }
  return false;
}

// Canonical blocker computation. Returns the same string codes
// propose_send currently emits into `directive.props.blockers`,
// so the directive UI doesn't need to change.
//
// Order: status → audience existence → per-channel template gaps.
// This matches the operator's "what do I fix" ordering in the
// ConfirmSend card — the loudest problem first.
//
// `status_locked:<status>` is emitted in the same prefix form
// propose_send used before this refactor, so any downstream
// consumer (audit dashboard, future test) that filters on the
// literal string keeps working. send_campaign has its own
// dedicated `status_not_sendable` structured error (kept for
// release-on-refusal whitelist clarity) so it filters this one
// out before surfacing the rest.
export function computeBlockers(args: {
  campaign: CampaignForBlockers;
  audience: Audience;
  channel: Channel;
  onlyUnsent: boolean;
  // P17-C.5 — caller-provided answer to "does the FileUpload row
  // referenced by `campaign.whatsappDocumentUploadId` still exist?"
  // Optional because:
  //   - Callers that don't care about the doc path (every pre-P17-C
  //     caller, and anything on a channel that doesn't include
  //     WhatsApp) can pass nothing and the doc blocker won't fire.
  //   - Callers that DO care (propose_send, send_campaign) do the
  //     Prisma lookup themselves and pass the boolean here. Keeps
  //     this helper pure — no DB access inside the blocker logic.
  //
  // When `docUploadExists === false` AND the campaign wants a doc
  // (per `campaignWantsWhatsAppDocument`) AND the channel set
  // includes WhatsApp, emit `no_whatsapp_document`. Any other
  // combination skips the check. Undefined is treated as "caller
  // opted out of the check" — not "doc is missing" — so a
  // misconfigured campaign whose caller forgot to pass the flag
  // doesn't get a false-positive blocker.
  docUploadExists?: boolean;
}): string[] {
  const { campaign, audience, channel, onlyUnsent, docUploadExists } = args;
  const chans = channelSetFor(channel);
  const wantsEmail = chans.has("email");
  const wantsSms = chans.has("sms");
  const wantsWhatsApp = chans.has("whatsapp");
  const sendableStatuses = new Set(["draft", "active"]);

  const blockers: string[] = [];
  if (!sendableStatuses.has(campaign.status)) {
    blockers.push(`status_locked:${campaign.status}`);
  }
  if (audience.invitees.length === 0) {
    blockers.push("no_invitees");
  } else if (
    !hasReadyMessage({
      invitees: audience.invitees,
      unsubEmails: audience.unsubEmails,
      unsubPhones: audience.unsubPhones,
      channel,
      onlyUnsent,
    })
  ) {
    blockers.push("no_ready_messages");
  }
  if (wantsEmail && !campaign.templateEmail) {
    blockers.push("no_email_template");
  }
  if (wantsSms && !campaign.templateSms) {
    blockers.push("no_sms_template");
  }
  // WhatsApp "configured" means BOTH name and language are set and
  // non-empty — mirrors `decideWhatsAppMessage`'s Rule 1 predicate
  // (`src/lib/providers/whatsapp/sendPlan.ts:92-96`). Emitting
  // `no_whatsapp_template` when either is missing matches what the
  // planner would actually do at send time: refuse with
  // `reason: "no_template"`. Surfacing the blocker here means the
  // operator sees the problem in the ConfirmSend card rather than
  // getting a wall of failed Invitation rows after clicking.
  const whatsAppTemplateConfigured =
    !!campaign.templateWhatsAppName && !!campaign.templateWhatsAppLanguage;
  if (wantsWhatsApp && !whatsAppTemplateConfigured) {
    blockers.push("no_whatsapp_template");
  }
  // `template_vars_malformed` mirrors the planner's Rule 1 inner
  // guard (`src/lib/providers/whatsapp/sendPlan.ts:98-103`) — after
  // the (name, language) pair is confirmed configured, the planner
  // parses `templateWhatsAppVariables` as a JSON string-array and
  // refuses with `reason: "template_vars_malformed"` if the parse
  // fails. Only emit when the template itself IS configured (so the
  // planner would actually reach the parse step) and the stored JSON
  // is present but unparseable. This matches the planner's control
  // flow: an unconfigured template short-circuits with `no_template`
  // before the vars check, so stacking both blockers would confuse
  // the operator about what to fix first. Null `templateWhatsAppVariables`
  // is a valid zero-var template (planner leaves `variables`
  // undefined on the outbound payload), so it is not a blocker.
  if (
    wantsWhatsApp &&
    whatsAppTemplateConfigured &&
    campaign.templateWhatsAppVariables !== null &&
    !isParsableWhatsAppVars(campaign.templateWhatsAppVariables)
  ) {
    blockers.push("template_vars_malformed");
  }
  // P17-C.5 — doc-header readiness blocker. Gated on ALL of:
  //
  //   1. channel set includes WhatsApp — on an email-only send the
  //      doc never attaches, so a missing FileUpload is not a
  //      blocker (the operator can always reconfigure later without
  //      gating today's email send).
  //   2. `campaignWantsWhatsAppDocument(...)` returns true — i.e.
  //      the campaign has both a template and a doc upload id
  //      configured. Same predicate the planner uses in Rule 1's
  //      doc branch; keeping both on one gate means blocker and
  //      delivery stay consistent.
  //   3. `docUploadExists === false` (strict — undefined or true
  //      skips the blocker). Only emit when the caller has
  //      explicitly confirmed the row is missing.
  //
  // Explicit non-goals: the blocker does NOT check content-type or
  // byte length of the FileUpload. Those are delivery-edge concerns
  // (C.3's `doc_empty` guard + Taqnyat's own MIME validation). This
  // is a preflight "does the reference still resolve?" check, not a
  // deep validation.
  if (
    wantsWhatsApp &&
    campaignWantsWhatsAppDocument({
      whatsappDocumentUploadId: campaign.whatsappDocumentUploadId,
      templateWhatsAppName: campaign.templateWhatsAppName,
      templateWhatsAppLanguage: campaign.templateWhatsAppLanguage,
    }) &&
    docUploadExists === false
  ) {
    blockers.push("no_whatsapp_document");
  }
  return blockers;
}

// Mirror of `tryParseStringArray` in `src/lib/providers/whatsapp/sendPlan.ts:158-172`.
// Duplicated here rather than imported so the blocker helper does
// not have to reach into a provider-specific module — the only
// shared behaviour is "is this string a JSON-encoded string[]?",
// which is trivial enough to duplicate and robust against a future
// sendPlan refactor that changes the return shape.
//
// Returns true iff:
//   - `JSON.parse(s)` succeeds
//   - result is an Array
//   - every entry is a string
// Anything else (object, number, array-of-objects, malformed JSON)
// is considered malformed and surfaces `template_vars_malformed`
// at the blocker layer.
function isParsableWhatsAppVars(s: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  for (const entry of parsed) {
    if (typeof entry !== "string") return false;
  }
  return true;
}
