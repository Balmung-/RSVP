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
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <form action={loginAction} className="panel w-full max-w-sm p-10 flex flex-col gap-6">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-ink-900" />
          <span className="text-sm font-medium tracking-tight">Einai</span>
        </div>
        <div>
          <h1 className="text-lg font-medium tracking-tight">Sign in</h1>
          <p className="text-sm text-ink-500 mt-1">Protocol access</p>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="sr-only">Email</span>
          <input
            name="email"
            type="email"
            placeholder="Email"
            autoFocus
            required
            autoComplete="email"
            className="field"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="sr-only">Password</span>
          <input
            name="password"
            type="password"
            placeholder="Password"
            required
            autoComplete="current-password"
            className="field"
          />
        </label>
        {searchParams.e ? <p className="text-xs text-signal-fail">Incorrect email or password.</p> : null}
        <button className="btn-primary">Continue</button>
      </form>
    </div>
  );
}
