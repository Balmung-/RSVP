"use client";

import { useMemo } from "react";
import clsx from "clsx";
import type { ClientWidget, Phase } from "./types";
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

export function WorkspaceDashboard({
  widgets,
  fmt,
  phase,
}: {
  widgets: ClientWidget[];
  fmt: FormatContext;
  phase: Phase;
}) {
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
                  <div key={w.widgetKey} className="min-w-0">
                    <WidgetRenderer widget={w} fmt={fmt} />
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
