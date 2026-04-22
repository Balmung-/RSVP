import Link from "next/link";
import { redirect } from "next/navigation";
import { Field } from "@/components/Field";
import { Shell } from "@/components/Shell";
import { requirePlatformAdmin, setActiveTenant } from "@/lib/auth";
import { createTenantWithOwner } from "@/lib/tenants";
import { logAction } from "@/lib/audit";

export const dynamic = "force-dynamic";

async function create(formData: FormData) {
  "use server";
  await requirePlatformAdmin();
  const res = await createTenantWithOwner(
    {
      name: String(formData.get("name") ?? ""),
      slug: String(formData.get("slug") ?? ""),
      locale: String(formData.get("locale") ?? "") === "ar" ? "ar" : "en",
    },
    {
      email: String(formData.get("ownerEmail") ?? ""),
      fullName: String(formData.get("ownerName") ?? ""),
    },
    String(formData.get("password") ?? ""),
  );
  if (!res.ok) redirect(`/tenants/new?e=${res.reason}`);
  await logAction({
    kind: "tenant.created",
    refType: "tenant",
    refId: res.tenantId,
    data: { ownerUserId: res.ownerUserId, ownerCreated: res.ownerCreated },
  });
  await setActiveTenant(res.tenantId);
  redirect("/users");
}

const ERROR_MSG: Record<string, string> = {
  missing_name: "Workspace name is required.",
  invalid_slug: "Workspace slug must use lowercase letters, numbers, and hyphens.",
  duplicate_slug: "Another workspace already uses that slug.",
  invalid_email: "Owner email format looks wrong.",
  weak_password: "Set an initial password with at least 10 characters.",
  invalid_role: "Owner role is fixed by the system.",
};

export default async function NewTenant({ searchParams }: { searchParams: { e?: string } }) {
  await requirePlatformAdmin();
  const error = searchParams.e ? ERROR_MSG[searchParams.e] : null;

  return (
    <Shell
      title="New workspace"
      crumb={
        <span>
          <Link href="/tenants" className="hover:underline">Workspaces</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>New</span>
        </span>
      }
    >
      <form action={create} className="panel max-w-3xl p-10 grid grid-cols-2 gap-6">
        {error ? <p role="alert" className="col-span-2 text-sm text-signal-fail">{error}</p> : null}
        <Field label="Workspace name">
          <input name="name" className="field" required maxLength={120} />
        </Field>
        <Field label="Slug">
          <input name="slug" className="field font-mono" pattern="^[a-z0-9-]{1,50}$" />
        </Field>
        <Field label="Default locale">
          <select name="locale" className="field" defaultValue="ar">
            <option value="ar">العربية (السعودية)</option>
            <option value="en">English</option>
          </select>
        </Field>
        <div />
        <Field label="Owner email">
          <input name="ownerEmail" type="email" className="field" required maxLength={200} />
        </Field>
        <Field label="Owner name">
          <input name="ownerName" className="field" maxLength={120} />
        </Field>
        <Field label="Initial password" className="col-span-2">
          <input name="password" type="password" className="field" required minLength={10} />
        </Field>
        <p className="col-span-2 text-xs text-ink-400">
          The owner gets full control of this workspace and can invite admins, editors, and viewers inside it.
          If the owner email already exists in Einai, the password is ignored and the account is simply attached as
          the workspace owner.
        </p>
        <div className="col-span-2 flex items-center justify-end gap-3 pt-2">
          <Link href="/tenants" className="btn-ghost">Cancel</Link>
          <button className="btn-primary">Create workspace</button>
        </div>
      </form>
    </Shell>
  );
}
