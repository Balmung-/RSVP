"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import type { NotificationItem } from "@/lib/notifications";

// Header notification surface. One dot when anything needs attention,
// nothing when clear. Detail is hidden until the user opens it.
//
// Controlled open state with two close triggers:
//   1. pathname change (user navigated away via any link)
//   2. click outside the popover
// The underlying element is still <details>/<summary> so the
// keyboard behavior (Enter to toggle, Escape via native focus
// handling) comes for free. We just observe the DOM's open state
// and force it shut in those two cases.
//
// Directive fit: single dot signal, complexity hidden, controlled
// access, closes cleanly after a decision.

export function NotificationBell({ items }: { items: NotificationItem[] }) {
  const ref = useRef<HTMLDetailsElement | null>(null);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const active = items.length > 0;

  // Close on navigation. If the user just clicked a notification row,
  // the target page is now rendering and the panel should retract.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Close on outside-click. Ignore clicks inside the details itself;
  // anywhere else on the page retracts the panel.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current) return;
      if (e.target instanceof Node && !ref.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <details
      ref={ref}
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="relative"
    >
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
