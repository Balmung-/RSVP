import Link from "next/link";
import type { ReactNode } from "react";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { consumeFlash } from "@/lib/flash";
import { teamsEnabled } from "@/lib/teams";
import { readAdminLocale, adminDict } from "@/lib/adminLocale";
import { getNotifications } from "@/lib/notifications";
import { Icon, type IconName } from "./Icon";
import { Toast } from "./Toast";
import { CommandPalette } from "./CommandPalette";
import { CommandHint } from "./CommandHint";
import { NotificationBell } from "./NotificationBell";

// The shell reads as a single horizontal plane. A 56px icon rail on
// the edge holds navigation; it recedes, never asserts itself, and
// the workspace owns the rest of the canvas. Labels live in tooltips
// (hover) and in ⌘K (keyboard) — the rail's job is orientation, not
// exposition. One dominant through-line: the page.

export async function Shell({
  title,
  crumb,
  actions,
  children,
  compactTitle = false,
}: {
  title: string;
  crumb?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  compactTitle?: boolean;
}) {
  const me = await getCurrentUser();
  const isAdmin = hasRole(me, "admin");
  const flash = consumeFlash();
  const showTeams = teamsEnabled() && isAdmin;
  const locale = readAdminLocale();
  const T = adminDict(locale);
  const notifications = me ? await getNotifications(me.id, isAdmin) : [];

  return (
    <div className="min-h-screen grid grid-cols-[56px_1fr]">
      <aside className="border-e border-ink-100 bg-ink-0 flex flex-col items-center py-4 gap-1">
        <Link
          href="/"
          className="h-8 w-8 rounded-md bg-ink-900 grid place-items-center mb-4"
          title="Einai"
          aria-label="Einai · Overview"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-ink-0" />
        </Link>
        <nav className="flex flex-col items-center gap-1">
          <RailLink href="/" icon="dashboard" label={T.overview} hint="g h" />
          <RailLink href="/campaigns" icon="calendar-check" label={T.campaigns} hint="g c" />
          <RailLink href="/contacts" icon="users" label={T.contacts} hint="g p" />
          <RailLink
            href="/templates"
            icon="file-text"
            label={locale === "ar" ? "القوالب" : "Templates"}
            hint="g t"
          />
          <RailLink href="/inbox" icon="inbox" label={T.inbox} hint="g i" />
          {isAdmin ? (
            <RailLink
              href="/approvals"
              icon="circle-alert"
              label={locale === "ar" ? "الموافقات" : "Approvals"}
              hint="g a"
            />
          ) : null}
          {isAdmin ? (
            <RailLink href="/deliverability" icon="warning" label={T.deliverability} hint="g d" />
          ) : null}
          {isAdmin ? (
            <RailLink
              href="/unsubscribes"
              icon="eye-off"
              label={locale === "ar" ? "المنسحبون" : "Unsubscribes"}
              hint="g u"
            />
          ) : null}
          {showTeams ? <RailLink href="/teams" icon="tag" label={T.teams} hint="g m" /> : null}
          {isAdmin ? (
            <RailLink href="/users" icon="user-plus" label={T.people} />
          ) : null}
          {isAdmin ? <RailLink href="/events" icon="list" label={T.events} hint="g e" /> : null}
        </nav>
        <div className="mt-auto flex flex-col items-center gap-1">
          <RailLink href="/settings" icon="settings" label="Settings" hint="g s" />
          <Link
            href="/account/password"
            className="h-8 w-8 rounded-md bg-ink-100 grid place-items-center text-mini font-medium text-ink-600 hover:bg-ink-200 hover:text-ink-900 transition-colors"
            title={me?.email ?? "Account"}
            aria-label={me?.email ?? "Account"}
          >
            {me?.email?.[0]?.toUpperCase() ?? "?"}
          </Link>
        </div>
      </aside>

      <main className="flex flex-col min-w-0">
        {me?.mustChangePassword ? (
          <div className="bg-signal-hold/10 border-b border-signal-hold/30 text-signal-hold px-10 py-2.5 flex items-center justify-between">
            <span className="text-body">
              Your password was set by an admin. Please pick your own before continuing.
            </span>
            <Link href="/account/password" className="btn btn-soft text-mini">
              Change password
            </Link>
          </div>
        ) : null}
        {compactTitle ? (
          <header className="flex items-center justify-between px-10 py-4 border-b border-ink-100 bg-ink-0">
            <div className="min-w-0 flex items-baseline gap-3">
              <div className="text-mini text-ink-400 truncate">{crumb ?? title}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <CommandHint />
              <NotificationBell items={notifications} />
              {actions}
            </div>
          </header>
        ) : (
          <header className="flex items-center justify-between px-10 py-6 border-b border-ink-100 bg-ink-0">
            <div className="min-w-0">
              {crumb ? <div className="text-mini text-ink-400 mb-1 truncate">{crumb}</div> : null}
              <h1 className="text-section text-ink-900 truncate">{title}</h1>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <CommandHint />
              <NotificationBell items={notifications} />
              {actions}
            </div>
          </header>
        )}
        <div className="flex-1 px-10 py-10 min-w-0">{children}</div>
      </main>
      {flash ? <Toast flash={flash} /> : null}
      <CommandPalette isAdmin={isAdmin} teamsOn={showTeams} />
    </div>
  );
}

function RailLink({
  href,
  icon,
  label,
  hint,
}: {
  href: string;
  icon: IconName;
  label: string;
  hint?: string;
}) {
  return (
    <Link
      href={href}
      className="group relative h-9 w-9 rounded-md grid place-items-center text-ink-500 hover:text-ink-900 hover:bg-ink-100 transition-colors"
      aria-label={label}
      title={hint ? `${label} · ${hint}` : label}
    >
      <Icon name={icon} size={16} />
    </Link>
  );
}
