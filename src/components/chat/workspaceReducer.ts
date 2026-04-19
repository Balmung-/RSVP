// Pure SSE-event reducers for ChatWorkspace state slices.
//
// Extracted from the pre-W6 inline `handleEvent` in ChatWorkspace.tsx
// so the turn/widget/focus state transitions can be unit-tested
// without a React harness. The runtime dispatcher in
// ChatWorkspace.tsx now calls these three functions via functional
// setState — one per slice, no cross-slice invariants.
//
// Why three separate reducers rather than one combined reducer:
// every workspace SSE event touches at most ONE of {turns, widgets,
// focusRequest}. Splitting the reducer along slice boundaries lets
// React bail out of the untouched-slice re-renders (same-reference
// return = no commit) without us having to hand-author a union-of-
// partials update shape. It also keeps the test surface tight —
// each reducer's test file only needs to know about its own slice.
//
// Events NOT handled here:
//   - `session`: has a URL side effect (history.replaceState) so it
//     stays in ChatWorkspace's handleEvent. Nothing to reduce.
//   - Events the SSE producer has never sent: silently ignored (no
//     default-case throw). The dispatcher tolerates unknown kinds
//     because a future server push could add new event names that
//     older clients must survive.
//
// Input validation is defense-in-depth: `reduceWidgets` rejects a
// `widget_upsert` without a `widgetKey` string, `reduceFocusRequest`
// rejects a focus event with no key, etc. These payloads already
// pass server-side validation before emission, but the client never
// trusts stored/streamed JSON blindly — matching the same trust-
// boundary rule the hydrate path (transcript-ui.ts, rowToWidget)
// applies server-side.

import type { AnyDirective } from "./DirectiveRenderer";
import type { ClientWidget, FocusRequest, Turn } from "./types";

export type WorkspaceSseEvent = { event: string; data: string };

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---- widgets slice --------------------------------------------------
//
// The three widget SSE kinds map 1:1:
//   workspace_snapshot -> wholesale replace (authoritative; empty
//     array is a valid "clear the board" signal).
//   widget_upsert      -> find-by-widgetKey; in-place replace or
//     append to the end. Order on append is emission order, which
//     matches the server-side `upsertWidget` return semantics.
//   widget_remove      -> filter out by widgetKey. Unknown key is
//     a silent no-op (client may have missed the upsert).
// All other event kinds return `prev` unchanged — the slice is
// untouched and React bails out of re-rendering.
export function reduceWidgets(
  prev: ClientWidget[],
  ev: WorkspaceSseEvent,
): ClientWidget[] {
  const data = parseJson(ev.data);
  if (ev.event === "workspace_snapshot") {
    const obj = data as { widgets?: ClientWidget[] } | null;
    if (obj && Array.isArray(obj.widgets)) return obj.widgets;
    return prev;
  }
  if (ev.event === "widget_upsert") {
    const widget = data as ClientWidget | null;
    if (!widget || typeof widget.widgetKey !== "string") return prev;
    const idx = prev.findIndex((w) => w.widgetKey === widget.widgetKey);
    if (idx === -1) return [...prev, widget];
    const next = [...prev];
    next[idx] = widget;
    return next;
  }
  if (ev.event === "widget_remove") {
    const obj = data as { widgetKey?: string } | null;
    if (!obj || typeof obj.widgetKey !== "string") return prev;
    const key: string = obj.widgetKey;
    return prev.filter((w) => w.widgetKey !== key);
  }
  return prev;
}

// ---- focusRequest slice ---------------------------------------------
//
// seq monotonically increases so the dashboard effect fires even
// when the same widgetKey focuses twice in a row. Derived from the
// previous focusRequest's seq — no external counter needed. A
// malformed event (missing widgetKey) returns prev unchanged; the
// dashboard would otherwise try to focus a ghost.
export function reduceFocusRequest(
  prev: FocusRequest | null,
  ev: WorkspaceSseEvent,
): FocusRequest | null {
  if (ev.event !== "widget_focus") return prev;
  const obj = parseJson(ev.data) as { widgetKey?: string } | null;
  if (!obj || typeof obj.widgetKey !== "string") return prev;
  const widgetKey: string = obj.widgetKey;
  const nextSeq = (prev?.seq ?? 0) + 1;
  return { widgetKey, seq: nextSeq };
}

// ---- turns slice ----------------------------------------------------
//
// Every turns-mutating event targets the LAST assistant turn (the
// one keyed by `ctx.assistantId`), which the client opens at send
// time. Older turns are immutable. `text` extends the last text
// block in place or opens a new one; `tool` upgrades a running
// pill to its final status (ok/error) or opens a new pill for the
// next tool; `directive` appends a directive block; `error` /
// `done` finalize the streaming flag (error also carries a
// message).
//
// All branches short-circuit to `prev` on malformed payloads, so
// the reducer is safe to call on unknown/drifted SSE frames.
export function reduceTurns(
  prev: Turn[],
  ev: WorkspaceSseEvent,
  ctx: { assistantId: string },
): Turn[] {
  const data = parseJson(ev.data);
  const { assistantId } = ctx;

  if (ev.event === "text") {
    const obj = data as { delta?: string } | null;
    if (!obj || typeof obj.delta !== "string") return prev;
    const delta: string = obj.delta;
    return prev.map((t) => {
      if (t.kind !== "assistant" || t.id !== assistantId) return t;
      const blocks = [...t.blocks];
      const last = blocks[blocks.length - 1];
      if (last && last.type === "text") {
        blocks[blocks.length - 1] = { ...last, text: last.text + delta };
      } else {
        blocks.push({ type: "text", text: delta });
      }
      return { ...t, blocks };
    });
  }

  if (ev.event === "tool") {
    const obj = data as
      | {
          name?: string;
          status?: "running" | "ok" | "error";
          error?: string;
        }
      | null;
    if (!obj || typeof obj.name !== "string" || !obj.status) return prev;
    const toolName: string = obj.name;
    const toolStatus: "running" | "ok" | "error" = obj.status;
    const toolError: string | undefined = obj.error;
    return prev.map((t) => {
      if (t.kind !== "assistant" || t.id !== assistantId) return t;
      const blocks = [...t.blocks];
      const lastIdx = blocks.length - 1;
      const last = blocks[lastIdx];
      if (
        last &&
        last.type === "tool" &&
        last.name === toolName &&
        last.status === "running" &&
        toolStatus !== "running"
      ) {
        blocks[lastIdx] = {
          type: "tool",
          name: toolName,
          status: toolStatus,
          error: toolError,
        };
      } else {
        blocks.push({
          type: "tool",
          name: toolName,
          status: toolStatus,
          error: toolError,
        });
      }
      return { ...t, blocks };
    });
  }

  if (ev.event === "directive") {
    if (!data || typeof data !== "object") return prev;
    const d = data as {
      kind?: string;
      props?: Record<string, unknown>;
      messageId?: string;
    };
    if (typeof d.kind !== "string" || !d.props) return prev;
    const kind: string = d.kind;
    const props: Record<string, unknown> = d.props;
    const messageId: string | undefined =
      typeof d.messageId === "string" && d.messageId.length > 0
        ? d.messageId
        : undefined;
    const payload: AnyDirective = { kind, props };
    if (messageId !== undefined) payload.messageId = messageId;
    return prev.map((t) => {
      if (t.kind !== "assistant" || t.id !== assistantId) return t;
      return {
        ...t,
        blocks: [...t.blocks, { type: "directive", payload }],
      };
    });
  }

  if (ev.event === "error") {
    const obj = data as { message?: string } | null;
    const message =
      obj && typeof obj.message === "string" ? obj.message : "stream_error";
    return prev.map((t) =>
      t.kind === "assistant" && t.id === assistantId
        ? { ...t, streaming: false, error: message }
        : t,
    );
  }

  if (ev.event === "done") {
    return prev.map((t) =>
      t.kind === "assistant" && t.id === assistantId
        ? { ...t, streaming: false }
        : t,
    );
  }

  return prev;
}
