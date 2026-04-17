"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import clsx from "clsx";

// A quiet popover. Click outside + Escape close it. No animation library;
// a single transform + opacity transition keeps the reveal controlled.
// Items are whatever the caller renders — usually <Link> or <form>.

export function Menu({
  trigger,
  align = "right",
  children,
  label,
}: {
  trigger: ReactNode;
  align?: "right" | "left";
  children: ReactNode;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label ?? "Open menu"}
        onClick={() => setOpen((v) => !v)}
        className="btn-ghost !px-2.5 !py-1.5"
      >
        {trigger}
      </button>
      <div
        role="menu"
        aria-hidden={!open}
        className={clsx(
          "absolute top-[calc(100%+6px)] z-30 min-w-[14rem] rounded-xl border border-ink-200 bg-ink-0 p-1.5 shadow-lift",
          "origin-top transition-all duration-150 ease-glide",
          align === "right" ? "right-0" : "left-0",
          open ? "opacity-100 scale-100 pointer-events-auto" : "opacity-0 scale-95 pointer-events-none",
        )}
      >
        {children}
      </div>
    </div>
  );
}

// Styled row inside a Menu. Works as an <a>, <button>, or form submit.
export function MenuItem({
  children,
  danger,
  as = "link",
  ...rest
}: {
  children: ReactNode;
  danger?: boolean;
  as?: "link" | "button";
} & React.HTMLAttributes<HTMLElement> & { href?: string; target?: string }) {
  const cls = clsx(
    "block rounded-md px-3 py-2 text-sm text-start transition-colors w-full",
    danger
      ? "text-signal-fail hover:bg-signal-fail/5"
      : "text-ink-700 hover:bg-ink-100 hover:text-ink-900",
  );
  if (as === "button") {
    return (
      <button role="menuitem" type="submit" className={cls} {...(rest as React.ButtonHTMLAttributes<HTMLButtonElement>)}>
        {children}
      </button>
    );
  }
  return (
    <a role="menuitem" className={cls} {...(rest as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>
      {children}
    </a>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-ink-100" />;
}
