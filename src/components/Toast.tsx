"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { Icon, type IconName } from "./Icon";
import type { Flash } from "@/lib/flash";

const iconFor: Record<Flash["kind"], IconName> = {
  success: "circle-check",
  info: "info",
  warn: "circle-alert",
  error: "circle-alert",
};

const toneFor: Record<Flash["kind"], string> = {
  success: "text-signal-live",
  info: "text-signal-info",
  warn: "text-signal-hold",
  error: "text-signal-fail",
};

export function Toast({ flash }: { flash: Flash }) {
  const [shown, setShown] = useState(true);

  useEffect(() => {
    void fetch("/api/flash", { method: "POST" }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const ms = flash.kind === "error" ? 8000 : 4500;
    const id = setTimeout(() => setShown(false), ms);
    return () => clearTimeout(id);
  }, [flash.kind]);

  if (!shown) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] animate-toast-in"
    >
      <div className="flex items-start gap-3 rounded-xl bg-ink-900 text-ink-0 px-4 py-3 shadow-float max-w-md">
        <Icon name={iconFor[flash.kind]} size={16} className={clsx("mt-0.5", toneFor[flash.kind])} />
        <div className="flex-1 min-w-0">
          <div className="text-body">{flash.text}</div>
          {flash.detail ? <div className="text-mini text-ink-300 mt-0.5">{flash.detail}</div> : null}
        </div>
        <button
          onClick={() => setShown(false)}
          className="text-ink-300 hover:text-ink-0 transition-colors"
          aria-label="Dismiss"
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    </div>
  );
}
