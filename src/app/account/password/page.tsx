import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Icon } from "@/components/Icon";
import { getCurrentUser, verifyPassword, hashPassword } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { logAction } from "@/lib/audit";
import { setFlash } from "@/lib/flash";

export const dynamic = "force-dynamic";

// Self-serve password change. Accepts old + new (twice); rotates hash;
// clears the mustChangePassword flag.
// When the user is forced to change (mustChangePassword=true), all routes
// except /account/password + /login redirect here via the middleware
// check in the shell.

async function change(formData: FormData) {
  "use server";
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirmed = String(formData.get("confirmed") ?? "");

  if (!me.passwordHash) redirect("/account/password?e=no_password");
  const ok = await verifyPassword(current, me.passwordHash);
  if (!ok) redirect("/account/password?e=wrong_current");
  if (next.length < 10) redirect("/account/password?e=weak");
  if (next !== confirmed) redirect("/account/password?e=mismatch");
  if (next === current) redirect("/account/password?e=same");

  const hash = await hashPassword(next);
  // Revoke every other session — the changed password shouldn't keep
  // working anywhere else. Keep the current session by not touching
  // the cookie; the row it points at is still valid.
  await prisma.$transaction([
    prisma.user.update({
      where: { id: me.id },
      data: { passwordHash: hash, mustChangePassword: false },
    }),
    prisma.session.deleteMany({ where: { userId: me.id } }),
  ]);
  // The in-flight session was just deleted, so force a fresh login.
  await logAction({ kind: "user.password_self_changed", refType: "user", refId: me.id });
  setFlash({ kind: "success", text: "Password changed", detail: "Sign in again with the new password." });
  redirect("/login");
}

const ERROR_MSG: Record<string, string> = {
  wrong_current: "Current password doesn't match.",
  weak: "Password must be at least 10 characters.",
  mismatch: "New password and confirmation don't match.",
  same: "New password must be different from the current one.",
  no_password: "This account has no local password (SSO-only).",
};

export default async function PasswordPage({
  searchParams,
}: {
  searchParams: { e?: string };
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const error = searchParams.e ? ERROR_MSG[searchParams.e] : null;
  const forced = me.mustChangePassword;

  return (
    <Shell
      title="Change password"
      crumb={
        <span>
          <Link href="/settings" className="hover:text-ink-900 transition-colors">Settings</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>Password</span>
        </span>
      }
    >
      {forced ? (
        <div className="rounded-xl bg-signal-hold/10 border border-signal-hold/30 text-signal-hold px-4 py-3 mb-6 max-w-xl flex items-start gap-2">
          <Icon name="circle-alert" size={14} className="mt-0.5" />
          <div className="text-body">
            An admin set you up with an initial password. Pick your own before continuing.
          </div>
        </div>
      ) : null}

      {error ? <p role="alert" className="max-w-xl text-body text-signal-fail mb-6">{error}</p> : null}

      <form action={change} className="panel p-10 max-w-xl grid grid-cols-1 gap-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-micro uppercase text-ink-400">Current password</span>
          <input name="current" type="password" required className="field" autoComplete="current-password" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-micro uppercase text-ink-400">New password</span>
          <input
            name="next"
            type="password"
            required
            minLength={10}
            className="field"
            autoComplete="new-password"
          />
          <span className="text-mini text-ink-400">At least 10 characters. A passphrase is easier than a complex short password.</span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-micro uppercase text-ink-400">Confirm new password</span>
          <input
            name="confirmed"
            type="password"
            required
            minLength={10}
            className="field"
            autoComplete="new-password"
          />
        </label>
        <div className="flex items-center justify-end gap-3 pt-2">
          {forced ? null : (
            <Link href="/settings" className="btn btn-ghost">Cancel</Link>
          )}
          <button className="btn btn-primary">Change password</button>
        </div>
      </form>
    </Shell>
  );
}
