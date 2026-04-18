"use client";

import {
  CampaignList,
  type CampaignListProps,
  type FormatContext,
} from "./directives/CampaignList";

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
    default:
      // Silent drop — unknown kind from an older client talking to a
      // newer server (or the reverse). The assistant text still
      // carries the meaning; we just don't render the widget.
      return null;
  }
}
