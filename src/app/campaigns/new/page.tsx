import { redirect } from "next/navigation";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import { CampaignForm } from "@/components/CampaignForm";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";
import { parseLocalInput } from "@/lib/time";

export const dynamic = "force-dynamic";

async function createCampaign(formData: FormData) {
  "use server";
  if (!isAuthed()) redirect("/login");
  const name = String(formData.get("name") ?? "").trim().slice(0, 200);
  if (!name) return;
  const rawLocale = String(formData.get("locale") ?? "en").toLowerCase();
  const locale = rawLocale === "ar" ? "ar" : "en";
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
    },
  });
  redirect(`/campaigns/${c.id}`);
}

export default function NewCampaign() {
  if (!isAuthed()) redirect("/login");
  return (
    <Shell title="New campaign" crumb={<Link href="/">Campaigns</Link>}>
      <CampaignForm action={createCampaign} submitLabel="Create campaign" cancelHref="/" />
    </Shell>
  );
}
