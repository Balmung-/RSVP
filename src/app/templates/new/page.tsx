import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { TemplateForm } from "@/components/TemplateForm";
import { requireActiveTenantId, requireRole } from "@/lib/auth";
import { createTemplate, TEMPLATE_KINDS, type TemplateKind } from "@/lib/templates";
import { setFlash } from "@/lib/flash";
import { logAction } from "@/lib/audit";

export const dynamic = "force-dynamic";

async function create(formData: FormData) {
  "use server";
  const me = await requireRole("editor");
  const kindRaw = String(formData.get("kind") ?? "email");
  const kind: TemplateKind = (TEMPLATE_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as TemplateKind) : "email";
  const localeRaw = String(formData.get("locale") ?? "en");
  const locale: "en" | "ar" = localeRaw === "ar" ? "ar" : "en";
  const res = await createTemplate(
    requireActiveTenantId(me),
    {
      name: String(formData.get("name") ?? ""),
      kind,
      locale,
      subject: String(formData.get("subject") ?? ""),
      body: String(formData.get("body") ?? ""),
      tags: String(formData.get("tags") ?? ""),
    },
    me.id,
  );
  if (!res.ok) redirect(`/templates/new?e=${res.reason}`);
  await logAction({
    kind: "template.created",
    refType: "template",
    refId: res.templateId,
    data: { kind, locale },
  });
  setFlash({ kind: "success", text: "Template saved" });
  redirect("/templates");
}

const ERROR_MSG: Record<string, string> = {
  missing_name: "Name is required.",
  missing_body: "Body is required.",
  invalid_kind: "Pick email or SMS.",
};

export default async function NewTemplate({ searchParams }: { searchParams: { e?: string } }) {
  const me = await requireRole("editor");
  requireActiveTenantId(me);
  const error = searchParams.e ? ERROR_MSG[searchParams.e] : null;
  return (
    <Shell
      title="New template"
      crumb={
        <span>
          <Link href="/templates" className="hover:text-ink-900 transition-colors">Templates</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>New</span>
        </span>
      }
    >
      {error ? <p role="alert" className="max-w-3xl text-body text-signal-fail mb-6">{error}</p> : null}
      <TemplateForm action={create} submitLabel="Save template" cancelHref="/templates" />
    </Shell>
  );
}
