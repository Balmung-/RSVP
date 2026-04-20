import { prisma } from "./db";
import { dedupKey, normalizeEmail, normalizePhone } from "./contact";
import { sendEmail, sendSms, sendWhatsApp } from "./delivery";
import { newRsvpToken } from "./tokens";
import { isUniqueViolation } from "./prisma-errors";
import { DELIVERED_OK_STATUSES } from "./statuses";
import { mapConcurrent } from "./concurrency";
import { runImport } from "./importPlanner";
import type { Prisma } from "@prisma/client";

export type ImportRow = {
  full_name?: string;
  name?: string;
  title?: string;
  organization?: string;
  org?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  locale?: string;
  guests?: string;
  tags?: string;
  notes?: string;
};

// Preserves the admin-UI return shape, including the now-empty
// `warnings` array (the planner doesn't carry per-row warnings —
// the UI never surfaced them on the import page beyond the existing
// counters, so the array is kept for structural backwards-compat
// rather than populated).
export type ImportReport = {
  total: number;
  created: number;
  duplicatesWithin: number;
  duplicatesExisting: number;
  invalid: number;
  capped: boolean;
  warnings: Array<{ row: number; reason: string }>;
};

// Thin wrapper over the shared planner — same rationale as
// `importContacts` in contacts.ts. Delegating here guarantees that
// the admin-upload path and the `commit_import` chat tool produce
// identical counters for the same input text + campaign, which is
// the whole point of the planner extraction.
export async function importInvitees(
  campaignId: string,
  text: string,
): Promise<ImportReport> {
  const r = await runImport(
    { target: "invitees", text, campaignId },
    "commit",
  );
  return {
    total: r.total,
    created: r.created,
    duplicatesWithin: r.duplicatesWithin,
    duplicatesExisting: r.duplicatesExisting,
    invalid: r.invalid,
    capped: r.capped,
    warnings: [],
  };
}

// Bulk version of campaignStats for list views. Computes total /
// responded / headcount for every campaign in `ids` with three
// grouped queries total — not seven per campaign. Returns a Map
// keyed on campaignId so callers pick the row they need by id.
export async function bulkCampaignStats(ids: string[]): Promise<
  Map<string, { total: number; responded: number; headcount: number }>
> {
  const out = new Map<string, { total: number; responded: number; headcount: number }>();
  for (const id of ids) out.set(id, { total: 0, responded: 0, headcount: 0 });
  if (ids.length === 0) return out;
  const [invitees, responses, attending] = await Promise.all([
    prisma.invitee.groupBy({
      by: ["campaignId"],
      where: { campaignId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.response.groupBy({
      by: ["campaignId"],
      where: { campaignId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.response.groupBy({
      by: ["campaignId"],
      where: { campaignId: { in: ids }, attending: true },
      _count: { _all: true },
      _sum: { guestsCount: true },
    }),
  ]);
  for (const r of invitees) {
    const s = out.get(r.campaignId);
    if (s) s.total = r._count._all;
  }
  for (const r of responses) {
    const s = out.get(r.campaignId);
    if (s) s.responded = r._count._all;
  }
  for (const r of attending) {
    const s = out.get(r.campaignId);
    if (s) s.headcount = r._count._all + (r._sum.guestsCount ?? 0);
  }
  return out;
}

export async function campaignStats(campaignId: string) {
  const [total, responded, attending, declined, sentEmail, sentSms, guestsAgg] = await Promise.all([
    prisma.invitee.count({ where: { campaignId } }),
    prisma.response.count({ where: { campaignId } }),
    prisma.response.count({ where: { campaignId, attending: true } }),
    prisma.response.count({ where: { campaignId, attending: false } }),
    prisma.invitation.count({ where: { campaignId, channel: "email", status: { in: DELIVERED_OK_STATUSES } } }),
    prisma.invitation.count({ where: { campaignId, channel: "sms", status: { in: DELIVERED_OK_STATUSES } } }),
    prisma.response.aggregate({ where: { campaignId, attending: true }, _sum: { guestsCount: true } }),
  ]);
  const guests = guestsAgg._sum.guestsCount ?? 0;
  return {
    total,
    responded,
    pending: total - responded,
    attending,
    declined,
    guests,
    headcount: attending + guests,
    sentEmail,
    sentSms,
  };
}

// Campaign-send channel selector.
//
// Scalar values target one channel. Group values are umbrellas:
//   - "both" — email + SMS. Preserved verbatim from before P13; the
//             AI tool's `send_campaign` validate() still only accepts
//             this group, and the admin-UI bulk send passes it
//             through as-is. Semantically "both" remains "every
//             channel the invitee has BEFORE WhatsApp was introduced"
//             so existing callers are not surprised by a WhatsApp
//             message they didn't ask for.
//   - "all"  — email + SMS + WhatsApp. Post-P13 callers that have
//             been audited to deal with WhatsApp use this explicitly.
// A caller that wants WhatsApp only picks the "whatsapp" scalar.
export type SendCampaignChannel =
  | "email"
  | "sms"
  | "whatsapp"
  | "both"
  | "all";

// Channel-selector resolver. The surface is a single function so
// callers don't each re-derive the set from the group semantics.
// "both" intentionally excludes whatsapp — see the type comment.
// Exported for unit testing; production callers reach it implicitly
// through `sendCampaign`.
export function channelSetFor(ch: SendCampaignChannel): Set<"email" | "sms" | "whatsapp"> {
  switch (ch) {
    case "email":
      return new Set(["email"]);
    case "sms":
      return new Set(["sms"]);
    case "whatsapp":
      return new Set(["whatsapp"]);
    case "both":
      return new Set(["email", "sms"]);
    case "all":
      return new Set(["email", "sms", "whatsapp"]);
  }
}

// Atomic send. Uses a CAS on Campaign.status to guarantee single concurrent run.
// draft|active → sending; on completion → active (or closed if deadline passed).
// If CAS fails (another send is in flight) we return { locked: true }.
export async function sendCampaign(
  campaignId: string,
  opts: { channel: SendCampaignChannel; onlyUnsent: boolean } = { channel: "both", onlyUnsent: true },
) {
  const acquired = await prisma.campaign.updateMany({
    where: { id: campaignId, status: { in: ["draft", "active"] } },
    data: { status: "sending" },
  });
  if (acquired.count === 0) {
    return { locked: true as const, email: 0, sms: 0, whatsapp: 0, skipped: 0, failed: 0 };
  }

  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const invitees = await prisma.invitee.findMany({
    where: { campaignId },
    include: { invitations: true },
  });

  // Flatten into a job list up front, then fan out with bounded
  // concurrency. Previously this was a serial loop — a 500-person
  // campaign at 500ms per provider call took ~4 min and would clip
  // Railway's request budget. At concurrency=5 the same campaign
  // finishes in under a minute without flooding the provider.
  type Job = { invitee: (typeof invitees)[number]; channel: "email" | "sms" | "whatsapp" };
  const chans = channelSetFor(opts.channel);
  const jobs: Job[] = [];
  let skipped = 0;
  for (const i of invitees) {
    const hasEmailSent = i.invitations.some((x) => x.channel === "email" && x.status !== "failed");
    const hasSmsSent = i.invitations.some((x) => x.channel === "sms" && x.status !== "failed");
    const hasWhatsAppSent = i.invitations.some((x) => x.channel === "whatsapp" && x.status !== "failed");
    if (chans.has("email") && i.email) {
      if (opts.onlyUnsent && hasEmailSent) skipped++;
      else jobs.push({ invitee: i, channel: "email" });
    }
    if (chans.has("sms") && i.phoneE164) {
      if (opts.onlyUnsent && hasSmsSent) skipped++;
      else jobs.push({ invitee: i, channel: "sms" });
    }
    // WhatsApp reuses phoneE164 — same contact field as SMS. An
    // invitee with a phone number can legitimately receive both,
    // and a campaign targeting `channel: "all"` will fan out two
    // phone jobs per invitee (SMS + WhatsApp). Dedup on the WA
    // side happens via the planner's template-vs-session rules,
    // not here.
    if (chans.has("whatsapp") && i.phoneE164) {
      if (opts.onlyUnsent && hasWhatsAppSent) skipped++;
      else jobs.push({ invitee: i, channel: "whatsapp" });
    }
  }

  let email = 0, sms = 0, whatsapp = 0, failed = 0;

  try {
    const results = await mapConcurrent(jobs, 5, async (job) => {
      if (job.channel === "email") return sendEmail(campaign, job.invitee);
      if (job.channel === "sms") return sendSms(campaign, job.invitee);
      return sendWhatsApp(campaign, job.invitee);
    });
    for (let k = 0; k < jobs.length; k++) {
      const r = results[k];
      if (r.ok) {
        if (jobs[k].channel === "email") email++;
        else if (jobs[k].channel === "sms") sms++;
        else whatsapp++;
      } else {
        failed++;
      }
    }
  } finally {
    // Release the CAS lock: only move sending → active. Anything else
    // (archived, closed) was set by a concurrent admin and we must not
    // resurrect the campaign.
    await prisma.campaign.updateMany({
      where: { id: campaignId, status: "sending" },
      data: { status: "active" },
    });
  }

  return { locked: false as const, email, sms, whatsapp, skipped, failed };
}

// Create / update a single invitee via the admin UI. Returns the row or an
// error reason. Dedup across the campaign is enforced by the unique index;
// we catch it and translate to a stable error code.
export type InviteeMutationInput = {
  fullName: string;
  title?: string | null;
  organization?: string | null;
  email?: string | null;
  phone?: string | null;
  locale?: "en" | "ar" | null;
  tags?: string | null;
  notes?: string | null;
  guestsAllowed?: number;
};

export type InviteeMutationResult =
  | { ok: true; inviteeId: string }
  | { ok: false; reason: "missing_name" | "missing_contact" | "duplicate" | "not_found" | "invalid_phone" | "invalid_email" };

function normalizeInput(input: InviteeMutationInput, defaultCountry: "SA" = "SA"): {
  fullName: string;
  title: string | null;
  organization: string | null;
  email: string | null;
  phoneE164: string | null;
  locale: string | null;
  tags: string | null;
  notes: string | null;
  guestsAllowed: number;
} | { error: InviteeMutationResult } {
  const fullName = input.fullName.trim().slice(0, 200);
  if (!fullName) return { error: { ok: false, reason: "missing_name" } };
  const rawEmail = (input.email ?? "").trim();
  const rawPhone = (input.phone ?? "").trim();
  const email = normalizeEmail(rawEmail);
  if (rawEmail && !email) return { error: { ok: false, reason: "invalid_email" } };
  const phoneE164 = normalizePhone(rawPhone, defaultCountry);
  if (rawPhone && !phoneE164) return { error: { ok: false, reason: "invalid_phone" } };
  if (!email && !phoneE164) return { error: { ok: false, reason: "missing_contact" } };
  return {
    fullName,
    title: (input.title ?? "").trim().slice(0, 100) || null,
    organization: (input.organization ?? "").trim().slice(0, 200) || null,
    email,
    phoneE164,
    locale: input.locale ?? null,
    tags: (input.tags ?? "").trim().slice(0, 500) || null,
    notes: (input.notes ?? "").trim().slice(0, 2000) || null,
    guestsAllowed: Math.max(0, Math.min(20, Math.floor(input.guestsAllowed ?? 0))),
  };
}

export async function createInvitee(
  campaignId: string,
  input: InviteeMutationInput,
): Promise<InviteeMutationResult> {
  const norm = normalizeInput(input);
  if ("error" in norm) return norm.error;
  const key = dedupKey(norm.email, norm.phoneE164);
  try {
    const row = await prisma.invitee.create({
      data: {
        campaignId,
        ...norm,
        dedupKey: key,
        rsvpToken: newRsvpToken(),
      },
    });
    return { ok: true, inviteeId: row.id };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: "duplicate" };
    throw e;
  }
}

export async function updateInvitee(
  inviteeId: string,
  input: InviteeMutationInput,
  expectedCampaignId?: string,
): Promise<InviteeMutationResult> {
  const existing = await prisma.invitee.findUnique({ where: { id: inviteeId } });
  if (!existing) return { ok: false, reason: "not_found" };
  if (expectedCampaignId && existing.campaignId !== expectedCampaignId) {
    // Defense in depth — the bound server action already restricts to the
    // rendered campaign, but a caller mismatch should never corrupt data.
    return { ok: false, reason: "not_found" };
  }
  const norm = normalizeInput(input);
  if ("error" in norm) return norm.error;
  const key = dedupKey(norm.email, norm.phoneE164);
  try {
    await prisma.invitee.update({
      where: { id: inviteeId },
      data: { ...norm, dedupKey: key },
    });
    return { ok: true, inviteeId };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: "duplicate" };
    throw e;
  }
}

export async function deleteInvitee(campaignId: string, inviteeId: string): Promise<void> {
  await prisma.invitee.deleteMany({ where: { id: inviteeId, campaignId } });
}

// Per-channel scalar — the shape of a single resend job. A caller
// that wants groups ("both" / "all") iterates this set itself, same
// way `sendCampaign`'s channel-selector resolves. Resend is always
// a targeted per-channel action, so there's no equivalent to the
// "both" umbrella here.
export type ResendChannel = "email" | "sms" | "whatsapp";

// Resend to a single invitee on one channel. Used from the invitee drawer.
// Creates a fresh Invitation row regardless of prior attempts.
export async function resendSingle(
  campaignId: string,
  inviteeId: string,
  channel: ResendChannel,
): Promise<{ ok: boolean; error?: string }> {
  const [campaign, invitee] = await Promise.all([
    prisma.campaign.findUnique({ where: { id: campaignId } }),
    prisma.invitee.findUnique({ where: { id: inviteeId } }),
  ]);
  if (!campaign || !invitee || invitee.campaignId !== campaignId) {
    return { ok: false, error: "not_found" };
  }
  const r =
    channel === "email"
      ? await sendEmail(campaign, invitee)
      : channel === "sms"
        ? await sendSms(campaign, invitee)
        : await sendWhatsApp(campaign, invitee);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

// Bulk resend to a list of invitees on the chosen channels. Respects
// onlyUnsent per-(invitee, channel) pair.
export async function resendSelection(
  campaignId: string,
  inviteeIds: string[],
  opts: { channels: ResendChannel[]; onlyUnsent: boolean },
): Promise<{ email: number; sms: number; whatsapp: number; skipped: number; failed: number }> {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return { email: 0, sms: 0, whatsapp: 0, skipped: 0, failed: 0 };
  const invitees = await prisma.invitee.findMany({
    where: { campaignId, id: { in: inviteeIds } },
    include: { invitations: true },
  });
  // Flatten to (invitee, channel) pairs so the concurrent runner can
  // fan out across them. `skipped` pairs are resolved here so the
  // parallel stage only does real sends.
  type Job = { invitee: (typeof invitees)[number]; channel: ResendChannel };
  const jobs: Job[] = [];
  let skipped = 0;
  for (const i of invitees) {
    for (const ch of opts.channels) {
      const has = i.invitations.some((x) => x.channel === ch && x.status !== "failed");
      // WhatsApp shares the phoneE164 contact field with SMS —
      // the address check collapses to "has email for email, has
      // phone for sms/whatsapp". Keeping this as a single inline
      // ternary (rather than a switch) stays readable and avoids
      // a helper that'd only have one caller.
      const hasAddr = ch === "email" ? !!i.email : !!i.phoneE164;
      if (!hasAddr) { skipped++; continue; }
      if (opts.onlyUnsent && has) { skipped++; continue; }
      jobs.push({ invitee: i, channel: ch });
    }
  }
  const results = await mapConcurrent(jobs, 5, async (job) => {
    if (job.channel === "email") return sendEmail(campaign, job.invitee);
    if (job.channel === "sms") return sendSms(campaign, job.invitee);
    return sendWhatsApp(campaign, job.invitee);
  });
  let email = 0, sms = 0, whatsapp = 0, failed = 0;
  for (let k = 0; k < jobs.length; k++) {
    const res = results[k];
    if (res.ok) {
      if (jobs[k].channel === "email") email++;
      else if (jobs[k].channel === "sms") sms++;
      else whatsapp++;
    } else {
      failed++;
    }
  }
  return { email, sms, whatsapp, skipped, failed };
}

export async function findDuplicates(campaignId: string) {
  const invitees = await prisma.invitee.findMany({ where: { campaignId } });
  const byName = new Map<string, typeof invitees>();
  const byPhone = new Map<string, typeof invitees>();
  const byEmail = new Map<string, typeof invitees>();
  for (const i of invitees) {
    const nm = i.fullName.trim().toLowerCase().replace(/\s+/g, " ");
    push(byName, nm, i);
    if (i.phoneE164) push(byPhone, i.phoneE164, i);
    if (i.email) push(byEmail, i.email.toLowerCase(), i);
  }
  const groups: Array<{ reason: string; invitees: typeof invitees }> = [];
  for (const [k, arr] of byPhone) if (arr.length > 1) groups.push({ reason: `phone ${k}`, invitees: arr });
  for (const [k, arr] of byEmail) if (arr.length > 1) groups.push({ reason: `email ${k}`, invitees: arr });
  for (const [k, arr] of byName) if (arr.length > 1) groups.push({ reason: `name "${k}"`, invitees: arr });
  return groups;
}

function push<T>(map: Map<string, T[]>, key: string, v: T) {
  const arr = map.get(key) ?? [];
  arr.push(v);
  map.set(key, arr);
}

// Re-export from lib/deliverability so existing callers continue to
// work while the authoritative implementation lives there.
export { liveFailureCount } from "./deliverability";
