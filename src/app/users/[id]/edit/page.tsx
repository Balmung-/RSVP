import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Field } from "@/components/Field";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasPlatformRole, hasTenantRole, requireTenantRole } from "@/lib/auth";
import { allowedInviteRoles, TENANT_ROLE_LABEL, type TenantRole } from "@/lib/tenant-roles";
import { removeTenantMember, updateTenantMemberRole } from "@/lib/tenants";
import { logAction } from "@/lib/audit";

export const dynamic = "force-dynamic";

async function save(userId: string, formData: FormData) {
  "use server";
  const me = await requireTenantRole("admin");
  if (!me.activeTenantId) redirect("/tenants");
  const roleRaw = String(formData.get("role") ?? "viewer");
  const allowedRoles = allowedInviteRoles(me.activeTenantRole, hasPlatformRole(me, "admin"));
  const role = allowedRoles.includes(roleRaw as TenantRole) ? (roleRaw as TenantRole) : allowedRoles[0];
  const res = await updateTenantMemberRole(
    me.activeTenantId,
    userId,
    me.activeTenantRole,
    hasPlatformRole(me, "admin"),
    role,
  );
  if (!res.ok) redirect(`/users/${userId}/edit?e=${res.reason}`);
  await logAction({
    kind: "tenant.member_role_updated",
    refType: "tenant",
    refId: me.activeTenantId,
    data: { userId, role },
  });
  redirect("/users");
}

async function removeMemberAction(userId: string) {
  "use server";
  const me = await requireTenantRole("admin");
  if (!me.activeTenantId) redirect("/tenants");
  const res = await removeTenantMember(
    me.activeTenantId,
    userId,
    me.activeTenantRole,
    hasPlatformRole(me, "admin"),
  );
  if (!res.ok) redirect(`/users/${userId}/edit?e=${res.reason}`);
  await logAction({
    kind: "tenant.member_removed",
    refType: "tenant",
    refId: me.activeTenantId,
    data: { userId },
  });
  redirect("/users");
}

const ERROR_MSG: Record<string, string> = {
  invalid_role: "Pick a valid workspace role.",
  forbidden_role: "Your workspace role cannot make that change.",
  not_found: "Person not found in this workspace.",
  last_owner: "This workspace still needs at least one owner.",
};

const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
const fmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });

export default async function EditUser({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { e?: string };
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!hasTenantRole(me, "admin")) redirect("/");
  if (!me.activeTenantId || !me.activeTenantName) redirect("/tenants");

  const member = await prisma.tenantMembership.findUnique({
    where: { tenantId_userId: { tenantId: me.activeTenantId, userId: params.id } },
    select: {
      role: true,
      userId: true,
      user: {
        select: {
          email: true,
          fullName: true,
          active: true,
          lastLoginAt: true,
          createdAt: true,
        },
      },
    },
  });
  if (!member) notFound();
  const boundSave = save.bind(null, member.userId);
  const boundRemove = removeMemberAction.bind(null, member.userId);
  const error = searchParams.e ? ERROR_MSG[searchParams.e] : null;
  const roleOptions = allowedInviteRoles(me.activeTenantRole, hasPlatformRole(me, "admin"));

  return (
    <Shell
      title={`Workspace access — ${member.user.email}`}
      crumb={
        <span>
          <Link href="/users" className="hover:underline">{me.activeTenantName}</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>Access</span>
        </span>
      }
    >
      {error ? <p role="alert" className="max-w-2xl text-sm text-signal-fail mb-6">{error}</p> : null}

      <form action={boundSave} className="panel max-w-2xl p-10 grid grid-cols-2 gap-6">
        <Field label="Email" className="col-span-2">
          <input className="field" value={member.user.email} readOnly disabled />
        </Field>
        <Field label="Name">
          <input className="field" value={member.user.fullName ?? ""} readOnly disabled />
        </Field>
        <Field label="Workspace role">
          <select name="role" className="field" defaultValue={member.role}>
            {[member.role, ...roleOptions].filter((value, index, all) => all.indexOf(value as TenantRole) === index).map((role) => (
              <option key={role} value={role}>{TENANT_ROLE_LABEL[role as TenantRole] ?? role}</option>
            ))}
          </select>
        </Field>
        <div className="col-span-2 grid grid-cols-2 gap-6 text-sm text-ink-600">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-ink-400 mb-1">Account</div>
            <div>{member.user.active ? "Active" : "Disabled"}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-ink-400 mb-1">Last login</div>
            <div>{member.user.lastLoginAt ? fmt.format(member.user.lastLoginAt) : "Never"}</div>
          </div>
        </div>
        <p className="col-span-2 text-xs text-ink-400">
          Tenant admins manage workspace membership here. Global account changes such as password resets and full
          account disablement remain a platform-admin operation.
        </p>
        <div className="col-span-2 flex items-center justify-end gap-3 pt-2">
          <Link href="/users" className="btn-ghost">Cancel</Link>
          <button className="btn-primary">Save access</button>
        </div>
      </form>

      <div className="max-w-2xl mt-6 flex items-center gap-3">
        <form action={boundRemove}>
          <ConfirmButton prompt={`Remove ${member.user.email} from ${me.activeTenantName}?`}>
            Remove from workspace
          </ConfirmButton>
        </form>
      </div>
    </Shell>
  );
}
