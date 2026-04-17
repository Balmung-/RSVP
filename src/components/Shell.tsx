import Link from "next/link";
import type { ReactNode } from "react";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { consumeFlash } from "@/lib/flash";
import { teamsEnabled } from "@/lib/teams";
import { readAdminLocale, adminDict } from "@/lib/adminLocale";
import { Icon, type IconName } from "./Icon";
import { Toast } from "./Toast";
import { CommandPalette } from "./CommandPalette";
import { CommandHint } from "./CommandHint";

// The dominant canvas. Edges are quiet: a thin rail, a thin top seam.
// Pages can set `compactTitle` when they render their own display-size
// title in the body, so we don't double-H1.

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

  return (
    <div className="min-h-screen grid grid-cols-[240px_1fr]">
      <aside className="border-r border-ink-100 bg-ink-0 px-4 py-6 flex flex-col">
        <Link href="/" className="flex items-center gap-2.5 mb-10 px-3">
          <span className="h-6 w-6 rounded-md bg-ink-900 grid place-items-center">
            <span className="h-1.5 w-1.5 rounded-full bg-ink-0" />
          </span>
          <span className="text-[15px] font-medium tracking-tight">Einai</span>
        </Link>
        <nav className="flex flex-col gap-0.5">
          <NavLink href="/" icon="dashboard">{T.overview}</NavLink>
          <NavLink href="/campaigns" icon="calendar-check">{T.campaigns}</NavLink>
          <NavLink href="/contacts" icon="users">{T.contacts}</NavLink>
          <NavLink href="/templates" icon="file-text">{locale === "ar" ? "القوالب" : "Templates"}</NavLink>
          <NavLink href="/inbox" icon="inbox">{T.inbox}</NavLink>
          {showTeams ? <NavLink href="/teams" icon="tag">{T.teams}</NavLink> : null}
          {isAdmin ? <NavLink href="/users" icon="user-plus">{T.people}</NavLink> : null}
          {isAdmin ? <NavLink href="/events" icon="list">{T.events}</NavLink> : null}
        </nav>
        <div className="mt-auto pt-4 border-t border-ink-100">
          <Link
            href="/settings"
            className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 hover:bg-ink-100 transition-colors"
          >
            <span className="h-7 w-7 rounded-full bg-ink-100 text-mini font-medium text-ink-600 grid place-items-center">
              {me?.email?.[0]?.toUpperCase() ?? "?"}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-mini text-ink-900 truncate" title={me?.email ?? ""}>
                {me?.email ?? "Not signed in"}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-ink-400 mt-0.5">
                {me?.role ?? ""}
              </div>
            </div>
            <Icon name="settings" size={14} className="text-ink-400" />
          </Link>
        </div>
      </aside>

      <main className="flex flex-col">
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
              {actions}
            </div>
          </header>
        )}
        <div className="flex-1 px-10 py-10">{children}</div>
      </main>
      {flash ? <Toast flash={flash} /> : null}
      <CommandPalette isAdmin={isAdmin} teamsOn={showTeams} />
    </div>
  );
}

function NavLink({ href, children, icon }: { href: string; children: ReactNode; icon: IconName }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-body text-ink-600 hover:bg-ink-100 hover:text-ink-900 transition-colors"
    >
      <Icon name={icon} size={16} className="text-ink-400" />
      <span>{children}</span>
    </Link>
  );
}
