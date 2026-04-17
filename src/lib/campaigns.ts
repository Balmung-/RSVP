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
