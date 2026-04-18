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

// The CLOSED render registry. Maps `kind` -> component. Unknown kinds
// render nothing (silent drop) — matches the trust model: the model
// can only surface UI we've explicitly whitelisted. Never add an
// escape hatch that accepts arbitrary HTML or dynamic imports here.
//
// When adding a new kind:
//   1. Put the component in ./directives/<Name>.tsx
//   2. Import it below and add a case in the switch.
//   3. Update the matching tool handler to emit that `kind` + `props`.
//   4. Re-validate the payload shape server-side before persistence
//      (see Push 1 notes: server-side validate-per-kind is still a
//      TODO; directives written to DB are currently validated only
//      by the handler that produced them).

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
    default:
      // Silent drop — unknown kind from an older client talking to a
      // newer server (or the reverse). The assistant text still
      // carries the meaning; we just don't render the widget.
      return null;
  }
}
