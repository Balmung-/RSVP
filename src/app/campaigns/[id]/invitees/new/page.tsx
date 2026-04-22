import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { InviteeForm } from "@/components/InviteeForm";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole, requireActiveTenantId, requireRole } from "@/lib/auth";
import { canSeeCampaignRow } from "@/lib/teams";
import { createInvitee } from "@/lib/campaigns";

export const dynamic = "force-dynamic";

async function addInvitee(campaignId: string, formData: FormData) {
  "use server";
  await requireRole("editor");
  const localeRaw = String(formData.get("locale") ?? "").toLowerCase();
  const res = await createInvitee(campaignId, {
    fullName: String(formData.get("fullName") ?? ""),
    title: String(formData.get("title") ?? ""),
    organization: String(formData.get("organization") ?? ""),
    email: String(formData.get("email") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    locale: localeRaw === "ar" ? "ar" : localeRaw === "en" ? "en" : null,
    tags: String(formData.get("tags") ?? ""),
    notes: String(formData.get("notes") ?? ""),
    guestsAllowed: Number(formData.get("guestsAllowed") ?? 0),
  });
  if (!res.ok) {
    redirect(`/campaigns/${campaignId}/invitees/new?e=${res.reason}`);
  }
  redirect(`/campaigns/${campaignId}?invitee=${res.inviteeId}`);
}

const ERROR_MSG: Record<string, string> = {
  missing_name: "Name is required.",
  missing_contact: "An email or a phone number is required.",
  duplicate: "An invitee with this email or phone already exists in this campaign.",
  invalid_email: "That email looks malformed.",
  invalid_phone: "That phone number couldn't be parsed. Try E.164 (+9665...).",
  not_found: "Invitee no longer exists.",
};

export default async function NewInvitee({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { e?: string };
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const tenantId = requireActiveTenantId(me);
  const c = await prisma.campaign.findUnique({ where: { id: params.id } });
  if (!c) notFound();
  if (!(await canSeeCampaignRow(me.id, hasRole(me, "admin"), tenantId, c.tenantId, c.teamId))) notFound();
  const action = addInvitee.bind(null, c.id);
  const error = searchParams.e ? ERROR_MSG[searchParams.e] : null;

  return (
    <Shell
      title="Add invitee"
      crumb={
        <span>
          <Link href="/campaigns" className="hover:underline">Campaigns</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <Link href={`/campaigns/${c.id}`} className="hover:underline">{c.name}</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>Add invitee</span>
        </span>
      }
    >
      <div className="panel max-w-3xl p-10">
        {error ? (
          <p role="alert" className="text-sm text-signal-fail mb-6">{error}</p>
        ) : null}
        <InviteeForm
          action={action}
          submitLabel="Add invitee"
          cancelHref={`/campaigns/${c.id}`}
        />
      </div>
    </Shell>
  );
}
