import { redirect } from "next/navigation";
import Link from "next/link";
import type { Campaign } from "@prisma/client";
import { Shell } from "@/components/Shell";
import { CampaignForm } from "@/components/CampaignForm";
import { TemplatePicker } from "@/components/TemplatePicker";
import { prisma } from "@/lib/db";
import { requireActiveTenantId, requireRole, hasRole, getCurrentUser } from "@/lib/auth";
import { parseLocalInput } from "@/lib/time";
import { teamsEnabled, teamIdsForUser } from "@/lib/teams";
import { listTemplates, getTemplate } from "@/lib/templates";
import { safeBrandUrl } from "@/lib/attachments";
import { parseWhatsAppCampaignFields } from "@/lib/campaign-whatsapp-form";
import { PDF_MIME } from "@/lib/uploads";
import { applyCampaignTemplatePrefill } from "@/lib/campaign-template-prefill";

export const dynamic = "force-dynamic";

async function createCampaign(formData: FormData) {
  "use server";
  const me = await requireRole("editor");
  const tenantId = requireActiveTenantId(me);
  const name = String(formData.get("name") ?? "").trim().slice(0, 200);
  if (!name) return;
  const rawLocale = String(formData.get("locale") ?? "en").toLowerCase();
  const locale = rawLocale === "ar" ? "ar" : "en";
  const rawColor = String(formData.get("brandColor") ?? "").trim();
  const brandColor = /^#[0-9A-Fa-f]{3,8}$/.test(rawColor) ? rawColor : null;

  const teamIdRaw = String(formData.get("teamId") ?? "").trim();
  let teamId: string | null = null;
  if (teamIdRaw && teamsEnabled()) {
    if (hasRole(me, "admin")) {
      teamId = teamIdRaw;
    } else {
      const allowed = new Set(await teamIdsForUser(me.id, tenantId));
      teamId = allowed.has(teamIdRaw) ? teamIdRaw : null;
    }
  }

  const wa = parseWhatsAppCampaignFields(formData);
  let whatsappDocumentUploadId: string | null = wa.whatsappDocumentUploadId;
  if (whatsappDocumentUploadId !== null) {
    const owned = await prisma.fileUpload.findFirst({
      where: {
        id: whatsappDocumentUploadId,
        uploadedBy: me.id,
        contentType: PDF_MIME,
      },
      select: { id: true },
    });
    if (!owned) whatsappDocumentUploadId = null;
  }

  const c = await prisma.campaign.create({
    data: {
      name,
      tenantId,
      description: String(formData.get("description") ?? "").trim().slice(0, 2000) || null,
      venue: String(formData.get("venue") ?? "").trim().slice(0, 200) || null,
      locale,
      eventAt: parseLocalInput(String(formData.get("eventAt") ?? "")),
      rsvpDeadline: parseLocalInput(String(formData.get("rsvpDeadline") ?? "")),
      subjectEmail: String(formData.get("subjectEmail") ?? "").trim().slice(0, 300) || null,
      templateEmail: String(formData.get("templateEmail") ?? "").trim().slice(0, 5000) || null,
      templateSms: String(formData.get("templateSms") ?? "").trim().slice(0, 500) || null,
      templateWhatsAppName: wa.templateWhatsAppName,
      templateWhatsAppLanguage: wa.templateWhatsAppLanguage,
      templateWhatsAppVariables: wa.templateWhatsAppVariables,
      whatsappDocumentUploadId,
      brandColor,
      brandLogoUrl: safeBrandUrl(String(formData.get("brandLogoUrl") ?? "")),
      brandHeroUrl: safeBrandUrl(String(formData.get("brandHeroUrl") ?? "")),
      teamId,
    },
  });
  redirect(`/campaigns/${c.id}`);
}

export default async function NewCampaign({
  searchParams,
}: {
  searchParams: { tpl?: string; emailTpl?: string; smsTpl?: string };
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const tenantId = requireActiveTenantId(me);
  const isAdmin = hasRole(me, "admin");
  const [teams, templates] = await Promise.all([
    teamsEnabled()
      ? isAdmin
        ? prisma.team.findMany({ where: { tenantId, archivedAt: null }, orderBy: { name: "asc" } })
        : prisma.team.findMany({
            where: { tenantId, archivedAt: null, id: { in: await teamIdsForUser(me.id, tenantId) } },
            orderBy: { name: "asc" },
          })
      : Promise.resolve([]),
    listTemplates(tenantId),
  ]);

  const selectedEmailId = searchParams.emailTpl ?? null;
  const selectedSmsId = searchParams.smsTpl ?? null;
  const legacyTpl = searchParams.tpl ? await getTemplate(tenantId, searchParams.tpl) : null;
  const [emailTemplate, smsTemplate] = await Promise.all([
    selectedEmailId
      ? getTemplate(tenantId, selectedEmailId)
      : legacyTpl?.kind === "email"
        ? Promise.resolve(legacyTpl)
        : Promise.resolve(null),
    selectedSmsId
      ? getTemplate(tenantId, selectedSmsId)
      : legacyTpl?.kind === "sms"
        ? Promise.resolve(legacyTpl)
        : Promise.resolve(null),
  ]);
  const emailLibraryTemplate =
    emailTemplate?.kind === "email"
      ? {
          kind: "email" as const,
          subject: emailTemplate.subject,
          body: emailTemplate.body,
        }
      : null;
  const smsLibraryTemplate =
    smsTemplate?.kind === "sms"
      ? {
          kind: "sms" as const,
          subject: smsTemplate.subject,
          body: smsTemplate.body,
        }
      : null;

  const preset = applyCampaignTemplatePrefill<Partial<Campaign>>(
    emailTemplate?.kind === "email" ? { locale: emailTemplate.locale } : null,
    emailLibraryTemplate,
    smsLibraryTemplate,
  );
  const emailTemplates = templates.filter((template) => template.kind === "email");
  const smsTemplates = templates.filter((template) => template.kind === "sms");
  const emailBaseHref = `/campaigns/new${selectedSmsId ? `?smsTpl=${encodeURIComponent(selectedSmsId)}` : ""}`;
  const smsBaseHref = `/campaigns/new${selectedEmailId ? `?emailTpl=${encodeURIComponent(selectedEmailId)}` : ""}`;

  return (
    <Shell title="New campaign" crumb={<Link href="/campaigns">Campaigns</Link>}>
      <TemplatePicker
        templates={emailTemplates}
        selected={selectedEmailId ?? (legacyTpl?.kind === "email" ? legacyTpl.id : null)}
        baseHref={emailBaseHref}
        label="Apply email copy from library"
        paramKey="emailTpl"
      />
      <TemplatePicker
        templates={smsTemplates}
        selected={selectedSmsId ?? (legacyTpl?.kind === "sms" ? legacyTpl.id : null)}
        baseHref={smsBaseHref}
        label="Apply SMS copy from library"
        paramKey="smsTpl"
      />
      <CampaignForm
        campaign={preset}
        action={createCampaign}
        submitLabel="Create campaign"
        cancelHref="/campaigns"
        teams={teams}
      />
    </Shell>
  );
}
