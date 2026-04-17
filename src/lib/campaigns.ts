import { prisma } from "./db";
import { dedupKey, normalizeEmail, normalizePhone, parseContactsText } from "./contact";
import { sendEmail, sendSms } from "./delivery";
import type { Prisma } from "@prisma/client";

const COUNTRY = (process.env.DEFAULT_COUNTRY ?? "SA") as "SA";

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
  warnings: Array<{ row: number; reason: string }>;
};

export async function importInvitees(campaignId: string, text: string): Promise<ImportReport> {
  const rows = parseContactsText(text) as ImportRow[];
  const report: ImportReport = {
    total: rows.length,
    created: 0,
    duplicatesWithin: 0,
    duplicatesExisting: 0,
    invalid: 0,
    warnings: [],
  };

  const seen = new Set<string>();
  const batch: Prisma.InviteeCreateManyInput[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const fullName = (r.full_name || r.name || "").trim();
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
      title: (r.title || "").trim() || null,
      organization: (r.organization || r.org || "").trim() || null,
      email,
      phoneE164: phone,
      locale: (r.locale || "").trim().toLowerCase() || null,
      tags: (r.tags || "").trim() || null,
      notes: (r.notes || "").trim() || null,
      guestsAllowed: clampInt(r.guests, 0, 10, 0),
      dedupKey: key,
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
  const [total, responded, attending, declined, sentEmail, sentSms] = await Promise.all([
    prisma.invitee.count({ where: { campaignId } }),
    prisma.response.count({ where: { campaignId } }),
    prisma.response.count({ where: { campaignId, attending: true } }),
    prisma.response.count({ where: { campaignId, attending: false } }),
    prisma.invitation.count({ where: { campaignId, channel: "email", status: { in: ["sent", "delivered"] } } }),
    prisma.invitation.count({ where: { campaignId, channel: "sms", status: { in: ["sent", "delivered"] } } }),
  ]);
  const guests = await prisma.response.aggregate({
    where: { campaignId, attending: true },
    _sum: { guestsCount: true },
  });
  return {
    total,
    responded,
    pending: total - responded,
    attending,
    declined,
    guests: guests._sum.guestsCount ?? 0,
    headcount: attending + (guests._sum.guestsCount ?? 0),
    sentEmail,
    sentSms,
  };
}

export async function sendCampaign(
  campaignId: string,
  opts: { channel: "email" | "sms" | "both"; onlyUnsent: boolean } = { channel: "both", onlyUnsent: true },
) {
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const invitees = await prisma.invitee.findMany({
    where: { campaignId },
    include: { invitations: true },
  });

  let email = 0, sms = 0, skipped = 0, failed = 0;

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

  return { email, sms, skipped, failed };
}

export async function findDuplicates(campaignId: string) {
  // Exact-key dupes would already be blocked by @@unique — this surfaces *cross-key*
  // suspects: same name, or same phone with different email, etc. Read-only.
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
