import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { TemplateForm } from "@/components/TemplateForm";
import { ConfirmButton } from "@/components/ConfirmButton";
import { requireRole } from "@/lib/auth";
import {
  getTemplate,
  updateTemplate,
  archiveTemplate,
  unarchiveTemplate,
  deleteTemplateRecord,
  TEMPLATE_KINDS,
  type TemplateKind,
} from "@/lib/templates";
import { setFlash } from "@/lib/flash";
import { logAction } from "@/lib/audit";

export const dynamic = "force-dynamic";

async function save(id: string, formData: FormData) {
  "use server";
  await requireRole("editor");
  const kindRaw = String(formData.get("kind") ?? "email");
  const kind: TemplateKind = (TEMPLATE_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as TemplateKind) : "email";
  const localeRaw = String(formData.get("locale") ?? "en");
  const locale: "en" | "ar" = localeRaw === "ar" ? "ar" : "en";
  const res = await updateTemplate(id, {
    name: String(formData.get("name") ?? ""),
    kind,
    locale,
    subject: String(formData.get("subject") ?? ""),
    body: String(formData.get("body") ?? ""),
    tags: String(formData.get("tags") ?? ""),
  });
  if (!res.ok) redirect(`/templates/${id}/edit?e=${res.reason}`);
  await logAction({
    kind: "template.updated",
    refType: "template",
    refId: id,
    data: { kind, locale },
  });
  setFlash({ kind: "success", text: "Template updated" });
  redirect("/templates");
}

async function archive(id: string) {
  "use server";
  await requireRole("editor");
  await archiveTemplate(id);
  await logAction({ kind: "template.archived", refType: "template", refId: id });
  redirect("/templates");
}

async function unarchive(id: string) {
  "use server";
  await requireRole("editor");
  await unarchiveTemplate(id);
  await logAction({ kind: "template.unarchived", refType: "template", refId: id });
  redirect(`/templates/${id}/edit`);
}

async function remove(id: string) {
  "use server";
  await requireRole("admin");
  await deleteTemplateRecord(id);
  await logAction({ kind: "template.deleted", refType: "template", refId: id });
  setFlash({ kind: "warn", text: "Template deleted" });
  redirect("/templates");
}

const ERROR_MSG: Record<string, string> = {
  missing_name: "Name is required.",
  missing_body: "Body is required.",
  invalid_kind: "Pick email or SMS.",
  not_found: "Template not found.",
};

export default async function EditTemplate({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { e?: string };
}) {
  await requireRole("editor");
  const tpl = await getTemplate(params.id);
  if (!tpl) notFound();

  const boundSave = save.bind(null, tpl.id);
  const boundArchive = archive.bind(null, tpl.id);
  const boundUnarchive = unarchive.bind(null, tpl.id);
  const boundDelete = remove.bind(null, tpl.id);

  const error = searchParams.e ? ERROR_MSG[searchParams.e] : null;

  return (
    <Shell
      title={tpl.name}
      crumb={
        <span>
          <Link href="/templates" className="hover:text-ink-900 transition-colors">Templates</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span className="truncate">{tpl.name}</span>
        </span>
      }
    >
      {tpl.archivedAt ? (
        <div className="rounded-xl bg-signal-hold/10 border border-signal-hold/30 text-signal-hold px-4 py-3 mb-6 max-w-3xl flex items-center justify-between">
          <span className="text-body">Archived. Hidden from the template picker.</span>
          <form action={boundUnarchive}>
            <button className="btn btn-soft text-mini">Unarchive</button>
          </form>
        </div>
      ) : null}

      {error ? <p role="alert" className="max-w-3xl text-body text-signal-fail mb-6">{error}</p> : null}

      <TemplateForm template={tpl} action={boundSave} submitLabel="Save changes" cancelHref="/templates" />

      <div className="max-w-3xl mt-8 flex items-center gap-3">
        {tpl.archivedAt ? null : (
          <form action={boundArchive}>
            <ConfirmButton tone="default" prompt={`Archive "${tpl.name}"?`}>Archive</ConfirmButton>
          </form>
        )}
        <form action={boundDelete}>
          <ConfirmButton prompt={`Delete "${tpl.name}"? Campaigns that loaded it keep their own copies.`}>
            Delete permanently
          </ConfirmButton>
        </form>
      </div>
    </Shell>
  );
}
