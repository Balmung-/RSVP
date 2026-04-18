"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./Icon";

// Everything that used to live in the sidebar's "secondary" region —
// settings, account, admin-only tools, sign out — recesses behind
// this one icon in the top-right seam. Controlled open state mirrors
// NotificationBell: closes on navigation, closes on outside click.

type AvatarItem =
  | {
      kind: "link";
      href: string;
      label: string;
      icon?: IconName;
      danger?: boolean;
    }
  | {
      kind: "action";
      action: (fd: FormData) => Promise<void> | void;
      label: string;
      icon?: IconName;
      danger?: boolean;
    }
  | { kind: "divider" };

export function AvatarMenu({
  email,
  role,
  items,
}: {
  email: string | null;
  role: string | null;
  items: AvatarItem[];
}) {
  const ref = useRef<HTMLDetailsElement | null>(null);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

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
        className="list-none cursor-pointer select-none inline-flex items-center justify-center h-8 w-8 rounded-full bg-ink-100 text-mini font-medium text-ink-600 hover:bg-ink-200 hover:text-ink-900 transition-colors"
        aria-label={email ?? "Account"}
        title={email ?? "Account"}
      >
        {email?.[0]?.toUpperCase() ?? "?"}
      </summary>
      <div className="absolute end-0 mt-2 w-64 rounded-xl border border-ink-100 bg-ink-0 shadow-lg overflow-hidden z-20">
        {email ? (
          <div className="px-4 py-3 border-b border-ink-100">
            <div className="text-body text-ink-900 truncate">{email}</div>
            {role ? (
              <div className="text-micro uppercase tracking-wider text-ink-400 mt-0.5">
                {role}
              </div>
            ) : null}
          </div>
        ) : null}
        <ul className="py-1">
          {items.map((it, i) => {
            if (it.kind === "divider") {
              return <li key={`d-${i}`} className="my-1 border-t border-ink-100" />;
            }
            if (it.kind === "action") {
              return (
                <li key={`a-${i}`}>
                  <form action={it.action}>
                    <button
                      type="submit"
                      className={`w-full text-start flex items-center gap-2.5 px-4 py-2 text-body hover:bg-ink-50 transition-colors ${
                        it.danger ? "text-signal-fail" : "text-ink-700 hover:text-ink-900"
                      }`}
                    >
                      {it.icon ? <Icon name={it.icon} size={14} className="text-ink-500" /> : null}
                      <span>{it.label}</span>
                    </button>
                  </form>
                </li>
              );
            }
            return (
              <li key={it.href}>
                <Link
                  href={it.href}
                  className={`flex items-center gap-2.5 px-4 py-2 text-body hover:bg-ink-50 transition-colors ${
                    it.danger ? "text-signal-fail" : "text-ink-700 hover:text-ink-900"
                  }`}
                >
                  {it.icon ? <Icon name={it.icon} size={14} className="text-ink-500" /> : null}
                  <span>{it.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </details>
  );
}
