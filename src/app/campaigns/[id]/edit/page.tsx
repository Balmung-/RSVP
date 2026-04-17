import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { CampaignForm } from "@/components/CampaignForm";
import { ConfirmButton } from "@/components/ConfirmButton";
import { prisma } from "@/lib/db";
import { isAuthed, requireRole } from "@/lib/auth";
import { parseLocalInput } from "@/lib/time";
import { logAction } from "@/lib/audit";

export const dynamic = "force-dynamic";

async function updateCampaign(id: string, formData: FormData) {
  "use server";
  await requireRole("editor");
  const name = String(formData.get("name") ?? "").trim().slice(0, 200);
  if (!name) redirect(`/campaigns/${id}/edit`);
  const rawLocale = String(formData.get("locale") ?? "en").toLowerCase();
  const locale = rawLocale === "ar" ? "ar" : "en";
  const rawColor = String(formData.get("brandColor") ?? "").trim();
  const brandColor = /^#[0-9A-Fa-f]{3,8}$/.test(rawColor) ? rawColor : null;
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
      brandColor,
      brandLogoUrl: safeUrl(String(formData.get("brandLogoUrl") ?? "")),
      brandHeroUrl: safeUrl(String(formData.get("brandHeroUrl") ?? "")),
    },
  });
  redirect(`/campaigns/${id}`);
}

function safeUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > 500) return null;
  if (s.startsWith("/") && !s.startsWith("//")) return s;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? s : null;
  } catch {
    return null;
  }
}

async function deleteCampaign(id: string) {
  "use server";
  await requireRole("admin");
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
  if (!(await isAuthed())) redirect("/login");
  const c = await prisma.campaign.findUnique({ where: { id: params.id } });
  if (!c) notFound();
  const inviteeCount = await prisma.invitee.count({ where: { campaignId: c.id } });
  const bound = updateCampaign.bind(null, c.id);
  const boundDelete = deleteCampaign.bind(null, c.id);

  return (
    <Shell
      title="Edit campaign"
      crumb={
        <span>
          <Link href="/" className="hover:underline">Campaigns</Link>
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
