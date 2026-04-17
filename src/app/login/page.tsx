import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { authenticateWithPassword, startSession, isAuthed } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

async function loginAction(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const user = await authenticateWithPassword(email, password);
  if (!user) redirect("/login?e=1");
  const h = headers();
  await startSession(user.id, {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
    userAgent: h.get("user-agent") ?? undefined,
  });
  await prisma.eventLog.create({
    data: { kind: "user.login", refType: "user", refId: user.id, actorId: user.id },
  });
  redirect("/");
}

export default async function Login({ searchParams }: { searchParams: { e?: string } }) {
  if (await isAuthed()) redirect("/");
  const brand = process.env.APP_BRAND ?? "Einai";
  return (
    <div className="min-h-screen bg-ink-50 grid grid-cols-1 md:grid-cols-[1.15fr_1fr]">
      {/* Quiet brand field — holds the full left on desktop, hidden on mobile */}
      <aside className="hidden md:flex flex-col justify-between p-16 bg-ink-0 border-r border-ink-100">
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
        <form
          action={loginAction}
          className="w-full max-w-sm flex flex-col gap-6"
          aria-label="Sign in"
        >
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
            <input
              name="email"
              type="email"
              required
              autoFocus
              autoComplete="email"
              className="field"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wider text-ink-400">Password</span>
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="field"
            />
          </label>

          {searchParams.e ? (
            <p role="alert" className="text-xs text-signal-fail">
              Incorrect email or password.
            </p>
          ) : null}

          <button className="btn-primary w-full py-3">Continue</button>

          <p className="text-xs text-ink-400 mt-2">
            First time here? The root admin account is <code className="text-ink-700">admin@local</code> with
            the password set in <code className="text-ink-700">ADMIN_PASSWORD</code>.
          </p>
        </form>
      </main>
    </div>
  );
}
