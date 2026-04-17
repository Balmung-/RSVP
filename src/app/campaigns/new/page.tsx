import { redirect } from "next/navigation";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { CampaignForm } from "@/components/CampaignForm";
import { prisma } from "@/lib/db";
import { isAuthed, requireRole } from "@/lib/auth";
import { parseLocalInput } from "@/lib/time";

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
    },
  });
  redirect(`/campaigns/${c.id}`);
}

function safeUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > 500) return null;
  // Accept same-origin paths (from our /api/files upload endpoint).
  if (s.startsWith("/") && !s.startsWith("//")) return s;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? s : null;
  } catch {
    return null;
  }
}

export default async function NewCampaign() {
  if (!(await isAuthed())) redirect("/login");
  return (
    <Shell title="New campaign" crumb={<Link href="/">Campaigns</Link>}>
      <CampaignForm action={createCampaign} submitLabel="Create campaign" cancelHref="/" />
    </Shell>
  );
}
