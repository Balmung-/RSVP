import type { ToolResult, ToolWidget } from "@/lib/ai/tools/types";
import type { SseSend, Widget, WorkspaceEmitter } from "@/lib/ai/widgets";
import type { SummaryRefreshOutcome } from "@/lib/ai/workspace-summary";
import { WORKSPACE_SUMMARY_WIDGET_KEY } from "@/lib/ai/widgetKeys";

// P14-O — route-level pin for the per-tool-success seam inside
// `/api/chat`.
//
// GPT's audit on P14-M blocked the "P14 complete" claim because the
// file-ingest → chat/widget-refresh path was only covered at the
// helper level — `uploads-route.test.ts` (upload side),
// `tool-summarize-file.test.ts` and `tool-review-file-import.test.ts`
// (tool handlers produce the right widget), and `widget-pipeline.test.ts`
// (the emitter translates an `.upsert()` call into an SSE frame).
// But nothing proved that the ROUTE stitches these together: that
// after a file tool dispatches successfully, the route persists the
// message, threads the message id as `sourceMessageId` on the widget,
// calls `workspace.upsert(...)`, emits `widget_upsert` over SSE,
// triggers the rollup-refresh gate, and emits the final `tool:ok`
// frame — all in the right order.
//
// This file extracts that wiring into a single pure helper so the
// route-level contract is testable without spinning up Next.js. The
// helper takes:
//
//   - The successful ToolResult (the dispatch caller has already
//     narrowed to result.ok === true).
//   - The tool's name + the persisted ChatMessage row id, threaded
//     through to `sourceMessageId` (the anchor for ConfirmSend POSTs)
//     and to the final `tool:ok` frame.
//   - The workspace's `.upsert(...)` method (the tests stub it; the
//     route passes the emitter's bound method).
//   - A pre-bound `refreshSummary(toolName)` closure that hides
//     prisma + sessionId + campaignScope from this helper — the chat
//     route binds those once before the tool-dispatch loop and
//     forwards only the toolName here, which keeps this helper free
//     of Prisma types.
//   - An SSE `send` sink.
//   - An optional `log` hook so the test can capture the warn branches
//     without touching console.
//
// Frame-order guarantees (pinned in the test):
//   1. Directive frame FIRST (if the tool emitted one), with the
//      persisted messageId threaded in.
//   2. Widget upsert (if the tool emitted a widget) — triggers a
//      `widget_upsert` through the emitter. An invalid-widget drop
//      logs ONCE and proceeds silently — the emitter never fires.
//   3. Summary refresh fires next, emitting `widget_upsert` only when
//      `tryRefreshSummaryForChatTool` returned `produced`. The other
//      three outcomes (skipped / invalid / error) emit nothing; the
//      non-skipped ones log for server-side drift detection.
//   4. Final `tool:ok` frame — always last, always emitted regardless
//      of widget/summary outcome. The client's tool-lifecycle UI
//      relies on this closing frame to clear the "running" spinner.
//
// Behavior parity: The helper is a drop-in replacement for the
// inlined block at `src/app/api/chat/route.ts` lines 527-615. Same
// side-effect order, same log prefixes, same frame shapes.

export type SuccessSideEffects = {
  // Workspace upsert — the chat route binds this from the emitter
  // returned by `createWorkspaceEmitter`. Tests pass a spy.
  //
  // We carry the full argument shape (the `Omit<UpsertWidgetInput,
  // "sessionId">`) so the helper doesn't need to know sessionId
  // exists; the emitter pins sessionId at creation time.
  upsertWidget: WorkspaceEmitter["upsert"];
  // Bound refresh. The chat route closes over prisma + sessionId +
  // campaignScope; this helper only needs the toolName in to decide
  // whether any of that work runs. The existing gate predicate lives
  // in `tryRefreshSummaryForChatTool`.
  refreshSummary: (toolName: string) => Promise<SummaryRefreshOutcome>;
  send: SseSend;
  // Optional — defaults to `console.warn`. Tests inject a collector.
  log?: (message: string, extra?: unknown) => void;
};

export type SuccessContext = {
  toolName: string;
  toolRowId: string;
  sessionId: string;
  // The non-null widget from the tool result. Kept as a separate
  // field (not re-extracted from `result`) so the caller decides
  // whether the widget path is exercised — it's null when the tool
  // returned `directive` only or text only.
  widget: ToolWidget | null;
  // Validated directive payload the chat route already ran through
  // `validateDirective`. `null` when the tool didn't emit one or
  // validation dropped it.
  directive: unknown;
};

// Drives the post-dispatch side-effect sequence for a successful
// tool run. See the file header for the frame-order contract.
export async function handleToolSuccess(
  deps: SuccessSideEffects,
  ctx: SuccessContext,
): Promise<void> {
  const log = deps.log ?? ((m, extra) => console.warn(m, extra));
  const { send } = deps;
  const { toolName, toolRowId, sessionId, widget, directive } = ctx;

  // 1. Directive frame — emitted verbatim with the persisted messageId
  //    threaded in so ConfirmSend's POST anchor resolves. Deprecated
  //    path as of W3 but still supported for any tool that opts into
  //    the transient render route.
  if (directive) {
    send("directive", {
      ...(directive as Record<string, unknown>),
      messageId: toolRowId,
    });
  }

  // 2. Widget upsert — the operator-path `summarize_file` /
  //    `review_file_import` / `draft_campaign` etc. flow through
  //    here. The emitter handles validation + persistence + the
  //    `widget_upsert` + optional `widget_focus` frames; all we do
  //    is forward the tool's widget and thread `sourceMessageId`.
  //    A null return from the emitter means validateWidget rejected
  //    the props — we log with the same prefix the inlined block
  //    used and proceed. The tool's text output is still in the
  //    transcript; we just lose the card.
  if (widget) {
    const upserted = await deps.upsertWidget({
      widgetKey: widget.widgetKey,
      kind: widget.kind,
      slot: widget.slot,
      props: widget.props,
      order: widget.order,
      sourceMessageId: toolRowId,
    });
    if (!upserted) {
      log(`[chat] invalid widget from tool ${toolName}; dropped`, {
        widgetKey: widget.widgetKey,
        kind: widget.kind,
      });
    }
  }

  // 3. Summary-rollup refresh. `tryRefreshSummaryForChatTool`'s gate
  //    decides if the tool moves counters; non-counter-moving tools
  //    return `skipped` and we emit nothing. The `produced` branch
  //    emits a DIRECT `widget_upsert` (not via `workspace.upsert`)
  //    because the emitter also fires `widget_focus`, which would
  //    pull the dashboard off whatever the tool just produced.
  const summaryOutcome = await deps.refreshSummary(toolName);
  if (summaryOutcome.kind === "produced") {
    send("widget_upsert", summaryOutcome.widget);
  } else if (summaryOutcome.kind === "invalid") {
    log(`[chat] workspace rollup produced invalid props; dropped`, {
      sessionId,
      widgetKey: WORKSPACE_SUMMARY_WIDGET_KEY,
    });
  } else if (summaryOutcome.kind === "error") {
    log(`[chat] workspace rollup refresh failed`, summaryOutcome.error);
  }

  // 4. Final frame — always emit, always last. The client's tool
  //    lifecycle UI relies on this to move the pill from "running"
  //    to "ok".
  send("tool", { name: toolName, status: "ok" });
}

// Re-export the Widget type for test convenience — the tests don't
// need to pull it from deep in widgets.ts just to construct a refresh
// outcome fixture.
export type { Widget };
