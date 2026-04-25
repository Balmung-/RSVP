import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { CampaignForm } from "@/components/CampaignForm";
import { ConfirmButton } from "@/components/ConfirmButton";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole, requireActiveTenantId, requireRole } from "@/lib/auth";
import { parseLocalInput } from "@/lib/time";
import { logAction } from "@/lib/audit";
import { teamsEnabled, canSeeCampaign, canSeeCampaignRow, teamIdsForUser } from "@/lib/teams";
import { safeBrandUrl } from "@/lib/attachments";
import { parseWhatsAppCampaignFields } from "@/lib/campaign-whatsapp-form";
import { validateWhatsAppCampaignFields } from "@/lib/campaign-whatsapp-validate";
import { resolveOwnedWhatsAppUpload } from "@/lib/campaign-whatsapp-render";
import { PDF_MIME } from "@/lib/uploads";
import { listTemplates, getTemplate } from "@/lib/templates";
import { TemplatePicker } from "@/components/TemplatePicker";
import { applyCampaignTemplatePrefill } from "@/lib/campaign-template-prefill";
import { setFlash } from "@/lib/flash";

export const dynamic = "force-dynamic";

async function updateCampaign(id: string, formData: FormData) {
  "use server";
  const me = await requireRole("editor");
  const tenantId = requireActiveTenantId(me);
  const isAdmin = hasRole(me, "admin");
  // Must be able to see the campaign in the first place. Prevents
  // an editor POST-ing updates to a team-B campaignId by replaying
  // a bound action reference.
  if (!(await canSeeCampaign(me.id, isAdmin, tenantId, id))) redirect(`/campaigns`);

  const name = String(formData.get("name") ?? "").trim().slice(0, 200);
  if (!name) redirect(`/campaigns/${id}/edit`);
  const rawLocale = String(formData.get("locale") ?? "en").toLowerCase();
  const locale = rawLocale === "ar" ? "ar" : "en";
  const rawColor = String(formData.get("brandColor") ?? "").trim();
  const brandColor = /^#[0-9A-Fa-f]{3,8}$/.test(rawColor) ? rawColor : null;

  // Team reassignment: admins can move a campaign to any team.
  // Non-admins can only set it to one of their own teams (or
  // office-wide / null). If they submit a team id outside that set,
  // we ignore it and keep the existing teamId — never silently
  // transfer ownership to a team they don't belong to.
  let teamPatch: { teamId: string | null } | Record<string, never> = {};
  if (teamsEnabled()) {
    const submitted = String(formData.get("teamId") ?? "").trim() || null;
    if (isAdmin) {
      teamPatch = { teamId: submitted };
    } else {
      const allowed = new Set(await teamIdsForUser(me.id, tenantId));
      if (submitted === null || allowed.has(submitted)) {
        teamPatch = { teamId: submitted };
      }
      // else: drop the patch so the current teamId is preserved.
    }
  }

  // P17-D.1 + D.4: mirror createCampaign's WhatsApp-campaign parse +
  // owned-FK check. Same silent-drop posture when the upload id is
  // dangling, belongs to a different uploader, or has been deleted —
  // the Campaign row's FK is nulled on save and the
  // `no_whatsapp_document` blocker shows the gap on the next
  // propose_send. See `src/app/campaigns/new/page.tsx` for the full
  // rationale on the `uploadedBy = me.id` scope.
  //
  // Behavioural note: if editor A created the campaign with their
  // own PDF attached, editor B editing the same campaign later will
  // see the picker as empty (D.3's filename resolver applies the
  // same scope), and saving without re-uploading will null the FK.
  // That's the "safer than loud" pilot posture — team-shared PDF
  // reuse is a follow-up tranche.
  const wa = parseWhatsAppCampaignFields(formData);
  let whatsappDocumentUploadId: string | null = wa.whatsappDocumentUploadId;
  if (whatsappDocumentUploadId !== null) {
    const owned = await prisma.fileUpload.findFirst({
      where: {
        id: whatsappDocumentUploadId,
        tenantId,
        uploadedBy: me.id,
        contentType: PDF_MIME,
      },
      select: { id: true },
    });
    if (!owned) whatsappDocumentUploadId = null;
  }
  const whatsappValidation = validateWhatsAppCampaignFields({
    ...wa,
    whatsappDocumentUploadId,
  });
  if (!whatsappValidation.ok) {
    setFlash({
      kind: "warn",
      text: whatsappValidation.text,
      detail: whatsappValidation.detail,
    });
    redirect(`/campaigns/${id}/edit`);
  }

  await prisma.campaign.update({
    where: { id },
    data: {
      name,
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
      ...teamPatch,
    },
  });
  redirect(`/campaigns/${id}`);
}

async function deleteCampaign(id: string) {
  "use server";
  const me = await requireRole("admin");
  const tenantId = requireActiveTenantId(me);
  // Admins see every campaign, but run the check anyway so the action
  // still returns cleanly if the campaignId was spoofed to something
  // that doesn't exist (rather than throwing on delete).
  if (!(await canSeeCampaign(me.id, true, tenantId, id))) redirect(`/campaigns`);
  const campaign = await prisma.campaign.findUnique({ where: { id }, select: { name: true } });
  await prisma.campaign.delete({ where: { id } });
  await logAction({
    kind: "campaign.deleted",
    refType: "campaign",
    refId: id,
    data: { name: campaign?.name },
  });
  redirect("/");
}

export default async function EditCampaign({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { tpl?: string; emailTpl?: string; smsTpl?: string };
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const tenantId = requireActiveTenantId(me);
  const c = await prisma.campaign.findUnique({ where: { id: params.id } });
  if (!c) notFound();
  if (!(await canSeeCampaignRow(me.id, hasRole(me, "admin"), tenantId, c.tenantId, c.teamId))) notFound();
  const inviteeCount = await prisma.invitee.count({ where: { campaignId: c.id } });
  // P17-D.3 + D.4 + D.5 + D.6: resolve the attached WhatsApp PDF's
  // {id, filename} pair ONLY when the current viewer owns the
  // upload. Scoped on `uploadedBy = me.id` — the same scope the
  // updateCampaign server action enforces — so a non-owner never
  // sees another editor's filename, AND (D.5) never has the
  // unauthorized upload cuid reach the rendered HTML.
  //
  // D.5 closed the read/leak path GPT flagged on 3e5a9b2: before
  // D.5, `CampaignForm` received the raw `campaign` row and
  // forwarded `campaign.whatsappDocumentUploadId` into
  // `WhatsAppDocumentInput`'s `defaultValue`, which then emitted
  // the id in a hidden <input> — letting a non-owner inspect the
  // DOM, lift the cuid, and fetch `/api/files/<id>` (public by
  // id). We compute the ownership result server-side and pass a
  // `safeCampaign` into the form with the FK nulled when the
  // scope fails. `no_whatsapp_document` still surfaces the gap on
  // next propose_send; the save-path FK-null posture from D.1 +
  // D.4 still applies (an unauthorized editor saving without
  // re-uploading nulls the row-side FK).
  //
  // D.6: the pure ownership-masking + filename-resolve step lives
  // in `@/lib/campaign-whatsapp-render` so it can be unit-pinned
  // without a Prisma mock (see
  // `tests/unit/campaign-whatsapp-render.test.ts`). The impure
  // Prisma lookup stays here so the calling page keeps full
  // control of the ownership scope (today: `uploadedBy = me.id`;
  // a future team-shared or admin-carve-out scope swaps the
  // lookup without touching the masking seam).
  const ownedUpload = c.whatsappDocumentUploadId
    ? await prisma.fileUpload.findFirst({
        where: {
          id: c.whatsappDocumentUploadId,
          tenantId,
          uploadedBy: me.id,
          contentType: PDF_MIME,
        },
        select: { id: true, filename: true },
      })
    : null;
  const { safeCampaign, whatsappDocumentFilename } =
    resolveOwnedWhatsAppUpload(c, ownedUpload);
  // Non-admins see only teams they belong to (plus the current team of
  // the campaign so the picker still reflects its actual assignment
  // and submits don't silently orphan it). Admins see every team.
  const [teams, templates] = await Promise.all([
    teamsEnabled()
      ? hasRole(me, "admin")
        ? prisma.team.findMany({ where: { tenantId, archivedAt: null }, orderBy: { name: "asc" } })
        : prisma.team.findMany({
            where: {
              tenantId,
              archivedAt: null,
              id: { in: [...new Set([...(await teamIdsForUser(me.id, tenantId)), ...(c.teamId ? [c.teamId] : [])])] },
            },
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
  const formCampaign = applyCampaignTemplatePrefill(
    safeCampaign,
    emailLibraryTemplate,
    smsLibraryTemplate,
  );
  const emailTemplates = templates.filter((template) => template.kind === "email");
  const smsTemplates = templates.filter((template) => template.kind === "sms");
  const emailBaseHref = `/campaigns/${c.id}/edit${selectedSmsId ? `?smsTpl=${encodeURIComponent(selectedSmsId)}` : ""}`;
  const smsBaseHref = `/campaigns/${c.id}/edit${selectedEmailId ? `?emailTpl=${encodeURIComponent(selectedEmailId)}` : ""}`;
  const bound = updateCampaign.bind(null, c.id);
  const boundDelete = deleteCampaign.bind(null, c.id);

  return (
    <Shell
      title="Edit campaign"
      crumb={
        <span>
          <Link href="/campaigns" className="hover:underline">Campaigns</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <Link href={`/campaigns/${c.id}`} className="hover:underline">{c.name}</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>Edit</span>
        </span>
      }
    >
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
        campaign={formCampaign}
        action={bound}
        submitLabel="Save changes"
        cancelHref={`/campaigns/${c.id}`}
        teams={teams}
        whatsappDocumentFilename={whatsappDocumentFilename}
      />
      <form action={boundDelete} className="mt-8 max-w-3xl">
        <ConfirmButton
          prompt={`Delete "${c.name}" and all ${inviteeCount} invitee${inviteeCount === 1 ? "" : "s"}, invitations, and responses? This cannot be undone.`}
        >
          Delete campaign permanently
        </ConfirmButton>
        <p className="text-xs text-ink-400 mt-2">
          Deletes invitees, invitations, responses, and event log entries for this campaign. Cannot be undone.
        </p>
      </form>
    </Shell>
  );
}
