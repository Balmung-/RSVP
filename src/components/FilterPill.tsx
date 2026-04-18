import Link from "next/link";
import type { ReactNode } from "react";

// Shared horizontal filter pill — calm field, single sharp state for
// the active choice, tiny dot slot for channel / tone indicators.
// One file owns the look so /contacts, /deliverability, /inbox,
// /unsubscribes, and /events read as one continuous pattern instead
// of five local riffs.

export function FilterPill({
  href,
  active,
  children,
  dot,
}: {
  href: string;
  active: boolean;
  children: ReactNode;
  dot?: string | null;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-mini transition-colors ${
        active
          ? "bg-ink-900 text-ink-0"
          : "bg-ink-100 text-ink-600 hover:bg-ink-200 hover:text-ink-900"
      }`}
    >
      {dot ? <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden /> : null}
      {children}
    </Link>
  );
}

// Label for a group of pills. Kept compact so the row stays
// horizontal and doesn't grow into a stacked layout.
export function FilterLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-micro uppercase tracking-wider text-ink-400 shrink-0">
      {children}
    </span>
  );
}
