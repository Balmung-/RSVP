"use client";

import {
  CampaignList,
  type CampaignListProps,
  type FormatContext,
} from "./directives/CampaignList";
import { CampaignCard, type CampaignCardProps } from "./directives/CampaignCard";
import { ContactTable, type ContactTableProps } from "./directives/ContactTable";
import {
  ActivityStream,
  type ActivityStreamProps,
} from "./directives/ActivityStream";
import {
  ConfirmDraft,
  type ConfirmDraftProps,
} from "./directives/ConfirmDraft";
import {
  ConfirmSend,
  type ConfirmSendProps,
} from "./directives/ConfirmSend";
import {
  WorkspaceRollup,
  type WorkspaceRollupProps,
} from "./directives/WorkspaceRollup";

// The CLOSED render registry. Maps `kind` -> component. Unknown kinds
// render nothing (silent drop) — matches the trust model: the model
// can only surface UI we've explicitly whitelisted. Never add an
// escape hatch that accepts arbitrary HTML or dynamic imports here.
//
// When adding a new kind:
//   1. Put the component in ./directives/<Name>.tsx
//   2. Import it below and add a case in the switch.
//   3. Update the matching tool handler to emit that `kind` + `props`.
//   4. Add a per-kind validator in `src/lib/ai/directive-validate.ts`
//      (matching the tool's emitted shape and this renderer's Props
//      type) and cover it in `tests/unit/directive-validate.test.ts`.
//      The chat route runs that validator BEFORE persisting or
//      streaming — a missed case silently drops the card, which
//      is louder in dev (console.warn) than a half-drawn widget.

export type AnyDirective = {
  kind: string;
  props: Record<string, unknown>;
  // The ChatMessage row id this directive was persisted under. The
  // chat route threads it into the SSE envelope (Push 7) so that
  // confirmation directives like ConfirmSend know which row to POST
  // against when the operator clicks. Optional because directives
  // stored pre-Push 7 (or re-hydrated from paths that don't carry it)
  // won't have one — consuming components must tolerate absence and
  // disable their confirm CTA rather than hard-fail.
  messageId?: string;
};

export function DirectiveRenderer({
  directive,
  fmt,
}: {
  directive: AnyDirective;
  fmt: FormatContext;
}) {
  switch (directive.kind) {
    case "campaign_list":
      // We cast once here at the registry boundary. The handler
      // controls the shape; if a future refactor changes the
      // directive payload, TypeScript will catch the miss at the
      // producer site (tool handler) rather than here.
      return (
        <CampaignList
          props={directive.props as unknown as CampaignListProps}
          fmt={fmt}
        />
      );
    case "campaign_card":
      return (
        <CampaignCard
          props={directive.props as unknown as CampaignCardProps}
          fmt={fmt}
        />
      );
    case "contact_table":
      return (
        <ContactTable
          props={directive.props as unknown as ContactTableProps}
        />
      );
    case "activity_stream":
      return (
        <ActivityStream
          props={directive.props as unknown as ActivityStreamProps}
          fmt={fmt}
        />
      );
    case "confirm_draft":
      return (
        <ConfirmDraft
          props={directive.props as unknown as ConfirmDraftProps}
          fmt={fmt}
        />
      );
    case "confirm_send":
      return (
        <ConfirmSend
          props={directive.props as unknown as ConfirmSendProps}
          fmt={fmt}
          messageId={directive.messageId}
        />
      );
    case "workspace_rollup":
      // W7 — server-owned summary widget. The directive-renderer
      // registry accepts it so WidgetRenderer (which thin-shims over
      // this component for the dashboard) can render it from the
      // workspace emitter's upsert path. No tool produces this kind,
      // so the live transcript never renders a workspace_rollup —
      // this case exists purely for the workspace dashboard's
      // persisted-state path.
      return (
        <WorkspaceRollup
          props={directive.props as unknown as WorkspaceRollupProps}
          fmt={fmt}
        />
      );
    default:
      // Silent drop — unknown kind from an older client talking to a
      // newer server (or the reverse). The assistant text still
      // carries the meaning; we just don't render the widget.
      return null;
  }
}
