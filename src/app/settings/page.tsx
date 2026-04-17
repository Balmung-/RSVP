import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { isAuthed, clearSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function signOut() {
  "use server";
  clearSession();
  redirect("/login");
}

export default function Settings() {
  if (!isAuthed()) redirect("/login");
  const emailProvider = process.env.EMAIL_PROVIDER ?? "stub";
  const smsProvider = process.env.SMS_PROVIDER ?? "stub";
  const appUrl = process.env.APP_URL ?? "—";
  const brand = process.env.APP_BRAND ?? "—";
  const locale = process.env.DEFAULT_LOCALE ?? "en";
  const timezone = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
  const webhookReady = !!process.env.WEBHOOK_SIGNING_SECRET;
  const strictHealth = process.env.HEALTH_REQUIRE_DB === "true";

  return (
    <Shell title="Settings">
      <div className="panel p-10 max-w-3xl">
        <h2 className="text-sm font-medium tracking-tight text-ink-900 mb-6">Integrations</h2>
        <div className="grid grid-cols-2 gap-6 text-sm">
          <Row label="Email provider" value={emailProvider} live={emailProvider !== "stub"} />
          <Row label="SMS provider" value={smsProvider} live={smsProvider !== "stub"} />
          <Row label="App URL" value={appUrl} />
          <Row label="Brand" value={brand} />
          <Row label="Default locale" value={locale} />
          <Row label="Timezone" value={timezone} />
          <Row label="Delivery webhook" value={webhookReady ? "configured" : "disabled"} live={webhookReady} />
          <Row label="Strict health" value={strictHealth ? "on" : "off"} live={strictHealth} />
        </div>
        <p className="text-xs text-ink-400 mt-8 leading-relaxed">
          Providers are configured via environment variables — see{" "}
          <code className="text-ink-700">.env.example</code>. Stub mode logs outgoing messages
          to the server console and records a synthetic id, letting you exercise the flow
          end-to-end before real keys are provisioned.
        </p>
      </div>
      <form action={signOut} className="mt-6">
        <button className="btn-ghost">Sign out</button>
      </form>
    </Shell>
  );
}

function Row({ label, value, live }: { label: string; value: string; live?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wider text-ink-400">{label}</span>
      <span className="flex items-center gap-2 text-ink-900">
        {live !== undefined ? (
          <span className={`dot ${live ? "bg-signal-live" : "bg-ink-400"}`} />
        ) : null}
        <span className="font-medium">{value}</span>
      </span>
    </div>
  );
}
