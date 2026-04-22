import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { ContactForm } from "@/components/ContactForm";
import { getCurrentUser, requireActiveTenantId, requireRole } from "@/lib/auth";
import { createContact, VIP_TIERS, type VipTier } from "@/lib/contacts";
import { setFlash } from "@/lib/flash";

export const dynamic = "force-dynamic";

const ERROR_MSG: Record<string, string> = {
  missing_name: "Name is required.",
  missing_contact: "An email or a phone number is required.",
  invalid_email: "Email format looks wrong.",
  invalid_phone: "Phone couldn't be parsed. Try E.164 (+9665…).",
  duplicate: "A contact with that email or phone already exists.",
};

async function add(formData: FormData) {
  "use server";
  const me = await requireRole("editor");
  const tierRaw = String(formData.get("vipTier") ?? "standard");
  const vipTier: VipTier = (VIP_TIERS as readonly string[]).includes(tierRaw)
    ? (tierRaw as VipTier)
    : "standard";
  const res = await createContact(
    requireActiveTenantId(me),
    {
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
    },
    me.id,
  );
  if (!res.ok) redirect(`/contacts/new?e=${res.reason}`);
  setFlash({ kind: "success", text: "Contact added" });
  redirect(`/contacts`);
}

export default async function NewContact({ searchParams }: { searchParams: { e?: string } }) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  requireActiveTenantId(me);
  const error = searchParams.e ? ERROR_MSG[searchParams.e] : null;

  return (
    <Shell
      title="New contact"
      crumb={
        <span>
          <Link href="/contacts" className="hover:text-ink-900 transition-colors">Contacts</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>New</span>
        </span>
      }
    >
      {error ? <p role="alert" className="max-w-3xl text-body text-signal-fail mb-6">{error}</p> : null}
      <ContactForm action={add} submitLabel="Add contact" cancelHref="/contacts" />
    </Shell>
  );
}
