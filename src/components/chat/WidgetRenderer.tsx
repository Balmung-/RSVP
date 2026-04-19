"use client";

import { DirectiveRenderer, type AnyDirective } from "./DirectiveRenderer";
import type { ClientWidget } from "./types";
import type { FormatContext } from "./directives/CampaignList";

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

export function WidgetRenderer({
  widget,
  fmt,
}: {
  widget: ClientWidget;
  fmt: FormatContext;
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
  return <DirectiveRenderer directive={directive} fmt={fmt} />;
}
