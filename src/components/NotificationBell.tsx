import Link from "next/link";
import { Icon } from "./Icon";
import type { NotificationItem } from "@/lib/notifications";

// Header notification surface. One dot when anything needs attention,
// nothing when clear. Details are recessed behind a <details> reveal
// so the outer read stays clean — no badge numbers in the bar.
//
// Directive fit:
//   - one dominant signal (the dot)
//   - secondary tool recessed (details / summary)
//   - controlled access (click to open)
//   - rare + sharp (only shows when something is actually pending)

export function NotificationBell({ items }: { items: NotificationItem[] }) {
  const active = items.length > 0;
  return (
    <details className="relative group">
      <summary
        className="list-none cursor-pointer select-none inline-flex items-center justify-center h-8 w-8 rounded-full text-ink-500 hover:text-ink-900 hover:bg-ink-100 transition-colors"
        aria-label={active ? `${items.length} items need attention` : "Notifications"}
      >
        <span className="relative">
          <Icon name="bell" size={15} />
          {active ? (
            <span
              className="absolute -top-0.5 -end-0.5 h-1.5 w-1.5 rounded-full bg-signal-fail"
              aria-hidden
            />
          ) : null}
        </span>
      </summary>
      <div className="absolute end-0 mt-2 w-80 rounded-xl border border-ink-100 bg-ink-0 shadow-lg overflow-hidden z-20">
        {items.length === 0 ? (
          <div className="px-5 py-6 text-center text-mini text-ink-400">
            Nothing needs attention.
          </div>
        ) : (
          <ul className="divide-y divide-ink-100">
            {items.map((it) => (
              <li key={it.kind}>
                <Link
                  href={it.href}
                  className="flex items-start gap-3 px-4 py-3 hover:bg-ink-50 transition-colors"
                >
                  <span
                    className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${
                      it.tone === "fail"
                        ? "bg-signal-fail"
                        : it.tone === "warn"
                          ? "bg-signal-hold"
                          : "bg-ink-400"
                    }`}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-body text-ink-900 truncate">{it.title}</div>
                    {it.detail ? (
                      <div className="text-mini text-ink-500 truncate mt-0.5">{it.detail}</div>
                    ) : null}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
