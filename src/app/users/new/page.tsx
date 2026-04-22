import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Field } from "@/components/Field";
import { getCurrentUser, hasPlatformRole, hasTenantRole, requireTenantRole } from "@/lib/auth";
import { allowedInviteRoles, TENANT_ROLE_LABEL, type TenantRole } from "@/lib/tenant-roles";
import { inviteUserToTenant } from "@/lib/tenants";
import { logAction } from "@/lib/audit";

export const dynamic = "force-dynamic";

async function create(formData: FormData) {
  "use server";
  const me = await requireTenantRole("admin");
  if (!me.activeTenantId) redirect("/tenants");
  const roleRaw = String(formData.get("role") ?? "viewer");
  const allowedRoles = allowedInviteRoles(me.activeTenantRole, hasPlatformRole(me, "admin"));
  const role = allowedRoles.includes(roleRaw as TenantRole) ? (roleRaw as TenantRole) : allowedRoles[0] ?? "viewer";
  const res = await inviteUserToTenant(
    me.activeTenantId,
    me.activeTenantRole,
    hasPlatformRole(me, "admin"),
    {
      email: String(formData.get("email") ?? ""),
      fullName: String(formData.get("fullName") ?? ""),
      role,
    },
    String(formData.get("password") ?? ""),
  );
  if (!res.ok) redirect(`/users/new?e=${res.reason}`);
  await logAction({
    kind: "tenant.member_invited",
    refType: "tenant",
    refId: me.activeTenantId,
    data: { userId: res.userId, role, created: res.created },
  });
  redirect("/users");
}

const ERROR_MSG: Record<string, string> = {
  invalid_email: "Email format looks wrong.",
  duplicate_member: "That person is already in this workspace.",
  invalid_role: "Pick a valid workspace role.",
  forbidden_role: "Your workspace role cannot assign that level.",
  weak_password: "New accounts still need an initial password with at least 10 characters.",
};

export default async function NewUser({ searchParams }: { searchParams: { e?: string } }) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!hasTenantRole(me, "admin")) redirect("/");
  if (!me.activeTenantId || !me.activeTenantName) redirect("/tenants");
  const error = searchParams.e ? ERROR_MSG[searchParams.e] : null;
  const roleOptions = allowedInviteRoles(me.activeTenantRole, hasPlatformRole(me, "admin"));
  if (roleOptions.length === 0) redirect("/users");

  return (
    <Shell
      title="Invite person"
      crumb={
        <span>
          <Link href="/users" className="hover:underline">{me.activeTenantName}</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>Invite</span>
        </span>
      }
    >
      <form action={create} className="panel max-w-2xl p-10 grid grid-cols-2 gap-6">
        {error ? <p role="alert" className="col-span-2 text-sm text-signal-fail">{error}</p> : null}
        <Field label="Email" className="col-span-2">
          <input name="email" type="email" required maxLength={200} className="field" />
        </Field>
        <Field label="Name">
          <input name="fullName" maxLength={120} className="field" />
        </Field>
        <Field label="Workspace role">
          <select name="role" className="field" defaultValue={roleOptions.includes("editor") ? "editor" : roleOptions[0]}>
            {roleOptions.map((role) => (
              <option key={role} value={role}>{TENANT_ROLE_LABEL[role]}</option>
            ))}
          </select>
        </Field>
        <Field label="Initial password" className="col-span-2">
          <input name="password" type="password" minLength={10} className="field" />
        </Field>
        <p className="col-span-2 text-xs text-ink-400">
          If the email already belongs to an existing Einai account, leave the password blank and the user will be
          attached to this workspace with the selected role. If this is a brand-new person, set an initial password
          and they&apos;ll be forced to change it on first sign-in.
        </p>
        <div className="col-span-2 flex items-center justify-end gap-3 pt-2">
          <Link href="/users" className="btn-ghost">Cancel</Link>
          <button className="btn-primary">Invite</button>
        </div>
      </form>
    </Shell>
  );
}
