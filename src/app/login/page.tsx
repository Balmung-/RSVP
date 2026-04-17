import { redirect } from "next/navigation";
import { authenticate, isAuthed, issueSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function loginAction(formData: FormData) {
  "use server";
  const pw = String(formData.get("password") ?? "");
  if (!authenticate(pw)) redirect("/login?e=1");
  issueSession();
  redirect("/");
}

export default function Login({ searchParams }: { searchParams: { e?: string } }) {
  if (isAuthed()) redirect("/");
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
        <input
          name="password"
          type="password"
          placeholder="Password"
          autoFocus
          required
          className="field"
        />
        {searchParams.e ? <p className="text-xs text-signal-fail">Incorrect password.</p> : null}
        <button className="btn-primary">Continue</button>
      </form>
    </div>
  );
}
