import Link from "next/link";
import type { ReactNode } from "react";

// The dominant canvas. Edges are quiet: a thin rail, a thin top seam,
// nothing else. Secondary actions live in the header slot.

export function Shell({
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
  return (
    <div className="min-h-screen grid grid-cols-[220px_1fr]">
      <aside className="border-r border-ink-200 bg-ink-0 px-6 py-6">
        <Link href="/" className="flex items-center gap-2 mb-10">
          <span className="h-2 w-2 rounded-full bg-ink-900" />
          <span className="text-sm font-medium tracking-tight">Einai</span>
        </Link>
        <nav className="flex flex-col gap-1 text-sm text-ink-600">
          <Link href="/" className="rounded-md px-2 py-1.5 hover:bg-ink-100 hover:text-ink-900">
            Campaigns
          </Link>
          <Link href="/contacts" className="rounded-md px-2 py-1.5 hover:bg-ink-100 hover:text-ink-900">
            Contacts
          </Link>
          <Link href="/settings" className="rounded-md px-2 py-1.5 hover:bg-ink-100 hover:text-ink-900">
            Settings
          </Link>
        </nav>
      </aside>
      <main className="flex flex-col">
        <header className="flex items-center justify-between px-10 py-6 border-b border-ink-200 bg-ink-0">
          <div className="flex items-baseline gap-3">
            <h1 className="text-[15px] font-medium tracking-tight text-ink-900">{title}</h1>
            {crumb ? <div className="text-xs text-ink-400">{crumb}</div> : null}
          </div>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
        <div className="flex-1 px-10 py-8">{children}</div>
      </main>
    </div>
  );
}
