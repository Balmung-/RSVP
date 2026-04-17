import { prisma } from "./db";
import { dedupKey, normalizeEmail, normalizePhone, parseContactsText } from "./contact";
import { sendEmail, sendSms } from "./delivery";
import { newRsvpToken } from "./tokens";
import type { Prisma } from "@prisma/client";

const COUNTRY = (process.env.DEFAULT_COUNTRY ?? "SA") as "SA";
const MAX_IMPORT_ROWS = 10_000;

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

export type ImportReport = {
  total: number;
  created: number;
  duplicatesWithin: number;
  duplicatesExisting: number;
  invalid: number;
  capped: boolean;
  warnings: Array<{ row: number; reason: string }>;
};

export async function importInvitees(campaignId: string, text: string): Promise<ImportReport> {
  const rowsAll = parseContactsText(text) as ImportRow[];
  const capped = rowsAll.length > MAX_IMPORT_ROWS;
  const rows = capped ? rowsAll.slice(0, MAX_IMPORT_ROWS) : rowsAll;

  const report: ImportReport = {
    total: rowsAll.length,
    created: 0,
    duplicatesWithin: 0,
    duplicatesExisting: 0,
    invalid: 0,
    capped,
    warnings: [],
  };

  const seen = new Set<string>();
  const batch: Prisma.InviteeCreateManyInput[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const fullName = (r.full_name || r.name || "").trim().slice(0, 200);
    const email = normalizeEmail(r.email);
    const phone = normalizePhone(r.phone || r.mobile || "", COUNTRY);
    if (!fullName) {
      report.invalid++;
      report.warnings.push({ row: i + 2, reason: "missing name" });
      continue;
    }
    if (!email && !phone) {
      report.invalid++;
      report.warnings.push({ row: i + 2, reason: "no email or phone" });
      continue;
    }
    const key = dedupKey(email, phone);
    if (seen.has(key)) {
      report.duplicatesWithin++;
      continue;
    }
    seen.add(key);

    batch.push({
      campaignId,
      fullName,
      title: (r.title || "").trim().slice(0, 100) || null,
      organization: (r.organization || r.org || "").trim().slice(0, 200) || null,
      email,
      phoneE164: phone,
      locale: (r.locale || "").trim().toLowerCase().slice(0, 5) || null,
      tags: (r.tags || "").trim().slice(0, 500) || null,
      notes: (r.notes || "").trim().slice(0, 2000) || null,
      guestsAllowed: clampInt(r.guests, 0, 20, 0),
      dedupKey: key,
      rsvpToken: newRsvpToken(),
    });
  }

  if (batch.length > 0) {
    const existing = await prisma.invitee.findMany({
      where: { campaignId, dedupKey: { in: batch.map((b) => b.dedupKey) } },
      select: { dedupKey: true },
    });
    const existingKeys = new Set(existing.map((e) => e.dedupKey));
    const fresh = batch.filter((b) => !existingKeys.has(b.dedupKey));
    report.duplicatesExisting = batch.length - fresh.length;

    if (fresh.length > 0) {
      const res = await prisma.invitee.createMany({ data: fresh });
      report.created = res.count;
    }
  }

  await prisma.eventLog.create({
    data: { kind: "import.completed", refType: "campaign", refId: campaignId, data: JSON.stringify(report) },
  });

  return report;
}

function clampInt(s: string | undefined, min: number, max: number, def: number) {
  const n = Number(s);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export async function campaignStats(campaignId: string) {
  const [total, responded, attending, declined, sentEmail, sentSms, guestsAgg] = await Promise.all([
    prisma.invitee.count({ where: { campaignId } }),
    prisma.response.count({ where: { campaignId } }),
    prisma.response.count({ where: { campaignId, attending: true } }),
    prisma.response.count({ where: { campaignId, attending: false } }),
    prisma.invitation.count({ where: { campaignId, channel: "email", status: { in: ["sent", "delivered"] } } }),
    prisma.invitation.count({ where: { campaignId, channel: "sms", status: { in: ["sent", "delivered"] } } }),
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

// Atomic send. Uses a CAS on Campaign.status to guarantee single concurrent run.
// draft|active → sending; on completion → active (or closed if deadline passed).
// If CAS fails (another send is in flight) we return { locked: true }.
export async function sendCampaign(
  campaignId: string,
  opts: { channel: "email" | "sms" | "both"; onlyUnsent: boolean } = { channel: "both", onlyUnsent: true },
) {
  const acquired = await prisma.campaign.updateMany({
    where: { id: campaignId, status: { in: ["draft", "active"] } },
    data: { status: "sending" },
  });
  if (acquired.count === 0) {
    return { locked: true as const, email: 0, sms: 0, skipped: 0, failed: 0 };
  }

  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const invitees = await prisma.invitee.findMany({
    where: { campaignId },
    include: { invitations: true },
  });

  let email = 0, sms = 0, skipped = 0, failed = 0;

  try {
    for (const i of invitees) {
      const hasEmailSent = i.invitations.some((x) => x.channel === "email" && x.status !== "failed");
      const hasSmsSent = i.invitations.some((x) => x.channel === "sms" && x.status !== "failed");

      if ((opts.channel === "email" || opts.channel === "both") && i.email) {
        if (opts.onlyUnsent && hasEmailSent) skipped++;
        else {
          const r = await sendEmail(campaign, i);
          if (r.ok) email++; else failed++;
        }
      }
      if ((opts.channel === "sms" || opts.channel === "both") && i.phoneE164) {
        if (opts.onlyUnsent && hasSmsSent) skipped++;
        else {
          const r = await sendSms(campaign, i);
          if (r.ok) sms++; else failed++;
        }
      }
    }
  } finally {
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: "active" },
    });
  }

  return { locked: false as const, email, sms, skipped, failed };
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
    if (String(e).includes("Unique constraint")) return { ok: false, reason: "duplicate" };
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
    if (String(e).includes("Unique constraint")) return { ok: false, reason: "duplicate" };
    throw e;
  }
}

export async function deleteInvitee(campaignId: string, inviteeId: string): Promise<void> {
  await prisma.invitee.deleteMany({ where: { id: inviteeId, campaignId } });
}

// Resend to a single invitee on one channel. Used from the invitee drawer.
// Creates a fresh Invitation row regardless of prior attempts.
export async function resendSingle(
  campaignId: string,
  inviteeId: string,
  channel: "email" | "sms",
): Promise<{ ok: boolean; error?: string }> {
  const [campaign, invitee] = await Promise.all([
    prisma.campaign.findUnique({ where: { id: campaignId } }),
    prisma.invitee.findUnique({ where: { id: inviteeId } }),
  ]);
  if (!campaign || !invitee || invitee.campaignId !== campaignId) {
    return { ok: false, error: "not_found" };
  }
  const r = channel === "email" ? await sendEmail(campaign, invitee) : await sendSms(campaign, invitee);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

// Bulk resend to a list of invitees on the chosen channels. Respects
// onlyUnsent per-(invitee, channel) pair.
export async function resendSelection(
  campaignId: string,
  inviteeIds: string[],
  opts: { channels: Array<"email" | "sms">; onlyUnsent: boolean },
): Promise<{ email: number; sms: number; skipped: number; failed: number }> {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return { email: 0, sms: 0, skipped: 0, failed: 0 };
  const invitees = await prisma.invitee.findMany({
    where: { campaignId, id: { in: inviteeIds } },
    include: { invitations: true },
  });
  let email = 0, sms = 0, skipped = 0, failed = 0;
  for (const i of invitees) {
    for (const ch of opts.channels) {
      const has = i.invitations.some((x) => x.channel === ch && x.status !== "failed");
      const hasAddr = ch === "email" ? !!i.email : !!i.phoneE164;
      if (!hasAddr) { skipped++; continue; }
      if (opts.onlyUnsent && has) { skipped++; continue; }
      const r = ch === "email" ? await sendEmail(campaign, i) : await sendSms(campaign, i);
      if (r.ok) { if (ch === "email") email++; else sms++; } else failed++;
    }
  }
  return { email, sms, skipped, failed };
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
