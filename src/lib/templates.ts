import { prisma } from "./db";
import { isNotFound } from "./prisma-errors";

export const TEMPLATE_KINDS = ["email", "sms"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export type TemplateInput = {
  name: string;
  kind: TemplateKind;
  locale: "en" | "ar";
  subject?: string | null;
  body: string;
  tags?: string | null;
};

export type TemplateResult =
  | { ok: true; templateId: string }
  | { ok: false; reason: "missing_name" | "missing_body" | "invalid_kind" | "not_found" };

export const GOVERNMENT_TEMPLATE_PACK: ReadonlyArray<TemplateInput> = [
  {
    name: "Ministry Invitation - Email (AR)",
    kind: "email",
    locale: "ar",
    subject: "دعوة رسمية - {{campaign}}",
    body:
      "السلام عليكم ورحمة الله وبركاته،\n\nيسرنا دعوتكم لحضور {{campaign}}.\nالموعد: {{eventAt}}\nالمكان: {{venue}}\n\nيرجى تأكيد الحضور عبر الرابط التالي:\n{{rsvpUrl}}\n\nمع خالص التقدير،\n{{brand}}",
    tags: "starter,government,ministry,formal,invitation,ar,email",
  },
  {
    name: "Ministry Invitation - Email (EN)",
    kind: "email",
    locale: "en",
    subject: "Formal invitation - {{campaign}}",
    body:
      "Dear {{name}},\n\nYou are cordially invited to attend {{campaign}}.\nDate: {{eventAt}}\nVenue: {{venue}}\n\nPlease confirm your attendance using the link below:\n{{rsvpUrl}}\n\nWith regards,\n{{brand}}",
    tags: "starter,government,ministry,formal,invitation,en,email",
  },
  {
    name: "Ministry Reminder - Email (AR)",
    kind: "email",
    locale: "ar",
    subject: "تذكير بالحضور - {{campaign}}",
    body:
      "نحيطكم علماً بأن {{campaign}} سيقام في {{eventAt}} بموقع {{venue}}.\n\nإذا لم تؤكدوا الحضور بعد، يرجى استخدام الرابط التالي:\n{{rsvpUrl}}\n\nوتفضلوا بقبول فائق الاحترام،\n{{brand}}",
    tags: "starter,government,ministry,formal,reminder,ar,email",
  },
  {
    name: "Ministry Reminder - Email (EN)",
    kind: "email",
    locale: "en",
    subject: "Attendance reminder - {{campaign}}",
    body:
      "This is a reminder for {{campaign}}, scheduled for {{eventAt}} at {{venue}}.\n\nIf you have not yet replied, please confirm using the link below:\n{{rsvpUrl}}\n\nSincerely,\n{{brand}}",
    tags: "starter,government,ministry,formal,reminder,en,email",
  },
  {
    name: "Ministry Invitation - SMS (AR)",
    kind: "sms",
    locale: "ar",
    body: "ندعوكم لحضور {{campaign}} في {{eventAt}}. تأكيد الحضور: {{rsvpUrl}} - {{brand}}",
    tags: "starter,government,ministry,formal,invitation,ar,sms",
  },
  {
    name: "Ministry Invitation - SMS (EN)",
    kind: "sms",
    locale: "en",
    body: "You are invited to {{campaign}} on {{eventAt}}. RSVP: {{rsvpUrl}} - {{brand}}",
    tags: "starter,government,ministry,formal,invitation,en,sms",
  },
  {
    name: "Ministry RSVP Reminder - SMS (AR)",
    kind: "sms",
    locale: "ar",
    body: "تذكير بتأكيد حضور {{campaign}}. رابط الرد: {{rsvpUrl}} - {{brand}}",
    tags: "starter,government,ministry,formal,reminder,ar,sms",
  },
  {
    name: "Ministry RSVP Reminder - SMS (EN)",
    kind: "sms",
    locale: "en",
    body: "Reminder to confirm attendance for {{campaign}}: {{rsvpUrl}} - {{brand}}",
    tags: "starter,government,ministry,formal,reminder,en,sms",
  },
];

export function buildMissingGovernmentTemplates(existingNames: Iterable<string>): TemplateInput[] {
  const existing = new Set(existingNames);
  return GOVERNMENT_TEMPLATE_PACK.filter((tpl) => !existing.has(tpl.name)).map((tpl) => ({ ...tpl }));
}

export async function loadGovernmentTemplatePack(tenantId: string, createdBy?: string | null) {
  const existing = await prisma.template.findMany({
    where: { tenantId, name: { in: GOVERNMENT_TEMPLATE_PACK.map((tpl) => tpl.name) } },
    select: { name: true },
  });
  const missing = buildMissingGovernmentTemplates(existing.map((row) => row.name));
  if (missing.length === 0) {
    return { created: 0, skipped: GOVERNMENT_TEMPLATE_PACK.length };
  }
  const created = await prisma.template.createMany({
    data: missing.map((tpl) => ({
      name: tpl.name,
      tenantId,
      kind: tpl.kind,
      locale: tpl.locale,
      subject: tpl.kind === "email" ? tpl.subject ?? null : null,
      body: tpl.body,
      tags: tpl.tags ?? null,
      createdBy: createdBy ?? null,
    })),
  });
  return { created: created.count, skipped: GOVERNMENT_TEMPLATE_PACK.length - created.count };
}

export async function createTemplate(
  tenantId: string,
  input: TemplateInput,
  createdBy?: string | null,
): Promise<TemplateResult> {
  const name = input.name.trim().slice(0, 120);
  const body = input.body.trim().slice(0, 10_000);
  if (!name) return { ok: false, reason: "missing_name" };
  if (!body) return { ok: false, reason: "missing_body" };
  if (!(TEMPLATE_KINDS as readonly string[]).includes(input.kind)) {
    return { ok: false, reason: "invalid_kind" };
  }
    const row = await prisma.template.create({
      data: {
        tenantId,
        name,
      kind: input.kind,
      locale: input.locale === "ar" ? "ar" : "en",
      subject: input.kind === "email" ? (input.subject ?? "").trim().slice(0, 300) || null : null,
      body,
      tags: (input.tags ?? "").trim().slice(0, 300) || null,
      createdBy: createdBy ?? null,
    },
  });
  return { ok: true, templateId: row.id };
}

export async function updateTemplate(
  tenantId: string,
  id: string,
  input: TemplateInput,
): Promise<TemplateResult> {
  const name = input.name.trim().slice(0, 120);
  const body = input.body.trim().slice(0, 10_000);
  if (!name) return { ok: false, reason: "missing_name" };
  if (!body) return { ok: false, reason: "missing_body" };
  try {
    const existing = await prisma.template.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!existing) return { ok: false, reason: "not_found" };
    await prisma.template.update({
      where: { id },
      data: {
        name,
        kind: input.kind,
        locale: input.locale === "ar" ? "ar" : "en",
        subject: input.kind === "email" ? (input.subject ?? "").trim().slice(0, 300) || null : null,
        body,
        tags: (input.tags ?? "").trim().slice(0, 300) || null,
      },
    });
    return { ok: true, templateId: id };
  } catch (e) {
    throw e;
  }
}

export async function archiveTemplate(tenantId: string, id: string) {
  await prisma.template.updateMany({ where: { id, tenantId }, data: { archivedAt: new Date() } });
}

export async function unarchiveTemplate(tenantId: string, id: string) {
  await prisma.template.updateMany({ where: { id, tenantId }, data: { archivedAt: null } });
}

export async function deleteTemplateRecord(tenantId: string, id: string) {
  await prisma.template.deleteMany({ where: { id, tenantId } });
}

export async function listTemplates(
  tenantId: string,
  opts: { kind?: TemplateKind; locale?: "en" | "ar"; includeArchived?: boolean } = {},
) {
  return prisma.template.findMany({
    where: {
      tenantId,
      ...(opts.includeArchived ? {} : { archivedAt: null }),
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.locale ? { locale: opts.locale } : {}),
    },
    orderBy: [{ name: "asc" }],
  });
}

export async function getTemplate(tenantId: string, id: string) {
  return prisma.template.findFirst({ where: { id, tenantId } });
}
