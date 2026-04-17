import { redirect } from "next/navigation";
import Link from "next/link";
import type { Campaign } from "@prisma/client";
import { Shell } from "@/components/Shell";
import { CampaignForm } from "@/components/CampaignForm";
import { TemplatePicker } from "@/components/TemplatePicker";
import { prisma } from "@/lib/db";
import { isAuthed, requireRole } from "@/lib/auth";
import { parseLocalInput } from "@/lib/time";
import { teamsEnabled } from "@/lib/teams";
import { listTemplates, getTemplate } from "@/lib/templates";

export const dynamic = "force-dynamic";

async function createCampaign(formData: FormData) {
  "use server";
  await requireRole("editor");
  const name = String(formData.get("name") ?? "").trim().slice(0, 200);
  if (!name) return;
  const rawLocale = String(formData.get("locale") ?? "en").toLowerCase();
  const locale = rawLocale === "ar" ? "ar" : "en";
  const rawColor = String(formData.get("brandColor") ?? "").trim();
  const brandColor = /^#[0-9A-Fa-f]{3,8}$/.test(rawColor) ? rawColor : null;
  const teamIdRaw = String(formData.get("teamId") ?? "").trim();
  const teamId = teamIdRaw && teamsEnabled() ? teamIdRaw : null;
  const c = await prisma.campaign.create({
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
      teamId,
    },
  });
  redirect(`/campaigns/${c.id}`);
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

export default async function NewCampaign({
  searchParams,
}: {
  searchParams: { tpl?: string };
}) {
  if (!(await isAuthed())) redirect("/login");
  const [teams, templates] = await Promise.all([
    teamsEnabled()
      ? prisma.team.findMany({ where: { archivedAt: null }, orderBy: { name: "asc" } })
      : Promise.resolve([]),
    listTemplates(),
  ]);

  // Prefill from a template if requested. We don't write anything — just
  // seed the form's defaultValues.
  let preset: Partial<Campaign> | null = null;
  if (searchParams.tpl) {
    const tpl = await getTemplate(searchParams.tpl);
    if (tpl) {
      preset = {
        locale: tpl.locale,
        subjectEmail: tpl.kind === "email" ? tpl.subject ?? null : null,
        templateEmail: tpl.kind === "email" ? tpl.body : null,
        templateSms: tpl.kind === "sms" ? tpl.body : null,
      };
    }
  }

  return (
    <Shell title="New campaign" crumb={<Link href="/campaigns">Campaigns</Link>}>
      <TemplatePicker
        templates={templates}
        selected={searchParams.tpl ?? null}
        baseHref="/campaigns/new"
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
