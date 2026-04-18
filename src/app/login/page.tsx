import { redirect } from "next/navigation";
import { headers } from "next/headers";
import {
  authenticateWithPassword,
  startSession,
  isAuthed,
  issuePending,
  readPending,
  clearPending,
} from "@/lib/auth";
import { prisma } from "@/lib/db";
import { verifyTotp } from "@/lib/totp";
import { rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

function safeReturnTo(raw: string | undefined | null): string {
  // Only allow same-origin relative paths, never protocol-relative or
  // absolute URLs that could bounce a session into attacker hands.
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (raw.length > 300) return "/";
  return raw;
}

async function loginAction(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const returnTo = safeReturnTo(String(formData.get("returnTo") ?? ""));

  // Two-key rate limiter: per-IP catches credential-stuffing across
  // many accounts, per-email catches spray against a single account.
  // ~5 attempts per burst, refill one per ~12s — legitimate retypes
  // aren't blocked, a script doing 60/min is.
  const h0 = headers();
  const ip = h0.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  const byIp = rateLimit(`login:ip:${ip}`, { capacity: 5, refillPerSec: 0.08 });
  const byEmail = rateLimit(`login:email:${email || "_"}`, { capacity: 5, refillPerSec: 0.08 });
  if (!byIp.ok || !byEmail.ok) {
    redirect(`/login?e=throttled${returnTo !== "/" ? `&returnTo=${encodeURIComponent(returnTo)}` : ""}`);
  }

  const user = await authenticateWithPassword(email, password);
  if (!user) redirect(`/login?e=1${returnTo !== "/" ? `&returnTo=${encodeURIComponent(returnTo)}` : ""}`);
  if (user.totpConfirmedAt && user.totpSecret) {
    issuePending(user.id);
    redirect(`/login?step=2fa${returnTo !== "/" ? `&returnTo=${encodeURIComponent(returnTo)}` : ""}`);
  }
  const h = headers();
  await startSession(user.id, {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
    userAgent: h.get("user-agent") ?? undefined,
  });
  await prisma.eventLog.create({
    data: { kind: "user.login", refType: "user", refId: user.id, actorId: user.id },
  });
  redirect(returnTo);
}

async function verify2fa(formData: FormData) {
  "use server";
  const pendingId = readPending();
  const returnTo = safeReturnTo(String(formData.get("returnTo") ?? ""));
  if (!pendingId) redirect("/login?e=expired");
  // Brute-force guard on the 6-digit code. Per-pending-id caps a
  // single handshake to a handful of tries — the pending cookie
  // expires in 5 minutes, but a script could otherwise grind
  // 1,000,000 codes in that window.
  const byPending = rateLimit(`2fa:${pendingId}`, { capacity: 5, refillPerSec: 0.1 });
  if (!byPending.ok) {
    redirect(`/login?step=2fa&e=throttled${returnTo !== "/" ? `&returnTo=${encodeURIComponent(returnTo)}` : ""}`);
  }
  const user = await prisma.user.findUnique({ where: { id: pendingId } });
  if (!user || !user.active || !user.totpSecret) redirect("/login?e=expired");
  const token = String(formData.get("token") ?? "");
  if (!verifyTotp(token, user!.totpSecret!)) {
    redirect(`/login?step=2fa&e=wrong_code${returnTo !== "/" ? `&returnTo=${encodeURIComponent(returnTo)}` : ""}`);
  }
  clearPending();
  const h = headers();
  await startSession(user!.id, {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
    userAgent: h.get("user-agent") ?? undefined,
  });
  await prisma.eventLog.create({
    data: { kind: "user.login", refType: "user", refId: user!.id, actorId: user!.id, data: JSON.stringify({ twoFactor: true }) },
  });
  redirect(returnTo);
}

export default async function Login({
  searchParams,
}: {
  searchParams: { e?: string; step?: string; returnTo?: string };
}) {
  if (await isAuthed()) redirect(safeReturnTo(searchParams.returnTo));
  const brand = process.env.APP_BRAND ?? "Einai";
  const step2fa = searchParams.step === "2fa" && readPending();
  const returnTo = safeReturnTo(searchParams.returnTo);

  return (
    <div className="min-h-screen bg-ink-50 grid grid-cols-1 md:grid-cols-[1.15fr_1fr]">
      <aside className="hidden md:flex flex-col justify-between p-16 bg-ink-0 border-e border-ink-100">
        <div className="flex items-center gap-2.5">
          <span className="h-2 w-2 rounded-full bg-ink-900" />
          <span className="text-[15px] font-medium tracking-tight">{brand}</span>
        </div>
        <div className="max-w-md">
          <p className="text-[28px] leading-tight tracking-tightest text-ink-900 font-medium">
            Invitations, responses, arrivals — one quiet workspace.
          </p>
          <p className="text-sm text-ink-500 mt-6 leading-relaxed">
            Protocol-grade RSVP. Bilingual by default. Nothing leaves the page that isn&apos;t asked for.
          </p>
        </div>
        <p className="text-xs text-ink-400">© {new Date().getFullYear()} {brand}</p>
      </aside>

      <main className="flex items-center justify-center px-6 py-16">
        {step2fa ? (
          <form action={verify2fa} className="w-full max-w-sm flex flex-col gap-6">
            <input type="hidden" name="returnTo" value={returnTo} />
            <div className="md:hidden flex items-center gap-2.5 mb-4">
              <span className="h-2 w-2 rounded-full bg-ink-900" />
              <span className="text-[15px] font-medium tracking-tight">{brand}</span>
            </div>
            <div>
              <h1 className="text-[22px] tracking-tightest font-medium text-ink-900">Enter code</h1>
              <p className="text-sm text-ink-500 mt-1">
                Open your authenticator app and enter the current 6-digit code.
              </p>
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] uppercase tracking-wider text-ink-400">Code</span>
              <input
                name="token"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                autoComplete="one-time-code"
                autoFocus
                required
                className="field font-mono tracking-widest text-center"
                placeholder="000000"
              />
            </label>
            {searchParams.e === "wrong_code" ? (
              <p role="alert" className="text-xs text-signal-fail">Wrong code — codes rotate every 30s.</p>
            ) : searchParams.e === "throttled" ? (
              <p role="alert" className="text-xs text-signal-fail">Too many attempts. Try again in a minute.</p>
            ) : null}
            <button className="btn btn-primary w-full py-3">Verify</button>
            <a href="/login" className="text-mini text-ink-400 hover:text-ink-900 text-center">Cancel</a>
          </form>
        ) : (
          <form action={loginAction} className="w-full max-w-sm flex flex-col gap-6" aria-label="Sign in">
            <input type="hidden" name="returnTo" value={returnTo} />
            <div className="md:hidden flex items-center gap-2.5 mb-4">
              <span className="h-2 w-2 rounded-full bg-ink-900" />
              <span className="text-[15px] font-medium tracking-tight">{brand}</span>
            </div>
            <div>
              <h1 className="text-[22px] tracking-tightest font-medium text-ink-900">Sign in</h1>
              <p className="text-sm text-ink-500 mt-1">Use your protocol email.</p>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] uppercase tracking-wider text-ink-400">Email</span>
              <input name="email" type="email" required autoFocus autoComplete="email" className="field" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11px] uppercase tracking-wider text-ink-400">Password</span>
              <input name="password" type="password" required autoComplete="current-password" className="field" />
            </label>

            {searchParams.e ? (
              <p role="alert" className="text-xs text-signal-fail">
                {searchParams.e === "expired"
                  ? "That sign-in step expired. Try again."
                  : searchParams.e === "throttled"
                    ? "Too many attempts. Try again in a minute."
                    : "Incorrect email or password."}
              </p>
            ) : null}

            <button className="btn btn-primary w-full py-3">Continue</button>

            {process.env.NODE_ENV !== "production" ? (
              <p className="text-mini text-ink-400 mt-2">
                Dev bootstrap: <code className="text-ink-700">admin@local</code> with{" "}
                <code className="text-ink-700">ADMIN_PASSWORD</code> env.
              </p>
            ) : null}
          </form>
        )}
      </main>
    </div>
  );
}
