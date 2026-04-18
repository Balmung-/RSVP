import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Field } from "@/components/Field";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole, ROLES, type Role } from "@/lib/auth";
import { updateUser, resetPassword, deactivateUser, deleteUser } from "@/lib/users";
import { logAction } from "@/lib/audit";

export const dynamic = "force-dynamic";

async function save(userId: string, formData: FormData) {
  "use server";
  const me = await getCurrentUser();
  if (!me || !hasRole(me, "admin")) redirect("/login");
  const roleRaw = String(formData.get("role") ?? "viewer");
  const role = (ROLES as readonly string[]).includes(roleRaw) ? (roleRaw as Role) : "viewer";
  const active = formData.get("active") === "on";
  const res = await updateUser(userId, {
    email: String(formData.get("email") ?? ""),
    fullName: String(formData.get("fullName") ?? ""),
    role,
    active,
  });
  if (!res.ok) redirect(`/users/${userId}/edit?e=${res.reason}`);
  await logAction({ kind: "user.updated", refType: "user", refId: userId, data: { role, active } });
  redirect("/users");
}

async function setPassword(userId: string, formData: FormData) {
  "use server";
  const me = await getCurrentUser();
  if (!me || !hasRole(me, "admin")) redirect("/login");
  const pw = String(formData.get("password") ?? "");
  const res = await resetPassword(userId, pw);
  if (!res.ok) redirect(`/users/${userId}/edit?e=${res.reason}`);
  await logAction({ kind: "user.password_reset", refType: "user", refId: userId });
  redirect(`/users/${userId}/edit?pw=1`);
}

async function disableUser(userId: string) {
  "use server";
  const me = await getCurrentUser();
  if (!me || !hasRole(me, "admin")) redirect("/login");
  if (me.id === userId) redirect(`/users/${userId}/edit?e=self`);
  await deactivateUser(userId);
  await logAction({ kind: "user.deactivated", refType: "user", refId: userId });
  redirect("/users");
}

async function removeUser(userId: string) {
  "use server";
  const me = await getCurrentUser();
  if (!me || !hasRole(me, "admin")) redirect("/login");
  if (me.id === userId) redirect(`/users/${userId}/edit?e=self`);
  await deleteUser(userId);
  await logAction({ kind: "user.deleted", refType: "user", refId: userId });
  redirect("/users");
}

const ERROR_MSG: Record<string, string> = {
  invalid_email: "Email format looks wrong.",
  duplicate_email: "Another user already has that email.",
  invalid_role: "Pick a valid role.",
  weak_password: "Password must be at least 10 characters.",
  not_found: "User not found.",
  self: "You can't disable or delete your own account while signed in.",
};

export default async function EditUser({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { e?: string; pw?: string };
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!hasRole(me, "admin")) redirect("/");
  const u = await prisma.user.findUnique({ where: { id: params.id } });
  if (!u) notFound();
  const boundSave = save.bind(null, u.id);
  const boundPw = setPassword.bind(null, u.id);
  const boundDisable = disableUser.bind(null, u.id);
  const boundDelete = removeUser.bind(null, u.id);
  const error = searchParams.e ? ERROR_MSG[searchParams.e] : null;
  const pwSet = searchParams.pw === "1";

  return (
    <Shell
      title={`Edit — ${u.email}`}
      crumb={
        <span>
          <Link href="/users" className="hover:underline">Team</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>Edit</span>
        </span>
      }
    >
      {error ? <p role="alert" className="max-w-2xl text-sm text-signal-fail mb-6">{error}</p> : null}
      {pwSet ? (
        <p role="status" className="max-w-2xl text-sm text-signal-live mb-6">
          Password reset. All existing sessions for this user were revoked.
        </p>
      ) : null}

      <form action={boundSave} className="panel max-w-2xl p-10 grid grid-cols-2 gap-6">
        <Field label="Email" className="col-span-2">
          <input name="email" type="email" required maxLength={200} className="field" defaultValue={u.email} />
        </Field>
        <Field label="Name">
          <input name="fullName" maxLength={120} className="field" defaultValue={u.fullName ?? ""} />
        </Field>
        <Field label="Role">
          <select name="role" className="field" defaultValue={u.role}>
            <option value="admin">Admin</option>
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </select>
        </Field>
        <label className="col-span-2 flex items-center gap-2 text-sm text-ink-700">
          <input type="checkbox" name="active" defaultChecked={u.active} className="accent-ink-900" />
          <span>Active — can sign in and receive session cookies</span>
        </label>
        <div className="col-span-2 flex items-center justify-end gap-3 pt-2">
          <Link href="/users" className="btn-ghost">Cancel</Link>
          <button className="btn-primary">Save changes</button>
        </div>
      </form>

      <form action={boundPw} className="panel max-w-2xl p-10 mt-6 grid grid-cols-2 gap-4">
        <h3 className="col-span-2 text-sm font-medium tracking-tight text-ink-900">Reset password</h3>
        <p className="col-span-2 text-xs text-ink-400 -mt-2">
          Sets a new password and revokes every active session for this user.
        </p>
        <Field label="New password" className="col-span-2">
          <input name="password" type="password" required minLength={10} className="field" />
        </Field>
        <div className="col-span-2 flex justify-end">
          <button className="btn-primary text-xs">Reset password</button>
        </div>
      </form>

      <div className="max-w-2xl mt-6 flex items-center gap-3">
        <form action={boundDisable}>
          <ConfirmButton
            className="!text-ink-700 hover:!text-ink-900"
            prompt={`Disable ${u.email}? They'll be signed out and blocked from signing in.`}
          >
            Disable account
          </ConfirmButton>
        </form>
        <form action={boundDelete}>
          <ConfirmButton prompt={`Delete ${u.email}? Their sessions and audit attribution will be removed.`}>
            Delete permanently
          </ConfirmButton>
        </form>
      </div>
    </Shell>
  );
}

