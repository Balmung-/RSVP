// Shared types for the /chat client components.
//
// Extracted from the old single-file ChatPanel so the split W2
// components — ChatWorkspace (state owner), ChatRail (transcript +
// composer), WorkspaceDashboard (widget grid), WidgetRenderer —
// can share the turn / block / widget shapes without cyclic
// imports or duplicated type defs.
//
// The `AnyDirective` type stays in DirectiveRenderer.tsx because
// it's the renderer's public contract; we re-export it from there
// if anyone outside this module needs it.

import type { AnyDirective } from "./DirectiveRenderer";

// ---- turn / block shapes ----
//
// `turns` is append-only in general, with one exception: the
// IN-PROGRESS assistant turn (always the last element) is mutated
// as SSE deltas arrive. Mirrors the data flow in the route — user
// row -> assistant row -> 0+ tool rows -> next user row.

export type UserTurn = { kind: "user"; id: string; text: string };

export type AssistantBlock =
  | { type: "text"; text: string }
  | {
      type: "tool";
      name: string;
      status: "running" | "ok" | "error";
      error?: string;
    }
  | { type: "directive"; payload: AnyDirective };

export type AssistantTurn = {
  kind: "assistant";
  id: string;
  blocks: AssistantBlock[];
  streaming: boolean;
  error?: string;
};

export type Turn = UserTurn | AssistantTurn;

// Phase covers the full in-flight window from the FIRST mount
// through every message. `hydrating` is the W2 initial-load state
// while we fetch a persisted session's transcript + widget snapshot
// via GET /api/chat/session/[id]. `streaming` covers the SSE POST
// window. `idle` is "ready for next input".
export type Phase = "idle" | "hydrating" | "streaming";

// ---- widget shape ----
//
// Mirrors the server `Widget` type from `src/lib/ai/widgets.ts` —
// duplicated here so the client doesn't transitively import
// Prisma-typed modules. The SSE event for `workspace_snapshot` /
// `widget_upsert` emits exactly this shape.

export type ClientWidget = {
  widgetKey: string;
  kind: string;
  slot: "summary" | "primary" | "secondary" | "action";
  props: Record<string, unknown>;
  order: number;
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
};
