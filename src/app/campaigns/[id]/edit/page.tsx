import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { CampaignForm } from "@/components/CampaignForm";
import { ConfirmButton } from "@/components/ConfirmButton";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole, requireRole } from "@/lib/auth";
import { parseLocalInput } from "@/lib/time";
import { logAction } from "@/lib/audit";
import { teamsEnabled, canSeeCampaign, canSeeCampaignRow, teamIdsForUser } from "@/lib/teams";
import { safeBrandUrl } from "@/lib/attachments";
import { parseWhatsAppCampaignFields } from "@/lib/campaign-whatsapp-form";

export const dynamic = "force-dynamic";

async function updateCampaign(id: string, formData: FormData) {
  "use server";
  const me = await requireRole("editor");
  const isAdmin = hasRole(me, "admin");
  // Must be able to see the campaign in the first place. Prevents
  // an editor POST-ing updates to a team-B campaignId by replaying
  // a bound action reference.
  if (!(await canSeeCampaign(me.id, isAdmin, id))) redirect(`/campaigns`);

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
      const allowed = new Set(await teamIdsForUser(me.id));
      if (submitted === null || allowed.has(submitted)) {
        teamPatch = { teamId: submitted };
      }
      // else: drop the patch so the current teamId is preserved.
    }
  }

  // P17-D.1: mirror createCampaign's WhatsApp-campaign parse + FK
  // existence check. Same silent-drop-on-dangling-id posture so editing
  // a campaign that referenced an upload which has since been deleted
  // doesn't 500 — instead the Campaign row's FK is nulled on save and
  // the `no_whatsapp_document` blocker shows the gap on the next
  // propose_send.
  const wa = parseWhatsAppCampaignFields(formData);
  let whatsappDocumentUploadId: string | null = wa.whatsappDocumentUploadId;
  if (whatsappDocumentUploadId !== null) {
    const exists = await prisma.fileUpload.findUnique({
      where: { id: whatsappDocumentUploadId },
      select: { id: true },
    });
    if (!exists) whatsappDocumentUploadId = null;
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
  // Admins see every campaign, but run the check anyway so the action
  // still returns cleanly if the campaignId was spoofed to something
  // that doesn't exist (rather than throwing on delete).
  if (!(await canSeeCampaign(me.id, true, id))) redirect(`/campaigns`);
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

export default async function EditCampaign({ params }: { params: { id: string } }) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const c = await prisma.campaign.findUnique({ where: { id: params.id } });
  if (!c) notFound();
  if (!(await canSeeCampaignRow(me.id, hasRole(me, "admin"), c.teamId))) notFound();
  const inviteeCount = await prisma.invitee.count({ where: { campaignId: c.id } });
  // P17-D.3: resolve the attached WhatsApp PDF's filename so
  // CampaignForm can display it next to the picker instead of just
  // the cuid. Only fires when the campaign actually has an FK set,
  // so no wasted Prisma hit on the common case.
  const whatsappDocumentFilename = c.whatsappDocumentUploadId
    ? (
        await prisma.fileUpload.findUnique({
          where: { id: c.whatsappDocumentUploadId },
          select: { filename: true },
        })
      )?.filename ?? null
    : null;
  // Non-admins see only teams they belong to (plus the current team of
  // the campaign so the picker still reflects its actual assignment
  // and submits don't silently orphan it). Admins see every team.
  const teams = teamsEnabled()
    ? hasRole(me, "admin")
      ? await prisma.team.findMany({ where: { archivedAt: null }, orderBy: { name: "asc" } })
      : await prisma.team.findMany({
          where: {
            archivedAt: null,
            id: { in: [...new Set([...(await teamIdsForUser(me.id)), ...(c.teamId ? [c.teamId] : [])])] },
          },
          orderBy: { name: "asc" },
        })
    : [];
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
      <CampaignForm
        campaign={c}
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
