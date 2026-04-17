import Link from "next/link";
import clsx from "clsx";

// URL-driven tabs. The caller decides which tab is "active"; each item is a
// Link to the same page with the tab set. Server-rendered, no client state.

export type TabItem = {
  id: string;
  label: string;
  href: string;
  count?: number | null;
  hidden?: boolean;
};

export function Tabs({ active, items }: { active: string; items: TabItem[] }) {
  const shown = items.filter((t) => !t.hidden);
  return (
    <nav
      role="tablist"
      aria-label="Workspace sections"
      className="flex gap-8 border-b border-ink-200 -mx-10 px-10"
    >
      {shown.map((t) => {
        const isActive = active === t.id;
        return (
          <Link
            key={t.id}
            href={t.href}
            role="tab"
            aria-selected={isActive}
            className={clsx(
              "pb-3 -mb-px border-b text-sm transition-colors",
              isActive
                ? "border-ink-900 text-ink-900 font-medium"
                : "border-transparent text-ink-500 hover:text-ink-900",
            )}
          >
            <span>{t.label}</span>
            {typeof t.count === "number" ? (
              <span
                className={clsx(
                  "ms-2 text-xs tabular-nums",
                  isActive ? "text-ink-400" : "text-ink-300",
                )}
              >
                {t.count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
