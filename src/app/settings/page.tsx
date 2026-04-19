import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Icon } from "@/components/Icon";
import { getCurrentUser, hasRole, endSession, isAuthed } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  readAdminLocale,
  writeAdminLocale,
  readAdminCalendar,
  writeAdminCalendar,
  adminDict,
  formatAdminDate,
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

// OAuth banner reasons -> human message. Keep this table in sync with
// the slug vocabulary emitted by:
//   - src/app/api/oauth/google/start/route.ts         (redirectFailed)
//   - src/app/api/oauth/google/callback/route.ts      (SETTINGS_ERR)
//   - src/app/api/oauth/google/disconnect/route.ts    (SETTINGS_*)
// Any new reason string added there needs a line here or it falls
// through to the generic fallback.
const OAUTH_REASON_COPY: Record<string, string> = {
  // /start + /callback (connect flow)
  forbidden: "You must be an admin to connect Gmail.",
  malformed: "The callback URL was missing a code or state — please retry.",
  invalid_team: "That team no longer exists — try a different scope.",
  not_configured: "Gmail OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID in .env.",
  state_signature: "The sign-in request signature didn't match. Please retry the connect flow.",
  state_expired: "The sign-in request expired (10 minutes max). Please retry.",
  state_future: "The sign-in request timestamp was invalid. Please retry.",
  state_version: "The sign-in request format was not recognized. Please retry.",
  state_payload: "The sign-in request payload was malformed. Please retry.",
  state_malformed: "The sign-in request was malformed. Please retry.",
  nonce_mismatch: "Cross-site request blocked — please retry the connect flow.",
  exchange_failed: "Google rejected the code exchange. Please retry.",
  no_refresh_token: "Google didn't return a refresh token — please retry (will force consent).",
  scope_incomplete: "Required permissions (gmail.send) were not granted. Please approve all scopes on retry.",
  userinfo_failed: "Could not read your Google account info. Please retry.",
  encryption_failed: "Server config error (OAUTH_ENCRYPTION_KEY). Contact an admin.",
  team_gone: "The team this connection targeted was deleted mid-flow. Please retry.",
  persist_failed: "Could not save the connection. Please retry.",
  access_denied: "You declined the Google consent screen.",
  // /disconnect
  no_account: "No Gmail connection was found to disconnect.",
  local_delete_failed: "Could not remove the local record. Please retry or contact an admin.",
  decrypt_failed: "Could not decrypt the stored refresh token — local record removed anyway. Check Google's account-security page to confirm revocation.",
  network: "Could not reach Google to revoke the token — local record removed anyway. Check Google's account-security page to confirm revocation.",
};

function oauthReasonCopy(reason: string | null): string {
  if (!reason) return "";
  if (OAUTH_REASON_COPY[reason]) return OAUTH_REASON_COPY[reason];
  // e.g. `remote_503` from disconnect warn branch.
  if (reason.startsWith("remote_")) {
    return `Google's revoke endpoint returned ${reason.slice(7)} — local record removed anyway. Check Google's account-security page to confirm revocation.`;
  }
  return `Unknown failure reason: ${reason}`;
}

export default async function Settings({
  searchParams,
}: {
  searchParams?: { oauth?: string; reason?: string };
}) {
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
  const digestOn = ["true", "1", "on"].includes((process.env.DELIVERABILITY_DIGEST ?? "").toLowerCase());
  const teamsOn = (process.env.TEAMS_ENABLED ?? "").toLowerCase() === "true";

  // Gmail OAuth surface — office-wide slot only for B1b. Per-team
  // rows come with B3. The query mirrors the send-path order (updatedAt
  // desc) so a transient NULL-race duplicate shows the fresher row.
  const gmailConfigured =
    !!process.env.GOOGLE_OAUTH_CLIENT_ID &&
    !!process.env.GOOGLE_OAUTH_REDIRECT_URI &&
    !!process.env.OAUTH_ENCRYPTION_KEY;
  const gmailAccount = gmailConfigured
    ? await prisma.oAuthAccount.findFirst({
        where: { provider: "google", teamId: null },
        orderBy: [
          { updatedAt: "desc" },
          { createdAt: "desc" },
          { id: "desc" },
        ],
        select: {
          id: true,
          googleEmail: true,
          scopes: true,
          createdAt: true,
          updatedAt: true,
        },
      })
    : null;
  const isAdmin = hasRole(user, "admin");

  // Read the result of a just-completed OAuth round-trip (connect or
  // disconnect). The *_WARN variant exists so a locally-successful
  // disconnect with a remote-revoke failure can show "done, but check
  // Google" instead of "failed" — different UX for a different
  // situation.
  const oauthFlag = searchParams?.oauth ?? null;
  const oauthReason = searchParams?.reason ?? null;
  const oauthBanner: {
    kind: "ok" | "warn" | "err";
    title: string;
    detail: string;
  } | null = (() => {
    switch (oauthFlag) {
      case "google_connected":
        return {
          kind: "ok",
          title: "Gmail connected",
          detail: gmailAccount
            ? `Connected as ${gmailAccount.googleEmail}. Invitations will now send from this mailbox when EMAIL_PROVIDER=gmail.`
            : "Connection recorded. Invitations will now send from this mailbox when EMAIL_PROVIDER=gmail.",
        };
      case "google_failed":
        return {
          kind: "err",
          title: "Gmail connection failed",
          detail: oauthReasonCopy(oauthReason),
        };
      case "google_disconnected":
        return {
          kind: "ok",
          title: "Gmail disconnected",
          detail: "The office mailbox has been disconnected. Invitations will fall back to the configured relay until you reconnect.",
        };
      case "google_disconnected_warn":
        return {
          kind: "warn",
          title: "Gmail disconnected (with a caveat)",
          detail: oauthReasonCopy(oauthReason),
        };
      case "google_disconnect_failed":
        return {
          kind: "err",
          title: "Gmail disconnect failed",
          detail: oauthReasonCopy(oauthReason),
        };
      default:
        return null;
    }
  })();

  return (
    <Shell title={T.settings}>
      {oauthBanner ? (
        <div
          className={`panel p-4 max-w-3xl mb-6 border-l-4 ${
            oauthBanner.kind === "ok"
              ? "border-signal-live"
              : oauthBanner.kind === "warn"
                ? "border-amber-500"
                : "border-red-500"
          }`}
          role="status"
          aria-live="polite"
        >
          <div className="flex items-start gap-3">
            <Icon
              name={oauthBanner.kind === "ok" ? "check" : "warning"}
              size={18}
            />
            <div className="flex-1">
              <div className="text-body font-medium text-ink-900">
                {oauthBanner.title}
              </div>
              <div className="text-mini text-ink-700 mt-1 leading-relaxed">
                {oauthBanner.detail}
              </div>
            </div>
            <Link
              href="/settings"
              className="text-mini text-ink-400 hover:text-ink-700"
              aria-label="Dismiss"
            >
              ✕
            </Link>
          </div>
        </div>
      ) : null}
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
          <Row label="Daily digest" value={digestOn ? "on" : "off"} live={digestOn} />
          <Row label="Strict health" value={strictHealth ? "on" : "off"} live={strictHealth} />
          <Row label="Teams feature" value={teamsOn ? "enabled" : "disabled"} live={teamsOn} />
        </div>
        <p className="text-mini text-ink-400 mt-8 leading-relaxed">
          Providers + feature flags are set via environment variables — see{" "}
          <code className="text-ink-700">.env.example</code>. Stub mode logs outgoing messages
          to the server console.
        </p>

        {/* Gmail connection — separate sub-section because it's the
            only integration with admin-initiated state (connect /
            disconnect) rather than a pure env-var display. B3 will
            extend this to a per-team list; for B1b only the office-
            wide (teamId=null) slot is surfaced. */}
        <div className="mt-10 pt-8 border-t border-ink-100">
          <h3 className="text-sub text-ink-900 mb-4">Gmail (office-wide)</h3>
          {!gmailConfigured ? (
            <div className="text-mini text-ink-700 leading-relaxed">
              Gmail OAuth is not configured. To send invitations as a real
              Gmail mailbox, set{" "}
              <code className="text-ink-900">GOOGLE_OAUTH_CLIENT_ID</code>,{" "}
              <code className="text-ink-900">GOOGLE_OAUTH_CLIENT_SECRET</code>,{" "}
              <code className="text-ink-900">GOOGLE_OAUTH_REDIRECT_URI</code>,
              and{" "}
              <code className="text-ink-900">OAUTH_ENCRYPTION_KEY</code> in
              your environment — see{" "}
              <code className="text-ink-900">.env.example</code>.
            </div>
          ) : gmailAccount ? (
            <div className="grid grid-cols-2 gap-6 text-body">
              <Row
                label="Connected account"
                value={gmailAccount.googleEmail}
                live
              />
              <Row
                label="Scopes"
                value={
                  gmailAccount.scopes.includes("gmail.send")
                    ? "gmail.send + openid + email"
                    : gmailAccount.scopes
                }
              />
              <Row
                label="Connected"
                value={formatAdminDate(
                  gmailAccount.createdAt,
                  locale,
                  calendar,
                )}
              />
              <Row
                label="Last refreshed"
                value={formatAdminDate(
                  gmailAccount.updatedAt,
                  locale,
                  calendar,
                )}
              />
              <div className="col-span-2 flex items-center gap-3 mt-2">
                {isAdmin ? (
                  <>
                    <Link
                      href="/api/oauth/google/start"
                      className="btn btn-ghost"
                    >
                      <Icon name="link" size={14} />
                      Reconnect
                    </Link>
                    {/* Plain <form> POST avoids the client-bundle
                        overhead of a server-action-for-one-button.
                        The handler at /api/oauth/google/disconnect
                        enforces admin re-check + same-origin via the
                        session cookie's SameSite=Lax. */}
                    <form
                      action="/api/oauth/google/disconnect"
                      method="post"
                      className="inline"
                    >
                      <button className="btn btn-ghost text-red-600 hover:text-red-700">
                        <Icon name="x" size={14} />
                        Disconnect
                      </button>
                    </form>
                  </>
                ) : (
                  <span className="text-mini text-ink-400">
                    Admin-only actions — sign in as an admin to reconnect or
                    disconnect.
                  </span>
                )}
              </div>
              {emailProvider !== "gmail" ? (
                <p className="col-span-2 text-mini text-ink-400 leading-relaxed mt-2">
                  Note: <code className="text-ink-700">EMAIL_PROVIDER</code> is
                  currently <code className="text-ink-700">{emailProvider}</code>{" "}
                  — this connection is stored but not used for sends. Set{" "}
                  <code className="text-ink-700">EMAIL_PROVIDER=gmail</code> to
                  route invitations through this mailbox.
                </p>
              ) : null}
            </div>
          ) : (
            <div className="flex items-center gap-4">
              <span className="text-mini text-ink-700">
                Not connected. Invitations will send via the generic relay
                ({emailProvider}).
              </span>
              {isAdmin ? (
                <Link
                  href="/api/oauth/google/start"
                  className="btn btn-soft"
                >
                  <Icon name="link" size={14} />
                  Connect Gmail
                </Link>
              ) : (
                <span className="text-mini text-ink-400">
                  Admin-only action.
                </span>
              )}
            </div>
          )}
        </div>
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
