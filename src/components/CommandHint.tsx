"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icon";

// Mouse-friendly affordance for the command palette. Press ⌘K or click me.
// Sends a synthetic keyboard event so the existing palette handler opens.

export function CommandHint() {
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    setIsMac(navigator.platform?.toLowerCase().includes("mac") ?? false);
  }, []);

  function open() {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      className="hidden md:inline-flex items-center gap-2 rounded-lg border border-ink-200 bg-ink-0 hover:border-ink-300 hover:bg-ink-50 px-3 py-1.5 text-mini text-ink-500 transition-colors"
    >
      <Icon name="search" size={12} />
      <span>Search…</span>
      <span className="inline-flex items-center gap-0.5 ms-2">
        <kbd className="px-1.5 py-0.5 rounded bg-ink-100 text-ink-600 text-[10px] font-mono">
          {isMac ? "⌘" : "Ctrl"}
        </kbd>
        <kbd className="px-1.5 py-0.5 rounded bg-ink-100 text-ink-600 text-[10px] font-mono">K</kbd>
      </span>
    </button>
  );
}
