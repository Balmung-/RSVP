"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { ClientWidget, FocusRequest, Phase } from "./types";
import type { FormatContext } from "./directives/CampaignList";
import { WidgetRenderer } from "./WidgetRenderer";

// The workspace dashboard — the right half of the split /chat page.
// Groups widgets by slot (summary / primary / secondary / action),
// orders within each slot by `order` then `updatedAt`, and renders
// them via the shared WidgetRenderer.
//
// W2 state: no tool emits widgets yet, so the dashboard is almost
// always empty. That's by design — the acceptance criterion is the
// DATA PATH (reload recovers state), not full visual parity with
// the transcript cards. W3 migrates the six tool handlers onto
// upsertWidget and the dashboard fills in without any further
// change to this component.
//
// Layout notes:
//   - `summary` is a thin strip at the top of the dashboard —
//     counters and at-a-glance facts. Small card heights, can hold
//     multiple widgets side-by-side.
//   - `primary` is the main content area — one card typically fills
//     the width, multiple cards stack.
//   - `secondary` sits below primary as the supporting detail panel
//     (activity streams, sub-tables).
//   - `action` is a sticky bottom band for confirm / send flows so
//     the operator's decision buttons stay in view while they read
//     the primary card.
//
// The placeholder copy on empty slots is intentionally quiet. A
// loud "No widgets yet" banner on every slot would clutter the
// screen and fight the transcript for attention. We show ONE
// unified empty state only when the whole dashboard is empty.

const SLOT_ORDER: ReadonlyArray<ClientWidget["slot"]> = [
  "summary",
  "primary",
  "secondary",
  "action",
];

const FLASH_MS = 1200;

export function WorkspaceDashboard({
  widgets,
  fmt,
  phase,
  focusRequest,
  onDismissWidget,
}: {
  widgets: ClientWidget[];
  fmt: FormatContext;
  phase: Phase;
  focusRequest: FocusRequest | null;
  // W7 — terminal confirm widgets get a small ✕ button when this
  // callback is provided. The dashboard itself doesn't know which
  // widgets are dismissable; WidgetRenderer consults the shared
  // `isTerminalConfirmWidget` gate so the button only appears on
  // the kinds + states the server will agree to delete.
  onDismissWidget?: (widgetKey: string) => void;
}) {
  // W4 focus plumbing. Each rendered widget registers its DOM node
  // via a ref-callback keyed by widgetKey. When `focusRequest`
  // changes (seq bumps per emit), we scroll the matching node into
  // view and flash a ring for FLASH_MS to call attention. The
  // ring is driven by state (not a CSS animation class) so repeat
  // focus on the same key re-applies without needing a DOM remount
  // trick.
  const widgetRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const [flashedKey, setFlashedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!focusRequest) return;
    const el = widgetRefs.current.get(focusRequest.widgetKey);
    if (!el) return;
    // `block: "center"` pulls the card into the middle of the
    // viewport rather than sticking it to the top or bottom edge.
    // Supported in all Evergreen browsers the admin console
    // targets.
    //
    // W7 — honour `prefers-reduced-motion`. Operators who've set
    // the OS-level motion-reduction flag (vestibular sensitivity,
    // screen readers that piggy-back on it) see an instant jump
    // instead of a smooth scroll. Same accessibility pattern the
    // rest of the app uses for motion; the `matchMedia` check is
    // wrapped because SSR / older browsers that lack the API
    // should still get a scroll (defaulting to smooth keeps the
    // existing experience when the query can't be evaluated).
    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({
      block: "center",
      behavior: reduceMotion ? "auto" : "smooth",
    });
    setFlashedKey(focusRequest.widgetKey);
    const timer = window.setTimeout(() => {
      setFlashedKey((current) =>
        current === focusRequest.widgetKey ? null : current,
      );
    }, FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [focusRequest]);

  // Group + sort. Stable: same input always produces the same
  // ordering, so React can reconcile on widgetKey without reshuffles.
  const bySlot = useMemo(() => {
    const map = new Map<ClientWidget["slot"], ClientWidget[]>();
    for (const slot of SLOT_ORDER) map.set(slot, []);
    for (const w of widgets) {
      const arr = map.get(w.slot);
      if (arr) arr.push(w);
    }
    for (const slot of SLOT_ORDER) {
      const arr = map.get(slot);
      if (!arr) continue;
      arr.sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        // Tiebreaker: newest-updated first WITHIN a slot. Matches
        // the operator expectation that a "refresh" action bumps a
        // card to the top of its slot.
        return b.updatedAt.localeCompare(a.updatedAt);
      });
    }
    return map;
  }, [widgets]);

  const isEmpty = widgets.length === 0;

  return (
    <div
      className="flex flex-col h-full min-w-0 overflow-y-auto"
      aria-label={fmt.locale === "ar" ? "لوحة العمل" : "Workspace"}
    >
      {phase === "hydrating" && (
        // Light overlay during the initial hydrate fetch. Kept as
        // part of the dashboard (not a page-level overlay) so the
        // chat rail stays interactive for a user who's typing
        // before the dashboard finishes loading.
        <div className="px-4 py-2 text-mini text-ink-400 border-b border-ink-100">
          {fmt.locale === "ar" ? "جاري تحميل اللوحة…" : "Loading workspace…"}
        </div>
      )}

      {isEmpty && phase !== "hydrating" ? (
        <EmptyDashboard locale={fmt.locale} />
      ) : (
        <div className="flex-1 px-4 py-4 space-y-4">
          {SLOT_ORDER.map((slot) => {
            const items = bySlot.get(slot) ?? [];
            if (items.length === 0) return null;
            return (
              <SlotSection key={slot} slot={slot} locale={fmt.locale}>
                {items.map((w) => (
                  <div
                    key={w.widgetKey}
                    ref={(el) => {
                      if (el) widgetRefs.current.set(w.widgetKey, el);
                      else widgetRefs.current.delete(w.widgetKey);
                    }}
                    // `relative` so the dismiss button can absolute-
                    // position itself in WidgetRenderer without
                    // leaking its positioning concern into every
                    // DirectiveRenderer kind.
                    className={clsx(
                      "relative min-w-0 rounded-xl transition-shadow duration-500 ease-glide",
                      flashedKey === w.widgetKey &&
                        "ring-2 ring-ink-300 shadow-lift",
                    )}
                  >
                    <WidgetRenderer
                      widget={w}
                      fmt={fmt}
                      onDismiss={onDismissWidget}
                      locale={fmt.locale}
                    />
                  </div>
                ))}
              </SlotSection>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SlotSection({
  slot,
  locale,
  children,
}: {
  slot: ClientWidget["slot"];
  locale: "en" | "ar";
  children: React.ReactNode;
}) {
  // Slot headers are deliberately faint. The OPERATOR's attention
  // belongs on the widgets, not on our internal taxonomy — but the
  // label is there so a busy dashboard is still skimmable.
  const label = slotLabel(slot, locale);
  return (
    <section
      className={clsx(
        "space-y-2",
        // action slot visually separated: darker divider + sticky
        // positioning is applied in the parent when we need it.
        slot === "action" && "pt-2 border-t border-ink-100",
      )}
    >
      <div className="text-mini uppercase tracking-wide text-ink-400 px-1">
        {label}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function slotLabel(slot: ClientWidget["slot"], locale: "en" | "ar"): string {
  if (locale === "ar") {
    switch (slot) {
      case "summary":
        return "ملخص";
      case "primary":
        return "رئيسي";
      case "secondary":
        return "تفاصيل";
      case "action":
        return "إجراء";
    }
  }
  switch (slot) {
    case "summary":
      return "Summary";
    case "primary":
      return "Primary";
    case "secondary":
      return "Details";
    case "action":
      return "Action";
  }
}

function EmptyDashboard({ locale }: { locale: "en" | "ar" }) {
  return (
    <div className="flex-1 grid place-items-center px-6 text-center">
      <div className="max-w-sm space-y-2">
        <div className="text-body text-ink-500">
          {locale === "ar"
            ? "ستظهر اللوحة هنا"
            : "Your workspace appears here"}
        </div>
        <div className="text-mini text-ink-400">
          {locale === "ar"
            ? "اطلب حملة أو جهة اتصال أو نشاطًا حديثًا، وستملأ البطاقات هذه المساحة. تظل المحادثة إلى اليسار."
            : "Ask about a campaign, contact, or recent activity and cards will fill this space. The conversation stays on the left."}
        </div>
      </div>
    </div>
  );
}
