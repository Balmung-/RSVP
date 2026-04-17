import type { ReactNode } from "react";
import clsx from "clsx";
import { DrawerDismiss } from "./DrawerDismiss";

// URL-driven right drawer. A tiny client sibling handles the a11y contract:
// scrim click + Escape both navigate to `closeHref`. Everything else is
// server-rendered — no animation library, no hydration for the content.

export function Drawer({
  title,
  crumb,
  closeHref,
  size = "md",
  children,
  footer,
}: {
  title: string;
  crumb?: ReactNode;
  closeHref: string;
  size?: "sm" | "md" | "lg";
  children: ReactNode;
  footer?: ReactNode;
}) {
  const width = size === "sm" ? "max-w-md" : size === "lg" ? "max-w-3xl" : "max-w-xl";
  return (
    <>
      <DrawerDismiss closeHref={closeHref} />
      <aside
        className={clsx(
          "fixed inset-y-0 right-0 z-50 w-full bg-ink-0 shadow-lift flex flex-col",
          width,
        )}
        role="dialog"
        aria-modal="true"
      >
        <header className="flex items-center justify-between px-8 py-6 border-b border-ink-200">
          <div className="min-w-0 pr-4">
            <h2 className="text-sm font-medium tracking-tight text-ink-900 truncate">{title}</h2>
            {crumb ? <div className="text-xs text-ink-400 mt-0.5 truncate">{crumb}</div> : null}
          </div>
          <DrawerDismiss closeHref={closeHref} asCloseButton />
        </header>
        <div className="flex-1 overflow-auto px-8 py-6">{children}</div>
        {footer ? (
          <footer className="border-t border-ink-200 px-8 py-4 bg-ink-50/50">{footer}</footer>
        ) : null}
      </aside>
    </>
  );
}
