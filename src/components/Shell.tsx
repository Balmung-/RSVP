import Link from "next/link";
import type { ReactNode } from "react";
import { getCurrentUser, hasRole } from "@/lib/auth";

// The dominant canvas. Edges are quiet: a thin rail, a thin top seam.
// Secondary actions live in the header slot. Admin-only links are hidden
// from editors/viewers at render time.

export async function Shell({
  title,
  crumb,
  actions,
  children,
}: {
  title: string;
  crumb?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const me = await getCurrentUser();
  const isAdmin = hasRole(me, "admin");

  return (
    <div className="min-h-screen grid grid-cols-[240px_1fr]">
      <aside className="border-r border-ink-200 bg-ink-0 px-5 py-6 flex flex-col">
        <Link href="/" className="flex items-center gap-2.5 mb-12 px-2">
          <span className="h-2 w-2 rounded-full bg-ink-900" />
          <span className="text-[15px] font-medium tracking-tight">Einai</span>
        </Link>
        <nav className="flex flex-col gap-0.5 text-sm text-ink-600">
          <NavLink href="/">Campaigns</NavLink>
          <NavLink href="/contacts">Contacts</NavLink>
          {isAdmin ? <NavLink href="/users">Team</NavLink> : null}
          {isAdmin ? <NavLink href="/events">Events</NavLink> : null}
        </nav>
        <div className="mt-auto pt-6 border-t border-ink-100">
          <Link
            href="/settings"
            className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-ink-100 transition-colors"
          >
            <span className="h-6 w-6 rounded-full bg-ink-100 text-[10px] font-medium text-ink-600 grid place-items-center">
              {me?.email?.[0]?.toUpperCase() ?? "?"}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-xs text-ink-900 truncate" title={me?.email ?? ""}>
                {me?.email ?? "Not signed in"}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-ink-400 mt-0.5">
                {me?.role ?? ""}
              </div>
            </div>
          </Link>
        </div>
      </aside>

      <main className="flex flex-col">
        <header className="flex items-center justify-between px-10 py-6 border-b border-ink-100 bg-ink-0">
          <div className="min-w-0 flex items-baseline gap-3">
            <h1 className="text-[15px] font-medium tracking-tight text-ink-900 truncate">{title}</h1>
            {crumb ? <div className="text-xs text-ink-400 truncate">{crumb}</div> : null}
          </div>
          <div className="flex items-center gap-2 shrink-0">{actions}</div>
        </header>
        <div className="flex-1 px-10 py-10">{children}</div>
      </main>
    </div>
  );
}

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md px-3 py-2 hover:bg-ink-100 hover:text-ink-900 transition-colors"
    >
      {children}
    </Link>
  );
}
