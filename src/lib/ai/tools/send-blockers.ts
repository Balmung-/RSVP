import { prisma } from "@/lib/db";

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

export type Channel = "email" | "sms" | "both";

// Narrow campaign shape — only the fields this helper reads.
// Callers select these explicitly so the Prisma cost is visible.
export type CampaignForBlockers = {
  status: string;
  templateEmail: string | null;
  templateSms: string | null;
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
  const wantsEmail = channel === "email" || channel === "both";
  const wantsSms = channel === "sms" || channel === "both";
  for (const inv of invitees) {
    const hasEmailSent = inv.invitations.some(
      (x) => x.channel === "email" && x.status !== "failed",
    );
    const hasSmsSent = inv.invitations.some(
      (x) => x.channel === "sms" && x.status !== "failed",
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
}): string[] {
  const { campaign, audience, channel, onlyUnsent } = args;
  const wantsEmail = channel === "email" || channel === "both";
  const wantsSms = channel === "sms" || channel === "both";
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
  return blockers;
}
