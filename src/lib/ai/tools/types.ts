import type { Prisma } from "@prisma/client";
import type { AuthUser } from "@/lib/auth";
import type { WidgetKind, WidgetSlot } from "../widget-validate";

// Contracts for the AI tool registry. Every capability the chat layer
// can invoke is a ToolDef: a declarative description + a handler that
// runs under a ToolCtx. The ToolCtx is built once per chat request and
// carries the resolved identity + team scope — handlers must NEVER
// re-derive scope from the model's output or from raw request fields.
//
// The JSON Schema attached to each tool is the same object we send to
// Anthropic as `input_schema` on the tool-use API. Hand-written to
// avoid pulling in zod for now; a tool may optionally supply a
// post-parse `validate()` for sharper guarantees.

export type ToolScope = "read" | "write" | "destructive";

// The request-scoped context every handler receives. Built in
// src/lib/ai/ctx.ts from the authenticated session; no handler should
// call getCurrentUser() directly — use ctx.user.
//
// IMPORTANT — scope composition rule. `campaignScope` is
// `Prisma.CampaignWhereInput` and may itself contain top-level
// boolean keys (`OR` for the non-admin team filter). NEVER compose
// it into a handler's `where` by object-spreading (`{...campaignScope,
// OR: [...]}`) — a second top-level `OR` on the spread target will
// silently clobber the first and drop team scoping. Always compose
// with an AND array: `{ AND: [campaignScope, otherClause, ...] }`.
// See the Push 2 audit in `Agent chat.md` for the concrete leak we
// caught with this mistake.
export type ToolCtx = {
  user: AuthUser;
  isAdmin: boolean;
  locale: "en" | "ar";
  // Composable prisma WHERE fragment from scopedCampaignWhere().
  // `{}` for admins (no restriction); an OR-filter for editors/viewers.
  campaignScope: Prisma.CampaignWhereInput;
};

// A typed render directive. The client matches `kind` against a fixed
// component registry; unknown kinds are dropped silently. `props` is
// the data payload — it MUST be JSON-serializable, and the server
// validates its shape per-kind before persisting.
//
// DEPRECATED for the 6 shipped kinds as of W3 — handlers now emit
// `widget` instead, which upserts into the persistent ChatWidget
// table and lands on the workspace dashboard rather than disappearing
// inline in the transcript. The field stays on `ToolResult` so a
// future tool (outside the shipped six) can still use the transient
// transcript-only render path without bringing up a new surface.
export type RenderDirective = {
  kind: string;
  props: Record<string, unknown>;
};

// A workspace widget emission. Replaces directives for the six kinds
// the dashboard renders. The chat route calls `workspace.upsert(...)`
// with this payload after persisting the tool row, threading
// `sourceMessageId` from the ChatMessage row id so ConfirmSend's POST
// anchor still resolves (same contract the old directive path used
// via `messageId`).
//
// `kind` and `slot` are typed against the closed widget registry so
// the compiler catches drift between handlers, the validator, and the
// dashboard renderer. Props shape is validated at runtime by
// `validateWidget` — a malformed widget is dropped silently (null
// return from `upsertWidget`) and logged server-side.
export type ToolWidget = {
  widgetKey: string;
  kind: WidgetKind;
  slot: WidgetSlot;
  props: Record<string, unknown>;
  order?: number;
};

// What a handler returns. `output` is what we feed back to the model
// as the tool_result (string, or JSON we'll stringify). `directive`
// is the legacy transient-render path (see comment on RenderDirective);
// `widget` is the W3 persistent-workspace path — emit at most one of
// the two per call. Both can also be omitted (the handler's text
// output is enough on its own).
export type ToolResult = {
  output: string | Record<string, unknown>;
  directive?: RenderDirective;
  widget?: ToolWidget;
};

// Minimal JSON Schema typing — we don't need full draft-07 support,
// just enough to describe tool inputs and forward them to Anthropic.
export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
};

export type ToolDef<Input = Record<string, unknown>> = {
  name: string;
  description: string;
  scope: ToolScope;
  inputSchema: JsonSchema;
  // Optional runtime guard. Scaffold does a shallow "is this an object"
  // check; a tool can tighten it. Return a concrete Input or throw.
  validate?: (raw: unknown) => Input;
  handler: (input: Input, ctx: ToolCtx) => Promise<ToolResult>;
};

// What dispatch() returns. Keeping `ok` explicit lets the caller
// branch without wrapping every call in try/catch — errors are
// surfaced as tool_result content so the model can recover.
export type DispatchResult =
  | { ok: true; result: ToolResult }
  | { ok: false; error: string };
