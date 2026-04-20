import { test } from "node:test";
import assert from "node:assert/strict";

import {
  handleToolSuccess,
  type SuccessContext,
  type SuccessSideEffects,
} from "../../src/app/api/chat/handle-tool-success";
import type { ToolWidget } from "../../src/lib/ai/tools/types";
import type { Widget } from "../../src/lib/ai/widgets";
import type { SummaryRefreshOutcome } from "../../src/lib/ai/workspace-summary";
import { WORKSPACE_SUMMARY_WIDGET_KEY } from "../../src/lib/ai/widgetKeys";

// P14-O — route-level pins for the file-ingest → chat/widget-refresh
// seam inside `/api/chat`.
//
// Context from GPT's P14-M audit:
//
//   "file ingest -> widget refresh — coverage today is split across
//    uploads-route.test.ts, tool-summarize-file.test.ts,
//    tool-review-file-import.test.ts, and widget-pipeline.test.ts,
//    but there is still no route-level pin on the actual operator
//    path from upload/ingest through chat/widget refresh at the
//    seam P14 originally called out."
//
// The extraction — `handleToolSuccess(deps, ctx)` — pulls the chat
// route's per-success wiring out of the inlined streaming handler so
// the FRAME ORDER and the DROP-AND-LOG posture can be asserted at
// test time. Specifically, this is the operator path from:
//
//   (1) POST /api/uploads returns { ingest.id: "ing_123" }  (covered by
//       uploads-route.test.ts)
//   (2) operator's chat composer sends "[file: ... ingestId: ing_123]"
//   (3) /api/chat dispatches summarize_file / review_file_import
//       (tool handlers covered by tool-summarize-file.test.ts /
//       tool-review-file-import.test.ts)
//   (4) /api/chat takes the tool's `.widget` payload and threads it
//       into `workspace.upsert(...)` with `sourceMessageId =
//       toolRow.id`  ← THIS IS THE SEAM
//   (5) emitter validates + persists + emits `widget_upsert` SSE
//       (covered by widget-pipeline.test.ts)
//   (6) workspace rollup may refresh with a second `widget_upsert`
//       (covered by workspace-summary.test.ts)
//   (7) `tool:ok` frame closes out the turn
//
// The only previously-unpinned seam is (4)–(7) — the ROUTE stitching.
// This file pins:
//
//   - Frame-order contract (directive → upsert → optional rollup
//     widget_upsert → tool:ok). Reordering is a silent regression:
//     the client's reducer processes in arrival order, and shipping
//     `tool:ok` before `widget_upsert` would let the UI clear the
//     spinner before the card appeared.
//   - sourceMessageId threading — the widget upsert MUST receive the
//     persisted ChatMessage row id as `sourceMessageId`, not the
//     tool_use id or the sessionId. That id is the anchor for
//     ConfirmSend POSTs, so a drift here silently breaks send
//     confirmation.
//   - directive's messageId threading — symmetric to widget's
//     sourceMessageId, but lives in the directive envelope.
//   - Drop-and-log on invalid widget — the emitter returns null when
//     validateWidget rejects; the route logs with widgetKey + kind
//     and continues. A regression that raises instead would abort
//     the whole turn.
//   - Drop-and-log on workspace-rollup invalid / errored — same
//     pattern for the summary path; a throw during rollup refresh
//     must NOT propagate out.
//   - Final `tool:ok` frame is ALWAYS emitted — including the
//     invalid-widget, invalid-summary, and errored-summary branches.
//     Without this guarantee the UI spinner would stick "running"
//     forever on a rollup glitch.

// --- fixtures + helpers -------------------------------------------

type SseEvent = { event: string; data: unknown };

// Per-test harness: bundles a send collector, a stub upsert with
// configurable return, a stub refreshSummary with configurable
// outcome, and a log collector. All three are spies so we can assert
// sequence AND payloads.
function harness(options: {
  upsertReturns?: Widget | null;
  refreshOutcome?: SummaryRefreshOutcome;
} = {}) {
  const events: SseEvent[] = [];
  const upsertCalls: Parameters<SuccessSideEffects["upsertWidget"]>[0][] = [];
  const refreshCalls: string[] = [];
  const logs: Array<{ message: string; extra: unknown }> = [];

  const deps: SuccessSideEffects = {
    upsertWidget: async (input) => {
      upsertCalls.push(input);
      return options.upsertReturns === undefined
        ? ({
            // Default: emitter-style return (validated, persisted).
            ...input,
            order: input.order ?? 0,
            sourceMessageId: input.sourceMessageId ?? null,
            createdAt: "2026-04-20T00:00:00.000Z",
            updatedAt: "2026-04-20T00:00:00.000Z",
          } as Widget)
        : options.upsertReturns;
    },
    refreshSummary: async (toolName) => {
      refreshCalls.push(toolName);
      return options.refreshOutcome ?? { kind: "skipped" };
    },
    send: (event, data) => {
      events.push({ event, data });
    },
    log: (message, extra) => {
      logs.push({ message, extra });
    },
  };

  return { deps, events, upsertCalls, refreshCalls, logs };
}

// Canonical file_digest widget — shape a real `summarize_file` tool
// returns after reading an ingest row. We use a real key prefix so a
// grep for `file:` surfaces this test alongside the tool handler's
// widgetKey helper.
function fileDigestWidget(ingestId: string): ToolWidget {
  return {
    widgetKey: `file:${ingestId}`,
    kind: "file_digest",
    slot: "secondary",
    props: {
      ingestId,
      filename: "guest-list.csv",
      kind: "text_plain",
      status: "ok",
      bytesExtracted: 2048,
      excerpt: "Al-Harbi\nAl-Rashed\n...",
    },
  };
}

function importReviewWidget(ingestId: string): ToolWidget {
  return {
    widgetKey: `import_review:invitees:${ingestId}`,
    kind: "import_review",
    slot: "secondary",
    props: {
      ingestId,
      target: "invitees",
      rows_total: 120,
      sample: [],
    },
  };
}

function ctx(
  overrides: Partial<SuccessContext> = {},
): SuccessContext {
  return {
    toolName: overrides.toolName ?? "summarize_file",
    toolRowId: overrides.toolRowId ?? "msg_row_tool_1",
    sessionId: overrides.sessionId ?? "sess_1",
    widget: overrides.widget ?? null,
    directive: overrides.directive ?? null,
  };
}

// --- frame-order contract -----------------------------------------

test("handleToolSuccess: widget only → upsert, then tool:ok (no rollup frame on skipped)", async () => {
  const h = harness();
  const widget = fileDigestWidget("ing_123");
  await handleToolSuccess(h.deps, ctx({ widget, toolName: "summarize_file" }));

  // Emitter's `widget_upsert` is fired inside the upsertWidget
  // stub's return path — the test harness doesn't replay that SSE
  // frame because the emitter itself owns it (covered by
  // widget-pipeline.test.ts). What the route-seam pins is the
  // upsertWidget call + the final tool:ok frame.
  assert.deepEqual(
    h.events.map((e) => e.event),
    ["tool"],
    "only the closing tool:ok frame should be emitted by this helper when summary is skipped",
  );
  assert.equal(h.upsertCalls.length, 1);
  assert.equal(h.refreshCalls.length, 1);
  assert.equal(h.refreshCalls[0], "summarize_file");
  assert.equal(h.logs.length, 0);
});

test("handleToolSuccess: directive only → directive frame then tool:ok", async () => {
  const h = harness();
  await handleToolSuccess(
    h.deps,
    ctx({
      directive: { kind: "confirm_send", props: { anchor: "x" } },
      widget: null,
    }),
  );
  assert.deepEqual(
    h.events.map((e) => e.event),
    ["directive", "tool"],
  );
  assert.equal(h.upsertCalls.length, 0);
  assert.equal(h.refreshCalls.length, 1);
});

test("handleToolSuccess: no widget + no directive → just tool:ok", async () => {
  const h = harness();
  await handleToolSuccess(h.deps, ctx({ widget: null, directive: null }));
  assert.deepEqual(
    h.events.map((e) => e.event),
    ["tool"],
  );
  assert.equal(h.upsertCalls.length, 0);
  // refreshSummary still runs — gate decides skipped; no queries
  // fire inside a skip-return.
  assert.equal(h.refreshCalls.length, 1);
});

test("handleToolSuccess: directive + widget + summary produced → directive, widget_upsert (rollup), tool:ok in order", async () => {
  const rollupWidget: Widget = {
    widgetKey: WORKSPACE_SUMMARY_WIDGET_KEY,
    kind: "workspace_rollup",
    slot: "summary",
    props: { campaigns: { total: 3 } },
    order: 0,
    sourceMessageId: null,
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
  };
  const h = harness({
    refreshOutcome: { kind: "produced", widget: rollupWidget },
  });
  const widget = fileDigestWidget("ing_xyz");
  await handleToolSuccess(
    h.deps,
    ctx({
      widget,
      directive: { kind: "confirm_send", props: { anchor: "y" } },
    }),
  );
  // Strict order: directive FIRST (before any widget frame),
  // widget_upsert SECOND (rollup — emitter's own upsert is NOT in
  // this collector because it runs inside the upsertWidget stub's
  // return), tool:ok LAST. The client's reducer relies on this
  // arrival order.
  assert.deepEqual(
    h.events.map((e) => e.event),
    ["directive", "widget_upsert", "tool"],
  );
  // widget_upsert event carries the summary rollup widget verbatim
  const rollupEvent = h.events[1];
  assert.equal(rollupEvent.event, "widget_upsert");
  assert.equal(
    (rollupEvent.data as Widget).widgetKey,
    WORKSPACE_SUMMARY_WIDGET_KEY,
  );
});

// --- sourceMessageId / messageId threading ------------------------

test("handleToolSuccess: widget upsert receives toolRowId as sourceMessageId", async () => {
  // Critical anchor — ConfirmSend POSTs to /api/chat/confirm/[messageId]
  // and that id is the tool-row id we thread here. A drift (e.g.
  // sending sessionId or tool_use_id) silently breaks send
  // confirmation.
  const h = harness();
  const widget = fileDigestWidget("ing_123");
  await handleToolSuccess(
    h.deps,
    ctx({ widget, toolRowId: "msg_row_ABC", toolName: "summarize_file" }),
  );
  assert.equal(h.upsertCalls.length, 1);
  const call = h.upsertCalls[0];
  assert.equal(call.sourceMessageId, "msg_row_ABC");
  // Other fields round-trip verbatim
  assert.equal(call.widgetKey, "file:ing_123");
  assert.equal(call.kind, "file_digest");
  assert.equal(call.slot, "secondary");
  assert.deepEqual(call.props, widget.props);
});

test("handleToolSuccess: directive frame threads messageId = toolRowId", async () => {
  const h = harness();
  await handleToolSuccess(
    h.deps,
    ctx({
      directive: { kind: "confirm_send", props: { anchor: "x" } },
      toolRowId: "msg_row_XYZ",
    }),
  );
  const dir = h.events[0];
  assert.equal(dir.event, "directive");
  const payload = dir.data as Record<string, unknown>;
  assert.equal(payload.messageId, "msg_row_XYZ");
  // The original kind + props are preserved
  assert.equal(payload.kind, "confirm_send");
  assert.deepEqual(payload.props, { anchor: "x" });
});

test("handleToolSuccess: widget upsert preserves order field when present", async () => {
  const h = harness();
  const widget: ToolWidget = {
    ...fileDigestWidget("ing_1"),
    order: 7,
  };
  await handleToolSuccess(h.deps, ctx({ widget }));
  assert.equal(h.upsertCalls[0].order, 7);
});

test("handleToolSuccess: widget upsert forwards undefined order when absent", async () => {
  // Schema tolerates an absent order (emitter defaults); pin this
  // so a future change that eagerly coerces undefined → 0 in the
  // route happens deliberately.
  const h = harness();
  const widget = fileDigestWidget("ing_1"); // no order field
  await handleToolSuccess(h.deps, ctx({ widget }));
  assert.equal(h.upsertCalls[0].order, undefined);
});

// --- invalid-widget log + continue --------------------------------

test("handleToolSuccess: emitter null return → log + tool:ok still emitted", async () => {
  // `workspace.upsert(...)` returning null means the emitter's
  // `validateWidget` rejected the props. Route must log with the
  // widgetKey + kind and proceed. The tool's text output is already
  // in the transcript; we just lose the card, not the turn.
  const h = harness({ upsertReturns: null });
  const widget = fileDigestWidget("ing_bad");
  await handleToolSuccess(
    h.deps,
    ctx({ widget, toolName: "summarize_file" }),
  );

  // Log carries the exact prefix + extras
  assert.equal(h.logs.length, 1);
  assert.match(
    h.logs[0].message,
    /\[chat\] invalid widget from tool summarize_file; dropped/,
  );
  assert.deepEqual(h.logs[0].extra, {
    widgetKey: "file:ing_bad",
    kind: "file_digest",
  });

  // tool:ok still fires — the turn is not aborted
  assert.deepEqual(
    h.events.map((e) => e.event),
    ["tool"],
  );
});

// --- summary branches ---------------------------------------------

test("handleToolSuccess: summary produced → widget_upsert frame AFTER any widget upsert", async () => {
  // Intra-turn ordering — the tool's own widget is upserted first,
  // then the rollup. Reversing this would flash the rollup's new
  // counters before the row the operator just produced has landed.
  const rollupWidget: Widget = {
    widgetKey: WORKSPACE_SUMMARY_WIDGET_KEY,
    kind: "workspace_rollup",
    slot: "summary",
    props: { campaigns: { total: 1 } },
    order: 0,
    sourceMessageId: null,
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
  };
  // Interleave sequence recorder into upsertWidget + send
  const order: string[] = [];
  const widget = fileDigestWidget("ing_seq");
  const deps: SuccessSideEffects = {
    upsertWidget: async () => {
      order.push("widget.upsert");
      return {
        ...widget,
        order: 0,
        sourceMessageId: null,
        createdAt: "x",
        updatedAt: "x",
      } as Widget;
    },
    refreshSummary: async () => {
      order.push("summary.refresh");
      return { kind: "produced", widget: rollupWidget };
    },
    send: (event) => {
      order.push(`send:${event}`);
    },
    log: () => {},
  };
  await handleToolSuccess(deps, ctx({ widget }));
  assert.deepEqual(order, [
    "widget.upsert",
    "summary.refresh",
    "send:widget_upsert",
    "send:tool",
  ]);
});

test("handleToolSuccess: summary skipped → no frame, no log", async () => {
  const h = harness({ refreshOutcome: { kind: "skipped" } });
  const widget = fileDigestWidget("ing_1");
  await handleToolSuccess(h.deps, ctx({ widget }));
  // No widget_upsert frame for the rollup, no log at all — skipped
  // is the silent-no-op branch.
  assert.equal(
    h.events.filter((e) => e.event === "widget_upsert").length,
    0,
  );
  assert.equal(h.logs.length, 0);
});

test("handleToolSuccess: summary invalid → log with sessionId + rollup key; tool:ok still fires", async () => {
  const h = harness({ refreshOutcome: { kind: "invalid" } });
  await handleToolSuccess(
    h.deps,
    ctx({ sessionId: "sess_ABC", toolName: "draft_campaign" }),
  );
  assert.equal(h.logs.length, 1);
  assert.match(
    h.logs[0].message,
    /\[chat\] workspace rollup produced invalid props; dropped/,
  );
  assert.deepEqual(h.logs[0].extra, {
    sessionId: "sess_ABC",
    widgetKey: WORKSPACE_SUMMARY_WIDGET_KEY,
  });
  // No widget_upsert for the rollup; tool:ok still fires
  assert.deepEqual(
    h.events.map((e) => e.event),
    ["tool"],
  );
});

test("handleToolSuccess: summary error → log with raw error; tool:ok still fires", async () => {
  const err = new Error("prisma boom");
  const h = harness({ refreshOutcome: { kind: "error", error: err } });
  await handleToolSuccess(h.deps, ctx({ toolName: "draft_campaign" }));
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0].message, /\[chat\] workspace rollup refresh failed/);
  // Extra is the raw error, not a stringified form — preserves
  // stack for server-side alerting.
  assert.equal(h.logs[0].extra, err);
  assert.deepEqual(
    h.events.map((e) => e.event),
    ["tool"],
  );
});

// --- combined regressions -----------------------------------------

test("handleToolSuccess: invalid widget + errored summary → BOTH logged, tool:ok still fires", async () => {
  // Defense-in-depth: even if both drop-and-log paths fire in the
  // same turn, the terminal `tool:ok` must still appear so the UI
  // spinner clears.
  const err = new Error("db unreachable");
  const h = harness({
    upsertReturns: null,
    refreshOutcome: { kind: "error", error: err },
  });
  const widget = fileDigestWidget("ing_bad");
  await handleToolSuccess(
    h.deps,
    ctx({ widget, toolName: "summarize_file", sessionId: "sess_1" }),
  );
  assert.equal(h.logs.length, 2);
  // First log: invalid widget
  assert.match(h.logs[0].message, /invalid widget from tool summarize_file/);
  // Second log: rollup error
  assert.match(h.logs[1].message, /workspace rollup refresh failed/);
  assert.deepEqual(
    h.events.map((e) => e.event),
    ["tool"],
  );
});

test("handleToolSuccess: refreshSummary is invoked exactly once regardless of widget path", async () => {
  // Matters because the refresh issues real prisma counts in prod.
  // Calling it twice per turn (e.g. from both the widget branch and
  // a terminal branch) would double the query load.
  const h1 = harness();
  await handleToolSuccess(h1.deps, ctx({ widget: fileDigestWidget("x") }));
  assert.equal(h1.refreshCalls.length, 1);

  const h2 = harness();
  await handleToolSuccess(h2.deps, ctx({ widget: null, directive: null }));
  assert.equal(h2.refreshCalls.length, 1);

  const h3 = harness({ upsertReturns: null });
  await handleToolSuccess(h3.deps, ctx({ widget: fileDigestWidget("y") }));
  assert.equal(h3.refreshCalls.length, 1);
});

test("handleToolSuccess: toolName forwarded to refreshSummary exactly (gate predicate sees the call name)", async () => {
  // The gate inside `tryRefreshSummaryForChatTool` branches on the
  // tool name (only `draft_campaign` triggers today). A regression
  // that mutates the name between the dispatch call and the gate
  // would break the rollup refresh silently.
  for (const name of [
    "summarize_file",
    "review_file_import",
    "draft_campaign",
    "propose_send",
    "list_campaigns",
  ]) {
    const h = harness();
    await handleToolSuccess(h.deps, ctx({ toolName: name }));
    assert.equal(h.refreshCalls.length, 1);
    assert.equal(h.refreshCalls[0], name);
  }
});

// --- operator path: upload → chat → widget_upsert round-trip -----

test("handleToolSuccess: file-ingest operator path — summarize_file widget threads ingestId + row id", async () => {
  // End-to-end route-seam pin for the path GPT's audit called out:
  // upload yields ingest.id → chat dispatches summarize_file with
  // that id → tool returns file_digest widget keyed on the id →
  // route's handleToolSuccess hands it to the emitter with the
  // persisted ChatMessage row id as the sourceMessageId anchor.
  //
  // This one test mirrors the real operator flow top-to-bottom at
  // the route seam — every other test in this file isolates a
  // single regression surface; this one pins the COMPOSITE.
  const h = harness();
  const ingestId = "ing_csv_1701";
  const toolRowId = "msg_row_qr";
  await handleToolSuccess(
    h.deps,
    ctx({
      widget: fileDigestWidget(ingestId),
      toolName: "summarize_file",
      toolRowId,
      sessionId: "sess_operator_1",
    }),
  );
  // Widget was upserted with the right key + anchor
  assert.equal(h.upsertCalls.length, 1);
  const up = h.upsertCalls[0];
  assert.equal(up.widgetKey, `file:${ingestId}`);
  assert.equal(up.kind, "file_digest");
  assert.equal(up.slot, "secondary");
  assert.equal(up.sourceMessageId, toolRowId);
  assert.equal((up.props as { ingestId: string }).ingestId, ingestId);
  // summarize_file is not in the rollup refresh gate — refreshSummary
  // is still called (gate runs server-side) but returns skipped.
  assert.equal(h.refreshCalls.length, 1);
  assert.equal(h.refreshCalls[0], "summarize_file");
  // Final frame is always tool:ok
  assert.deepEqual(
    h.events.map((e) => e.event),
    ["tool"],
  );
  const toolFrame = h.events[0].data as { name: string; status: string };
  assert.equal(toolFrame.name, "summarize_file");
  assert.equal(toolFrame.status, "ok");
});

test("handleToolSuccess: file-import operator path — review_file_import widget round-trips", async () => {
  // Parallel pin for the other file-tool path (review_file_import)
  // that the P5 / P6 ingest roadmap wired. Same seam, different
  // widgetKey shape (per-target, not per-file). Covers the "twin"
  // code path so a regression that only breaks one tool still fires.
  const h = harness();
  const ingestId = "ing_invites_42";
  await handleToolSuccess(
    h.deps,
    ctx({
      widget: importReviewWidget(ingestId),
      toolName: "review_file_import",
      toolRowId: "msg_row_rfi",
    }),
  );
  assert.equal(h.upsertCalls.length, 1);
  const up = h.upsertCalls[0];
  assert.equal(up.widgetKey, `import_review:invitees:${ingestId}`);
  assert.equal(up.kind, "import_review");
  assert.equal(up.sourceMessageId, "msg_row_rfi");
  assert.equal(h.refreshCalls[0], "review_file_import");
});

// --- log sink default --------------------------------------------

test("handleToolSuccess: omitting log dep falls back to console.warn (no throw)", async () => {
  // Belt-and-braces — the production route constructs deps without
  // a `log` field. Stub console.warn for the duration of the test
  // so we can assert the default path takes effect without polluting
  // stderr.
  const prev = console.warn;
  const warnCalls: Array<unknown[]> = [];
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };
  try {
    const deps: SuccessSideEffects = {
      upsertWidget: async () => null, // force the invalid-widget branch
      refreshSummary: async () => ({ kind: "skipped" }),
      send: () => {},
      // no log override
    };
    const widget = fileDigestWidget("ing_default_log");
    await handleToolSuccess(deps, ctx({ widget }));
    // At least the invalid-widget warn fired
    assert.ok(warnCalls.length >= 1);
    const msg = String(warnCalls[0][0]);
    assert.match(msg, /invalid widget from tool summarize_file/);
  } finally {
    console.warn = prev;
  }
});

// --- terminal frame contract --------------------------------------

test("handleToolSuccess: tool:ok frame carries { name, status: 'ok' } verbatim", async () => {
  const h = harness();
  await handleToolSuccess(h.deps, ctx({ toolName: "draft_campaign" }));
  const toolFrame = h.events[h.events.length - 1];
  assert.equal(toolFrame.event, "tool");
  const payload = toolFrame.data as Record<string, unknown>;
  assert.equal(payload.name, "draft_campaign");
  assert.equal(payload.status, "ok");
  // No error field on the success frame — the error branch lives in
  // the route's else-block, not in this helper.
  assert.equal("error" in payload, false);
});
