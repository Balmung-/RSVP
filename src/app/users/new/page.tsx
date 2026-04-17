import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { getCurrentUser, hasRole, ROLES, type Role } from "@/lib/auth";
import { createUser } from "@/lib/users";
import { logAction } from "@/lib/audit";

export const dynamic = "force-dynamic";

async function create(formData: FormData) {
  "use server";
  const me = await getCurrentUser();
  if (!me || !hasRole(me, "admin")) redirect("/login");
  const roleRaw = String(formData.get("role") ?? "viewer");
  const role = (ROLES as readonly string[]).includes(roleRaw) ? (roleRaw as Role) : "viewer";
  const res = await createUser(
    {
      email: String(formData.get("email") ?? ""),
      fullName: String(formData.get("fullName") ?? ""),
      role,
      active: true,
    },
    String(formData.get("password") ?? ""),
  );
  if (!res.ok) redirect(`/users/new?e=${res.reason}`);
  await logAction({
    kind: "user.created",
    refType: "user",
    refId: res.userId,
    data: { email: String(formData.get("email") ?? ""), role },
  });
  redirect("/users");
}

const ERROR_MSG: Record<string, string> = {
  invalid_email: "Email format looks wrong.",
  duplicate_email: "A user with that email already exists.",
  invalid_role: "Pick a valid role.",
  weak_password: "Password must be at least 10 characters.",
};

export default async function NewUser({ searchParams }: { searchParams: { e?: string } }) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!hasRole(me, "admin")) redirect("/");
  const error = searchParams.e ? ERROR_MSG[searchParams.e] : null;
  return (
    <Shell
      title="Invite user"
      crumb={
        <span>
          <Link href="/users" className="hover:underline">Team</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>New</span>
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
        <Field label="Role">
          <select name="role" className="field" defaultValue="editor">
            <option value="admin">Admin — full access + team management</option>
            <option value="editor">Editor — campaigns + send</option>
            <option value="viewer">Viewer — read-only</option>
          </select>
        </Field>
        <Field label="Initial password" className="col-span-2">
          <input name="password" type="password" required minLength={10} className="field" />
        </Field>
        <p className="col-span-2 text-xs text-ink-400">
          Share the password securely. The user can change it on first login via a password reset
          (not yet self-serve; admin resets on the edit page).
        </p>
        <div className="col-span-2 flex items-center justify-end gap-3 pt-2">
          <Link href="/users" className="btn-ghost">Cancel</Link>
          <button className="btn-primary">Invite</button>
        </div>
      </form>
    </Shell>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-[11px] uppercase tracking-wider text-ink-400">{label}</span>
      {children}
    </label>
  );
}
