"use client";

import { useEffect, useRef, type ReactNode } from "react";
import clsx from "clsx";
import { Icon } from "./Icon";

// A primitive modal dialog. Client-only; native <dialog> element gives
// proper focus trap + Esc handling for free.

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    function onCancel(e: Event) {
      e.preventDefault();
      onClose();
    }
    d.addEventListener("cancel", onCancel);
    return () => d.removeEventListener("cancel", onCancel);
  }, [onClose]);

  const width = size === "sm" ? "max-w-sm" : size === "lg" ? "max-w-2xl" : "max-w-md";

  return (
    <dialog
      ref={ref}
      className={clsx(
        "rounded-2xl p-0 bg-ink-0 shadow-float backdrop:bg-ink-900/30 backdrop:backdrop-blur-[2px]",
        "w-full", width,
        "animate-modal-in",
      )}
      onClick={(e) => {
        // Click on backdrop (the dialog element itself, outside content) closes.
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="flex flex-col">
        <header className="flex items-start justify-between gap-4 px-6 pt-6">
          <div className="min-w-0">
            <h2 className="text-sub text-ink-900">{title}</h2>
            {description ? (
              <div className="text-body text-ink-500 mt-1">{description}</div>
            ) : null}
          </div>
          <button
            onClick={onClose}
            className="btn btn-ghost btn-icon -mt-1 -me-2"
            aria-label="Close"
            type="button"
          >
            <Icon name="x" size={16} />
          </button>
        </header>
        {children ? <div className="px-6 py-5 text-body text-ink-700">{children}</div> : <div className="h-2" />}
        {footer ? (
          <footer className="flex items-center justify-end gap-2 border-t border-ink-100 px-6 py-4 bg-ink-50/60 rounded-b-2xl">
            {footer}
          </footer>
        ) : null}
      </div>
    </dialog>
  );
}
