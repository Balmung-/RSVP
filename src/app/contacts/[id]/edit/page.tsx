import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { ContactForm } from "@/components/ContactForm";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Badge } from "@/components/Badge";
import { prisma } from "@/lib/db";
import { getCurrentUser, requireRole } from "@/lib/auth";
import {
  updateContact,
  archiveContact,
  unarchiveContact,
  deleteContactRecord,
  VIP_TIERS,
  type VipTier,
} from "@/lib/contacts";
import { setFlash } from "@/lib/flash";

export const dynamic = "force-dynamic";

const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
const dateFmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });

const ERROR_MSG: Record<string, string> = {
  missing_name: "Name is required.",
  missing_contact: "An email or a phone number is required.",
  invalid_email: "Email format looks wrong.",
  invalid_phone: "Phone couldn't be parsed. Try E.164 (+9665…).",
  duplicate: "Another contact has that email or phone.",
  not_found: "Contact not found.",
};

async function save(contactId: string, formData: FormData) {
  "use server";
  await requireRole("editor");
  const tierRaw = String(formData.get("vipTier") ?? "standard");
  const vipTier: VipTier = (VIP_TIERS as readonly string[]).includes(tierRaw)
    ? (tierRaw as VipTier)
    : "standard";
  const res = await updateContact(contactId, {
    fullName: String(formData.get("fullName") ?? ""),
    title: String(formData.get("title") ?? ""),
    organization: String(formData.get("organization") ?? ""),
    email: String(formData.get("email") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    preferredLocale: String(formData.get("preferredLocale") ?? ""),
    vipTier,
    tags: String(formData.get("tags") ?? ""),
    dietary: String(formData.get("dietary") ?? ""),
    dress: String(formData.get("dress") ?? ""),
    securityNotes: String(formData.get("securityNotes") ?? ""),
    notes: String(formData.get("notes") ?? ""),
  });
  if (!res.ok) redirect(`/contacts/${contactId}/edit?e=${res.reason}`);
  setFlash({ kind: "success", text: "Contact updated" });
  redirect("/contacts");
}

async function archive(contactId: string) {
  "use server";
  await requireRole("editor");
  await archiveContact(contactId);
  setFlash({ kind: "info", text: "Contact archived" });
  redirect("/contacts");
}

async function unarchive(contactId: string) {
  "use server";
  await requireRole("editor");
  await unarchiveContact(contactId);
  redirect(`/contacts/${contactId}/edit`);
}

async function remove(contactId: string) {
  "use server";
  await requireRole("admin");
  await deleteContactRecord(contactId);
  setFlash({ kind: "warn", text: "Contact deleted" });
  redirect("/contacts");
}

export default async function EditContact({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { e?: string };
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const c = await prisma.contact.findUnique({
    where: { id: params.id },
    include: {
      invitees: {
        include: { campaign: { select: { id: true, name: true, status: true } }, response: true },
        orderBy: { createdAt: "desc" },
        take: 20,
      },
    },
  });
  if (!c) notFound();

  const boundSave = save.bind(null, c.id);
  const boundArchive = archive.bind(null, c.id);
  const boundUnarchive = unarchive.bind(null, c.id);
  const boundDelete = remove.bind(null, c.id);
  const error = searchParams.e ? ERROR_MSG[searchParams.e] : null;

  return (
    <Shell
      title={c.fullName}
      crumb={
        <span>
          <Link href="/contacts" className="hover:text-ink-900 transition-colors">Contacts</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span className="truncate">{c.fullName}</span>
        </span>
      }
    >
      {c.archivedAt ? (
        <div className="rounded-xl bg-signal-hold/10 border border-signal-hold/30 text-signal-hold px-4 py-3 mb-6 max-w-3xl flex items-center justify-between">
          <span className="text-body">
            Archived on <span className="tabular-nums">{dateFmt.format(c.archivedAt)}</span>. Hidden from new invitations.
          </span>
          <form action={boundUnarchive}>
            <button className="btn btn-soft text-mini">Unarchive</button>
          </form>
        </div>
      ) : null}

      {error ? <p role="alert" className="max-w-3xl text-body text-signal-fail mb-6">{error}</p> : null}

      <ContactForm contact={c} action={boundSave} submitLabel="Save changes" cancelHref="/contacts" />

      <section className="max-w-3xl mt-10">
        <h2 className="text-sub text-ink-900 mb-3">Invited to</h2>
        {c.invitees.length === 0 ? (
          <div className="panel-quiet p-6 text-center text-body text-ink-500">
            This contact hasn&apos;t been added to a campaign yet.
          </div>
        ) : (
          <ul className="panel divide-y divide-ink-100 overflow-hidden">
            {c.invitees.map((i) => {
              const r = i.response;
              const tone = r ? (r.attending ? "live" : "fail") : "wait";
              const label = r ? (r.attending ? "attending" : "declined") : "pending";
              return (
                <li key={i.id} className="flex items-center justify-between px-5 py-3">
                  <div className="min-w-0">
                    <Link
                      href={`/campaigns/${i.campaign.id}?invitee=${i.id}`}
                      className="text-body text-ink-900 hover:underline"
                    >
                      {i.campaign.name}
                    </Link>
                    <div className="text-mini text-ink-400 mt-0.5">{i.campaign.status}</div>
                  </div>
                  <Badge tone={tone}>{label}</Badge>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="max-w-3xl mt-8 flex items-center gap-3">
        {c.archivedAt ? null : (
          <form action={boundArchive}>
            <ConfirmButton
              tone="default"
              prompt={`Archive ${c.fullName}? They stay in past campaigns but won't show up in address-book searches.`}
            >
              Archive
            </ConfirmButton>
          </form>
        )}
        <form action={boundDelete}>
          <ConfirmButton
            prompt={`Delete ${c.fullName}? Existing invitees keep their own fields; the Contact link is cleared.`}
          >
            Delete permanently
          </ConfirmButton>
        </form>
      </div>
    </Shell>
  );
}
