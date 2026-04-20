"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Icon } from "@/components/Icon";
import { formatRelativeTime } from "./formatRelativeTime";
import type { SessionListItem } from "@/app/api/chat/sessions/handler";
import type { FormatContext } from "./directives/CampaignList";

// P4-B session picker. Lives in the ChatRail header.
//
// Trigger: a ghost button showing the CURRENT session's title (or a
// "new workspace" label when the workspace is in a fresh state), plus
// a chevron. Clicking it opens a dropdown with:
//   - "New workspace" item (dispatches onPick(null))
//   - A separator
//   - One row per recent session, ordered newest-first, each row
//     showing title (or preview fallback), optional preview subtitle,
//     and a relative-time stamp.
//
// Why a local popover instead of the shared <Menu> component:
//   Menu closes only on outside-click or Escape — a click on a
//   MenuItem keeps the popover open (which is right for "open in new
//   tab"-style menus). For a picker, clicking a row MUST close the
//   popover immediately so the operator sees the transcript start
//   hydrating. The local popover owns `open` state, so the row
//   handler can call `setOpen(false)` and `onPick()` atomically.
//
// Keyboard: Escape closes. Click-outside closes. Within the dropdown
// itself rows are native <button>s so Tab traversal and Enter-to-
// activate come for free from the browser — no roving tabindex.
//
// `now` is an optional injectable clock: the tests pass a fixed Date;
// production callers omit it and get `new Date()` per render. We do
// NOT memoize the `new Date()` — the picker opens briefly (seconds),
// and re-creating the date on the rare re-render is cheaper than the
// surprise of stale relative-time labels when the user lingers on
// the dropdown.

export function SessionPicker({
  sessions,
  currentSessionId,
  currentTitle,
  onPick,
  fmt,
  now,
}: {
  sessions: SessionListItem[];
  currentSessionId: string | null;
  currentTitle: string | null;
  onPick: (id: string | null) => void;
  fmt: FormatContext;
  now?: Date;
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

  const displayNow = now ?? new Date();

  const newLabel = fmt.locale === "ar" ? "محادثة جديدة" : "New workspace";
  const emptyLabel =
    fmt.locale === "ar" ? "لا توجد محادثات حديثة" : "No recent workspaces";
  const triggerAria =
    fmt.locale === "ar" ? "تبديل المحادثة" : "Switch workspace";

  // Trigger label preference: current title → "new workspace" filler.
  // We specifically DO NOT fall back to the preview here — a
  // mid-ask session with no title yet reads better as "New
  // workspace" in the trigger than as a truncated first sentence.
  const triggerLabel =
    currentTitle && currentTitle.length > 0 ? currentTitle : newLabel;

  const handlePick = (id: string | null) => {
    setOpen(false);
    onPick(id);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerAria}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-slate-700 hover:bg-slate-100"
      >
        <Icon name="message" size={14} className="text-slate-500" />
        <span className="max-w-[220px] truncate">{triggerLabel}</span>
        <Icon name="chevron-down" size={14} className="text-slate-400" />
      </button>

      <div
        role="menu"
        aria-hidden={!open}
        className={clsx(
          "absolute top-[calc(100%+6px)] start-0 z-30 min-w-[18rem] max-w-[22rem] rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg",
          "origin-top transition-all duration-150",
          open
            ? "opacity-100 scale-100 pointer-events-auto"
            : "opacity-0 scale-95 pointer-events-none",
        )}
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => handlePick(null)}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 hover:text-slate-900"
        >
          <Icon name="plus" size={14} />
          <span>{newLabel}</span>
        </button>

        {sessions.length > 0 ? (
          <>
            <div role="separator" className="my-1 h-px bg-slate-100" />
            <div className="max-h-[60vh] overflow-y-auto">
              {sessions.map((s) => {
                const active = s.id === currentSessionId;
                const primary =
                  s.title && s.title.length > 0
                    ? s.title
                    : s.preview && s.preview.length > 0
                      ? s.preview
                      : newLabel;
                const showPreviewLine = Boolean(
                  s.title && s.title.length > 0 && s.preview,
                );
                return (
                  <button
                    key={s.id}
                    type="button"
                    role="menuitem"
                    onClick={() => handlePick(s.id)}
                    className={clsx(
                      "flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-start",
                      active
                        ? "bg-slate-100 text-slate-900"
                        : "text-slate-700 hover:bg-slate-50 hover:text-slate-900",
                    )}
                  >
                    <div className="flex w-full items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {primary}
                      </span>
                      <span className="shrink-0 text-[11px] text-slate-400 tabular-nums">
                        {formatRelativeTime(s.updatedAt, {
                          now: displayNow,
                          locale: fmt.locale,
                        })}
                      </span>
                    </div>
                    {showPreviewLine && (
                      <span className="max-w-full truncate text-xs text-slate-500">
                        {s.preview}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <div className="px-3 py-4 text-center text-xs text-slate-400">
            {emptyLabel}
          </div>
        )}
      </div>
    </div>
  );
}
