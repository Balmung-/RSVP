"use client";

import { DirectiveRenderer, type AnyDirective } from "./DirectiveRenderer";
import type { ClientWidget } from "./types";
import type { FormatContext } from "./directives/CampaignList";
import {
  isTerminalConfirmWidget,
  type WidgetKind,
} from "@/lib/ai/widget-validate";
import { getNextAction } from "@/lib/ai/next-action-prompts";
import { NextActionChip } from "./NextActionChip";

// Workspace widget renderer. Thin shim over `DirectiveRenderer` for
// W2 — the six widget kinds (campaign_list, campaign_card,
// contact_table, activity_stream, confirm_draft, confirm_send)
// share their prop shapes 1:1 with the directive kinds, so forking
// the renderer would duplicate the five render components without
// adding a bit of value. W3 is where the tools actually start
// emitting widgets; if the registries need to diverge at that point
// we split this shim into its own closed-registry switch.
//
// Why a shim at all, instead of using DirectiveRenderer in the
// dashboard directly:
//   - The dashboard consumes `widgetKey` for stable React keys,
//     not the arbitrary index DirectiveRenderer ships behind.
//   - A widget's `sourceMessageId` feeds ConfirmSend's POST anchor
//     the same way `messageId` does in the directive path — we map
//     it here so the confirm surfaces still work when they move
//     onto the dashboard in W3.
//   - Future widget-only concerns (focus highlight, drag reorder,
//     inline actions) land here without touching the live
//     transcript path.
//
// W7 — operator dismiss for terminal confirm widgets. The button is
// rendered by THIS component (not inside ConfirmDraft / ConfirmSend)
// so the dismiss affordance lives on the workspace side of the
// widget/directive seam — the live directive-streaming path shares
// those components and must not sprout an X the transcript can
// click. The gate (`isTerminalConfirmWidget`) mirrors the server
// check in the dismiss route so a visible ✕ is exactly a widget
// the server will agree to delete.

export function WidgetRenderer({
  widget,
  fmt,
  onDismiss,
  locale,
}: {
  widget: ClientWidget;
  fmt: FormatContext;
  onDismiss?: (widgetKey: string) => void;
  locale?: "en" | "ar";
}) {
  // Translate the widget envelope into the directive envelope
  // DirectiveRenderer expects. `sourceMessageId` carries the same
  // semantics as the live stream's `messageId` (the ChatMessage
  // row id for confirm round-trips), so map it through.
  const directive: AnyDirective = {
    kind: widget.kind,
    props: widget.props,
  };
  if (widget.sourceMessageId) {
    directive.messageId = widget.sourceMessageId;
  }

  const showDismiss =
    typeof onDismiss === "function" &&
    isTerminalConfirmWidget(widget.kind, widget.props);

  // P8-B — compute the "seed next action" chip. The resolver
  // returns null for action/summary kinds and for kinds with no
  // meaningful follow-up, so this is effectively a no-op on any
  // widget without a registered prompt. The cast from `string` to
  // `WidgetKind` is safe here: every widget returned by the DB
  // layer went through `validateWidget`, which enforces
  // `widget.kind ∈ WIDGET_KINDS`.
  const nextAction = getNextAction(
    { kind: widget.kind as WidgetKind, props: widget.props },
    locale === "ar" ? "ar" : "en",
  );

  return (
    <>
      <DirectiveRenderer directive={directive} fmt={fmt} />
      {showDismiss && (
        <button
          type="button"
          onClick={() => onDismiss(widget.widgetKey)}
          // Absolute within the parent dashboard wrapper (which
          // sets `relative`). Top-right so it doesn't collide with
          // the emerald "Draft created" / "Sent" header bar on
          // either confirm widget. Small, subdued until hover —
          // the confirm card is the primary surface, dismiss is a
          // secondary action.
          className="absolute top-2 right-2 rounded-md px-1.5 py-0.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-300"
          aria-label={
            locale === "ar"
              ? "إزالة البطاقة من لوحة العمل"
              : "Dismiss from workspace"
          }
          title={locale === "ar" ? "إزالة" : "Dismiss"}
        >
          {/* Heavy multiplication sign (×, U+00D7) — renders
              crisper than the lowercase "x" at small sizes and
              doesn't need an icon font. */}
          <span aria-hidden className="text-sm leading-none">
            ×
          </span>
        </button>
      )}
      {nextAction && (
        // Chip renders BELOW the directive card, inside the same
        // dashboard wrapper so the `rounded-xl` focus-ring hugs
        // both. Right-aligned so it reads as a subtle follow-up
        // affordance rather than a primary action.
        <div className="pt-2 flex justify-end">
          <NextActionChip
            label={nextAction.label}
            prompt={nextAction.prompt}
            locale={locale === "ar" ? "ar" : "en"}
          />
        </div>
      )}
    </>
  );
}
