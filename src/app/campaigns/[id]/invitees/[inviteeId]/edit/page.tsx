import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { InviteeForm } from "@/components/InviteeForm";
import { prisma } from "@/lib/db";
import { isAuthed, requireRole } from "@/lib/auth";
import { updateInvitee } from "@/lib/campaigns";

export const dynamic = "force-dynamic";

async function save(campaignId: string, inviteeId: string, formData: FormData) {
  "use server";
  await requireRole("editor");
  const localeRaw = String(formData.get("locale") ?? "").toLowerCase();
  const res = await updateInvitee(
    inviteeId,
    {
      fullName: String(formData.get("fullName") ?? ""),
      title: String(formData.get("title") ?? ""),
      organization: String(formData.get("organization") ?? ""),
      email: String(formData.get("email") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      locale: localeRaw === "ar" ? "ar" : localeRaw === "en" ? "en" : null,
      tags: String(formData.get("tags") ?? ""),
      notes: String(formData.get("notes") ?? ""),
      guestsAllowed: Number(formData.get("guestsAllowed") ?? 0),
    },
    campaignId,
  );
  if (!res.ok) {
    redirect(`/campaigns/${campaignId}/invitees/${inviteeId}/edit?e=${res.reason}`);
  }
  redirect(`/campaigns/${campaignId}?invitee=${inviteeId}`);
}

const ERROR_MSG: Record<string, string> = {
  missing_name: "Name is required.",
  missing_contact: "An email or a phone number is required.",
  duplicate: "Another invitee in this campaign already has that email or phone.",
  invalid_email: "That email looks malformed.",
  invalid_phone: "That phone number couldn't be parsed. Try E.164 (+9665...).",
  not_found: "Invitee no longer exists.",
};

export default async function EditInvitee({
  params,
  searchParams,
}: {
  params: { id: string; inviteeId: string };
  searchParams: { e?: string };
}) {
  if (!(await isAuthed())) redirect("/login");
  const [c, i] = await Promise.all([
    prisma.campaign.findUnique({ where: { id: params.id } }),
    prisma.invitee.findUnique({ where: { id: params.inviteeId } }),
  ]);
  if (!c || !i || i.campaignId !== c.id) notFound();
  const action = save.bind(null, c.id, i.id);
  const error = searchParams.e ? ERROR_MSG[searchParams.e] : null;

  return (
    <Shell
      title={`Edit — ${i.fullName}`}
      crumb={
        <span>
          <Link href="/" className="hover:underline">Campaigns</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <Link href={`/campaigns/${c.id}`} className="hover:underline">{c.name}</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>Edit invitee</span>
        </span>
      }
    >
      <div className="panel max-w-3xl p-10">
        {error ? (
          <p role="alert" className="text-sm text-signal-fail mb-6">{error}</p>
        ) : null}
        <InviteeForm
          invitee={i}
          action={action}
          submitLabel="Save changes"
          cancelHref={`/campaigns/${c.id}?invitee=${i.id}`}
        />
      </div>
    </Shell>
  );
}
