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
import { FileDigest, type FileDigestProps } from "./directives/FileDigest";
import {
  ImportReview,
  type ImportReviewProps,
} from "./directives/ImportReview";
import {
  ConfirmImport,
  type ConfirmImportProps,
} from "./directives/ConfirmImport";

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
  onConfirmedOutcome,
}: {
  directive: AnyDirective;
  fmt: FormatContext;
  onConfirmedOutcome?: (outcome: {
    summary: string;
    isError: boolean;
  }) => void;
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
          onConfirmedOutcome={onConfirmedOutcome}
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
    case "file_digest":
      // P6 — emitted by `summarize_file`. Widget-only kind; no
      // directive twin. Lives in the `secondary` slot on the
      // workspace dashboard.
      return (
        <FileDigest
          props={directive.props as unknown as FileDigestProps}
          fmt={fmt}
        />
      );
    case "import_review":
      // P6 — emitted by `review_file_import`. Widget-only kind.
      // Lives in the `primary` slot — an import review is the main
      // subject during an import flow, and P7's commit widget will
      // supersede it in the same slot.
      return (
        <ImportReview
          props={directive.props as unknown as ImportReviewProps}
          fmt={fmt}
        />
      );
    case "confirm_import":
      // P7 — emitted by `propose_import`. Action-slot widget that
      // morphs through `ready` / `blocked` / `submitting` / `done` /
      // `error` around a POST to `/api/chat/confirm/<messageId>`
      // (which re-dispatches `commit_import` with
      // `allowDestructive: true`). No directive twin — the persisted
      // widget is the single source of truth for the confirm flow.
      return (
        <ConfirmImport
          props={directive.props as unknown as ConfirmImportProps}
          fmt={fmt}
          messageId={directive.messageId}
          onConfirmedOutcome={onConfirmedOutcome}
        />
      );
    default:
      // Silent drop — unknown kind from an older client talking to a
      // newer server (or the reverse). The assistant text still
      // carries the meaning; we just don't render the widget.
      return null;
  }
}
