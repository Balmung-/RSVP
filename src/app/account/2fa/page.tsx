import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Icon } from "@/components/Icon";
import { ConfirmButton } from "@/components/ConfirmButton";
import { getCurrentUser, authenticateWithPassword } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { generateSecret, otpauthUri, qrForSecret, verifyTotp } from "@/lib/totp";
import { logAction } from "@/lib/audit";
import { setFlash } from "@/lib/flash";

export const dynamic = "force-dynamic";

// Each render that has no confirmed secret yet generates a pending one
// and stashes it in totpSecret (unconfirmed state — totpConfirmedAt=null).
// That lets the user come back to the page and scan the same QR again.
// Confirm writes totpConfirmedAt; disable wipes both fields.

async function enable(formData: FormData) {
  "use server";
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const token = String(formData.get("token") ?? "");
  if (!me.totpSecret) redirect("/account/2fa");
  if (!verifyTotp(token, me.totpSecret)) {
    redirect("/account/2fa?e=wrong_code");
  }
  await prisma.user.update({
    where: { id: me.id },
    data: { totpConfirmedAt: new Date() },
  });
  await logAction({ kind: "user.2fa_enabled", refType: "user", refId: me.id });
  setFlash({ kind: "success", text: "Two-step sign-in enabled." });
  redirect("/settings");
}

async function disable(formData: FormData) {
  "use server";
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  // Re-auth with password: a stolen/idle session on the same device still
  // has the authenticator app handy, so TOTP alone is weak proof.
  const reauthed = await authenticateWithPassword(me.email, password);
  if (!reauthed) {
    redirect("/account/2fa?e=wrong_password");
  }
  if (me.totpSecret && !verifyTotp(token, me.totpSecret)) {
    redirect("/account/2fa?e=wrong_code_disable");
  }
  await prisma.user.update({
    where: { id: me.id },
    data: { totpSecret: null, totpConfirmedAt: null },
  });
  await logAction({ kind: "user.2fa_disabled", refType: "user", refId: me.id });
  setFlash({ kind: "info", text: "Two-step sign-in disabled." });
  redirect("/settings");
}

const ERROR_MSG: Record<string, string> = {
  wrong_code: "That code doesn't match. Codes rotate every 30 seconds — try again.",
  wrong_code_disable: "Enter a current code to confirm you're turning it off.",
  wrong_password: "Password didn't match. You need to re-enter it to turn off two-step sign-in.",
};

export default async function TwoFactorPage({
  searchParams,
}: {
  searchParams: { e?: string };
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const enabled = !!me.totpConfirmedAt;
  const brand = process.env.APP_BRAND ?? "Einai";

  let qr: string | null = null;
  let secret: string | null = null;
  if (!enabled) {
    if (!me.totpSecret) {
      secret = generateSecret();
      await prisma.user.update({ where: { id: me.id }, data: { totpSecret: secret } });
    } else {
      secret = me.totpSecret;
    }
    qr = await qrForSecret(otpauthUri({ email: me.email }, secret, brand));
  }

  const error = searchParams.e ? ERROR_MSG[searchParams.e] : null;

  return (
    <Shell
      title="Two-step sign-in"
      crumb={
        <span>
          <Link href="/settings" className="hover:text-ink-900 transition-colors">Settings</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>Two-step</span>
        </span>
      }
    >
      {error ? <p role="alert" className="max-w-xl text-body text-signal-fail mb-6">{error}</p> : null}

      {enabled ? (
        <div className="panel p-8 max-w-xl">
          <div className="flex items-center gap-3 mb-4">
            <span className="h-8 w-8 rounded-full bg-signal-live/15 text-signal-live grid place-items-center">
              <Icon name="check" size={16} />
            </span>
            <div>
              <div className="text-sub text-ink-900">Enabled</div>
              <div className="text-mini text-ink-500">
                Confirmed on {new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(me.totpConfirmedAt!)}.
              </div>
            </div>
          </div>
          <p className="text-body text-ink-600 mb-5">
            You&apos;ll be asked for a code from your authenticator app after your password on every sign-in.
          </p>
          <form action={disable} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-micro uppercase text-ink-400">Password</span>
              <input
                name="password"
                type="password"
                required
                autoComplete="current-password"
                className="field"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-micro uppercase text-ink-400">Current 6-digit code</span>
              <input
                name="token"
                required
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                className="field font-mono tracking-widest"
                placeholder="000000"
              />
            </label>
            <div className="flex justify-end">
              <ConfirmButton prompt="Turn off two-step sign-in? You'll lose this layer of protection.">
                Turn off
              </ConfirmButton>
            </div>
          </form>
        </div>
      ) : (
        <div className="panel p-8 max-w-xl">
          <p className="text-body text-ink-600 mb-5">
            Scan this with any authenticator app (Google Authenticator, 1Password,
            Authy, Microsoft Authenticator), then enter the 6-digit code it shows.
          </p>
          <div className="flex items-start gap-6">
            {qr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr} alt="Scan with authenticator app" className="w-48 h-48 rounded-lg border border-ink-100 bg-white" />
            ) : null}
            <div className="flex-1 min-w-0">
              <div className="text-micro uppercase text-ink-400 mb-1">Manual entry key</div>
              <code className="block text-mini text-ink-900 font-mono break-all bg-ink-50 rounded-md p-2 mb-4">
                {secret}
              </code>
              <form action={enable} className="flex flex-col gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-micro uppercase text-ink-400">Code from app</span>
                  <input
                    name="token"
                    required
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    className="field font-mono tracking-widest"
                    placeholder="000000"
                    autoFocus
                  />
                </label>
                <button className="btn btn-primary">
                  <Icon name="check" size={14} />
                  Turn on
                </button>
              </form>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}
