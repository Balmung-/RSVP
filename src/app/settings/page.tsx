import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Icon } from "@/components/Icon";
import { getCurrentUser, hasRole, endSession, isAuthed } from "@/lib/auth";
import {
  readAdminLocale,
  writeAdminLocale,
  readAdminCalendar,
  writeAdminCalendar,
  adminDict,
  type AdminLocale,
  type AdminCalendar,
} from "@/lib/adminLocale";

export const dynamic = "force-dynamic";

async function signOut() {
  "use server";
  await endSession();
  redirect("/login");
}

async function savePrefs(formData: FormData) {
  "use server";
  const loc = String(formData.get("locale") ?? "en");
  const cal = String(formData.get("calendar") ?? "gregorian");
  writeAdminLocale((loc === "ar" ? "ar" : "en") as AdminLocale);
  writeAdminCalendar((cal === "hijri" ? "hijri" : "gregorian") as AdminCalendar);
  redirect("/settings");
}

export default async function Settings() {
  if (!(await isAuthed())) redirect("/login");
  const user = await getCurrentUser();
  const locale = readAdminLocale();
  const calendar = readAdminCalendar();
  const T = adminDict(locale);

  const emailProvider = process.env.EMAIL_PROVIDER ?? "stub";
  const smsProvider = process.env.SMS_PROVIDER ?? "stub";
  const appUrl = process.env.APP_URL ?? "—";
  const brand = process.env.APP_BRAND ?? "—";
  const tenantLocale = process.env.DEFAULT_LOCALE ?? "en";
  const timezone = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
  const webhookReady = !!process.env.WEBHOOK_SIGNING_SECRET;
  const strictHealth = process.env.HEALTH_REQUIRE_DB === "true";
  const cronReady = !!process.env.CRON_SECRET;
  const inboundReady = !!process.env.INBOUND_EMAIL_DOMAIN && !!process.env.INBOUND_WEBHOOK_SECRET;
  const autoAckOn = (process.env.INBOUND_AUTO_ACK ?? "true").toLowerCase() !== "false";
  const teamsOn = (process.env.TEAMS_ENABLED ?? "").toLowerCase() === "true";

  return (
    <Shell title={T.settings}>
      <div className="panel p-10 max-w-3xl">
        <h2 className="text-sub text-ink-900 mb-6">{T.account}</h2>
        <div className="grid grid-cols-2 gap-6 text-body mb-8">
          <Row label={T.signedInAs} value={user?.email ?? "—"} />
          <Row label={T.role} value={user?.role ?? "—"} />
        </div>

        <form action={savePrefs} className="grid grid-cols-[1fr_1fr_auto] gap-3 items-end mb-10 max-w-xl">
          <label className="flex flex-col gap-1.5">
            <span className="text-micro uppercase text-ink-400">{T.language}</span>
            <select name="locale" className="field" defaultValue={locale}>
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-micro uppercase text-ink-400">{T.calendar}</span>
            <select name="calendar" className="field" defaultValue={calendar}>
              <option value="gregorian">{T.gregorian}</option>
              <option value="hijri">{T.hijri}</option>
            </select>
          </label>
          <button className="btn btn-soft">
            <Icon name="check" size={14} />
            {T.save}
          </button>
        </form>

        <h2 className="text-sub text-ink-900 mb-6">{T.integrations}</h2>
        <div className="grid grid-cols-2 gap-6 text-body">
          <Row label="Email provider" value={emailProvider} live={emailProvider !== "stub"} />
          <Row label="SMS provider" value={smsProvider} live={smsProvider !== "stub"} />
          <Row label="App URL" value={appUrl} />
          <Row label="Brand" value={brand} />
          <Row label="Tenant locale" value={tenantLocale} />
          <Row label="Timezone" value={timezone} />
          <Row label="Delivery webhook" value={webhookReady ? "configured" : "disabled"} live={webhookReady} />
          <Row label="Cron tick" value={cronReady ? "configured" : "disabled"} live={cronReady} />
          <Row label="Inbound replies" value={inboundReady ? "configured" : "disabled"} live={inboundReady} />
          <Row label="Inbound auto-ack" value={autoAckOn ? "on" : "off"} live={autoAckOn} />
          <Row label="Strict health" value={strictHealth ? "on" : "off"} live={strictHealth} />
          <Row label="Teams feature" value={teamsOn ? "enabled" : "disabled"} live={teamsOn} />
        </div>
        <p className="text-mini text-ink-400 mt-8 leading-relaxed">
          Providers + feature flags are set via environment variables — see{" "}
          <code className="text-ink-700">.env.example</code>. Stub mode logs outgoing messages
          to the server console.
        </p>
      </div>

      <div className="mt-6 flex items-center gap-3 flex-wrap">
        <Link href="/account/password" className="btn btn-ghost">
          <Icon name="settings" size={14} />
          {T.changePassword}
        </Link>
        <Link href="/account/2fa" className="btn btn-ghost">
          <Icon name="qr" size={14} />
          {T.twoStep}
          {user?.totpConfirmedAt ? <span className="text-signal-live ms-1">· on</span> : null}
        </Link>
        {hasRole(user, "admin") ? (
          <Link href="/users" className="btn btn-ghost">{T.managePeople}</Link>
        ) : null}
      </div>

      <form action={signOut} className="mt-6">
        <button className="btn btn-ghost">
          <Icon name="log-out" size={14} />
          {T.signOut}
        </button>
      </form>
    </Shell>
  );
}

function Row({ label, value, live }: { label: string; value: string; live?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-micro uppercase text-ink-400">{label}</span>
      <span className="flex items-center gap-2 text-ink-900">
        {live !== undefined ? (
          <span className={`dot ${live ? "bg-signal-live" : "bg-ink-400"}`} />
        ) : null}
        <span className="font-medium">{value}</span>
      </span>
    </div>
  );
}
