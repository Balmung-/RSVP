import { prisma } from "./db";
import { dedupKey, normalizeEmail, normalizePhone } from "./contact";
import { isUniqueViolation } from "./prisma-errors";
import type { Contact, Prisma } from "@prisma/client";

export const VIP_TIERS = ["royal", "minister", "vip", "standard"] as const;
export type VipTier = (typeof VIP_TIERS)[number];

export const VIP_LABEL: Record<VipTier, string> = {
  royal: "Royal",
  minister: "Ministerial",
  vip: "VIP",
  standard: "Standard",
};

// A VIP-first sort order — royal → minister → vip → standard.
const VIP_RANK: Record<VipTier, number> = { royal: 0, minister: 1, vip: 2, standard: 3 };

export type ContactInput = {
  fullName: string;
  title?: string | null;
  organization?: string | null;
  email?: string | null;
  phone?: string | null;
  preferredLocale?: string | null;
  vipTier: VipTier;
  tags?: string | null;
  dietary?: string | null;
  dress?: string | null;
  securityNotes?: string | null;
  notes?: string | null;
};

export type ContactMutationResult =
  | { ok: true; contactId: string }
  | { ok: false; reason: "missing_name" | "missing_contact" | "invalid_email" | "invalid_phone" | "duplicate" | "not_found" };

function normalize(input: ContactInput) {
  const fullName = input.fullName.trim().slice(0, 200);
  if (!fullName) return { error: "missing_name" as const };
  const rawEmail = (input.email ?? "").trim();
  const rawPhone = (input.phone ?? "").trim();
  const email = normalizeEmail(rawEmail);
  if (rawEmail && !email) return { error: "invalid_email" as const };
  const phoneE164 = normalizePhone(rawPhone, "SA");
  if (rawPhone && !phoneE164) return { error: "invalid_phone" as const };
  if (!email && !phoneE164) return { error: "missing_contact" as const };
  const vip = VIP_TIERS.includes(input.vipTier) ? input.vipTier : ("standard" as VipTier);
  return {
    ok: true as const,
    data: {
      fullName,
      title: (input.title ?? "").trim().slice(0, 100) || null,
      organization: (input.organization ?? "").trim().slice(0, 200) || null,
      email,
      phoneE164,
      preferredLocale:
        input.preferredLocale === "ar" || input.preferredLocale === "en"
          ? input.preferredLocale
          : null,
      vipTier: vip,
      tags: (input.tags ?? "").trim().slice(0, 500) || null,
      dietary: (input.dietary ?? "").trim().slice(0, 500) || null,
      dress: (input.dress ?? "").trim().slice(0, 200) || null,
      securityNotes: (input.securityNotes ?? "").trim().slice(0, 1000) || null,
      notes: (input.notes ?? "").trim().slice(0, 2000) || null,
    },
  };
}

export async function createContact(
  input: ContactInput,
  createdBy?: string | null,
): Promise<ContactMutationResult> {
  const n = normalize(input);
  if ("error" in n && n.error) return { ok: false, reason: n.error };
  if (!("ok" in n)) return { ok: false, reason: "missing_name" };
  const key = dedupKey(n.data.email, n.data.phoneE164);
  try {
    const row = await prisma.contact.create({
      data: { ...n.data, dedupKey: key, createdBy: createdBy ?? null },
    });
    return { ok: true, contactId: row.id };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: "duplicate" };
    throw e;
  }
}

export async function updateContact(
  contactId: string,
  input: ContactInput,
): Promise<ContactMutationResult> {
  const existing = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!existing) return { ok: false, reason: "not_found" };
  const n = normalize(input);
  if ("error" in n && n.error) return { ok: false, reason: n.error };
  if (!("ok" in n)) return { ok: false, reason: "missing_name" };
  const key = dedupKey(n.data.email, n.data.phoneE164);
  try {
    await prisma.contact.update({ where: { id: contactId }, data: { ...n.data, dedupKey: key } });
    return { ok: true, contactId };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: "duplicate" };
    throw e;
  }
}

export async function archiveContact(contactId: string) {
  await prisma.contact.update({
    where: { id: contactId },
    data: { archivedAt: new Date() },
  });
}

export async function unarchiveContact(contactId: string) {
  await prisma.contact.update({
    where: { id: contactId },
    data: { archivedAt: null },
  });
}

export async function deleteContactRecord(contactId: string) {
  await prisma.contact.delete({ where: { id: contactId } });
}

// Find, filter, search. Admin UI consumer.
// Returns a Set keyed by `email|<addr>` or `sms|<phone>` for every row
// in Unsubscribe that matches one of the supplied contacts. Batches the
// lookup into a single query so the list view stays cheap.
export async function resolveContactOptOuts(
  contacts: Array<{ email: string | null; phoneE164: string | null }>,
): Promise<Set<string>> {
  const emails = contacts.map((c) => c.email?.toLowerCase()).filter((e): e is string => !!e);
  const phones = contacts.map((c) => c.phoneE164).filter((p): p is string => !!p);
  if (emails.length === 0 && phones.length === 0) return new Set();
  const rows = await prisma.unsubscribe.findMany({
    where: {
      OR: [
        ...(emails.length ? [{ email: { in: emails } }] : []),
        ...(phones.length ? [{ phoneE164: { in: phones } }] : []),
      ],
    },
    select: { email: true, phoneE164: true },
  });
  const out = new Set<string>();
  for (const r of rows) {
    if (r.email) out.add(`email|${r.email}`);
    if (r.phoneE164) out.add(`sms|${r.phoneE164}`);
  }
  return out;
}

export function contactOptOutState(
  contact: { email: string | null; phoneE164: string | null },
  set: Set<string>,
): { email: boolean; sms: boolean; any: boolean } {
  const email = !!contact.email && set.has(`email|${contact.email.toLowerCase()}`);
  const sms = !!contact.phoneE164 && set.has(`sms|${contact.phoneE164}`);
  return { email, sms, any: email || sms };
}

export async function searchContacts(params: {
  q?: string;
  tier?: VipTier | "all";
  includeArchived?: boolean;
  skip?: number;
  take?: number;
}) {
  const where: Prisma.ContactWhereInput = {
    ...(params.includeArchived ? {} : { archivedAt: null }),
    ...(params.tier && params.tier !== "all" ? { vipTier: params.tier } : {}),
    ...(params.q && params.q.trim()
      ? {
          OR: [
            { fullName: { contains: params.q, mode: "insensitive" } },
            { email: { contains: params.q, mode: "insensitive" } },
            { phoneE164: { contains: params.q } },
            { organization: { contains: params.q, mode: "insensitive" } },
            { tags: { contains: params.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.contact.count({ where }),
    prisma.contact.findMany({
      where,
      orderBy: [{ vipTier: "asc" }, { fullName: "asc" }],
      skip: params.skip ?? 0,
      take: params.take ?? 100,
      include: { _count: { select: { invitees: true } } },
    }),
  ]);
  return { total, rows };
}

// VIP watch: top tiers across active campaigns, with response state.
// Accepts an optional Campaign where scope so the dashboard can filter
// to the caller's teams when TEAMS_ENABLED. Empty scope = office-wide.
export async function vipWatch(campaignScope: Prisma.CampaignWhereInput = {}) {
  const invitees = await prisma.invitee.findMany({
    where: {
      contact: { vipTier: { in: ["royal", "minister", "vip"] } },
      campaign: { status: { in: ["draft", "active", "sending"] }, ...campaignScope },
    },
    include: {
      contact: { select: { fullName: true, vipTier: true, organization: true } },
      response: { select: { attending: true, guestsCount: true } },
      campaign: { select: { id: true, name: true } },
    },
    orderBy: [{ createdAt: "desc" }],
    take: 20,
  });
  return invitees
    .filter((i) => i.contact)
    .sort((a, b) => {
      const ra = VIP_RANK[(a.contact!.vipTier as VipTier) ?? "standard"] ?? 99;
      const rb = VIP_RANK[(b.contact!.vipTier as VipTier) ?? "standard"] ?? 99;
      return ra - rb;
    });
}

export function isArchived(c: Contact): boolean {
  return !!c.archivedAt;
}
