import { prisma } from "./db";

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

export async function createTemplate(
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
  id: string,
  input: TemplateInput,
): Promise<TemplateResult> {
  const name = input.name.trim().slice(0, 120);
  const body = input.body.trim().slice(0, 10_000);
  if (!name) return { ok: false, reason: "missing_name" };
  if (!body) return { ok: false, reason: "missing_body" };
  try {
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
    if (String(e).includes("Record to update not found")) return { ok: false, reason: "not_found" };
    throw e;
  }
}

export async function archiveTemplate(id: string) {
  await prisma.template.update({ where: { id }, data: { archivedAt: new Date() } });
}

export async function unarchiveTemplate(id: string) {
  await prisma.template.update({ where: { id }, data: { archivedAt: null } });
}

export async function deleteTemplateRecord(id: string) {
  await prisma.template.delete({ where: { id } });
}

export async function listTemplates(opts: { kind?: TemplateKind; locale?: "en" | "ar"; includeArchived?: boolean } = {}) {
  return prisma.template.findMany({
    where: {
      ...(opts.includeArchived ? {} : { archivedAt: null }),
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.locale ? { locale: opts.locale } : {}),
    },
    orderBy: [{ name: "asc" }],
  });
}

export async function getTemplate(id: string) {
  return prisma.template.findUnique({ where: { id } });
}
