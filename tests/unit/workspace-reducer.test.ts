import { test } from "node:test";
import assert from "node:assert/strict";

import {
  reduceFocusRequest,
  reduceTurns,
  reduceWidgets,
  type WorkspaceSseEvent,
} from "../../src/components/chat/workspaceReducer";
import type {
  AssistantTurn,
  ClientWidget,
  FocusRequest,
  Turn,
} from "../../src/components/chat/types";

// W6 — exercises the pure SSE-event reducers extracted from the old
// inline ChatWorkspace.handleEvent. The runtime dispatcher funnels
// every non-session frame through all three reducers; each one is a
// no-op for events it doesn't recognise, which is the same pattern
// React state-slice updates follow when a functional updater returns
// the previous reference.
//
// These tests lock:
//   1. Happy-path state transitions for each event kind
//      (workspace_snapshot, widget_upsert, widget_remove, widget_focus,
//       text, tool, directive, error, done).
//   2. "Unrecognised event" short-circuit — a focus frame must NOT
//      mutate widgets, a text frame must NOT mutate focus, etc.
//      The SSE producer has never cross-wired these, but without
//      a test a future drift could silently apply the wrong slice.
//   3. Malformed payload rejection — a widget_upsert with no
//      `widgetKey` string, a widget_remove with no target key, a
//      text with no `delta`, etc. all must return `prev` unchanged.
//      This is the client-side trust boundary mirror of
//      server-side validateWidget / validateDirective.
//
// Helpers (buildEvent / stub assistant turn) keep the test signal
// tight — one assertion per state transition rather than a wall of
// JSON.stringify boilerplate.

function buildEvent(event: string, data: unknown): WorkspaceSseEvent {
  return { event, data: JSON.stringify(data) };
}

function makeAssistant(id: string, blocks: AssistantTurn["blocks"] = []): Turn {
  return { kind: "assistant", id, blocks, streaming: true };
}

function makeWidget(key: string, order = 0): ClientWidget {
  return {
    widgetKey: key,
    kind: "campaign_list",
    slot: "primary",
    props: { items: [] },
    order,
    sourceMessageId: null,
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z",
  };
}

// ---- reduceWidgets --------------------------------------------------

test("reduceWidgets: workspace_snapshot replaces the list wholesale", () => {
  const prev: ClientWidget[] = [makeWidget("a"), makeWidget("b")];
  const next = reduceWidgets(
    prev,
    buildEvent("workspace_snapshot", { widgets: [makeWidget("c")] }),
  );
  assert.equal(next.length, 1);
  assert.equal(next[0]!.widgetKey, "c");
});

test("reduceWidgets: workspace_snapshot with empty array clears the board", () => {
  // Empty-list is the authoritative "clear" signal — not a no-op.
  // If this drifted to prev-on-empty, a "widgets removed" frame
  // from the server could never land.
  const prev = [makeWidget("a")];
  const next = reduceWidgets(prev, buildEvent("workspace_snapshot", { widgets: [] }));
  assert.equal(next.length, 0);
});

test("reduceWidgets: workspace_snapshot without `widgets` field returns prev", () => {
  const prev = [makeWidget("a")];
  const next = reduceWidgets(
    prev,
    buildEvent("workspace_snapshot", { unrelated: 1 }),
  );
  assert.equal(next, prev, "must preserve reference so React bails out");
});

test("reduceWidgets: widget_upsert appends when key is new", () => {
  const prev = [makeWidget("a")];
  const next = reduceWidgets(
    prev,
    buildEvent("widget_upsert", makeWidget("b")),
  );
  assert.equal(next.length, 2);
  assert.equal(next[1]!.widgetKey, "b");
});

test("reduceWidgets: widget_upsert updates in place when key matches", () => {
  // Same-key re-upsert MUST replace at the same index — this is the
  // stable-keying invariant the workspace relies on. If this drifted
  // to append-always, re-asking a question would spam duplicates.
  const original = makeWidget("a", 0);
  const prev = [original, makeWidget("b", 1)];
  const updated: ClientWidget = { ...original, order: 42, props: { items: [{ id: "x" }] } };
  const next = reduceWidgets(prev, buildEvent("widget_upsert", updated));
  assert.equal(next.length, 2);
  assert.equal(next[0]!.widgetKey, "a");
  assert.equal(next[0]!.order, 42);
  assert.deepEqual(next[0]!.props, { items: [{ id: "x" }] });
  assert.equal(next[1]!.widgetKey, "b", "sibling untouched");
});

test("reduceWidgets: widget_upsert without widgetKey returns prev", () => {
  const prev = [makeWidget("a")];
  const next = reduceWidgets(
    prev,
    buildEvent("widget_upsert", { kind: "campaign_list", slot: "primary" }),
  );
  assert.equal(next, prev);
});

test("reduceWidgets: widget_upsert with null payload returns prev", () => {
  const prev = [makeWidget("a")];
  const next = reduceWidgets(prev, { event: "widget_upsert", data: "null" });
  assert.equal(next, prev);
});

test("reduceWidgets: widget_remove filters the matching key", () => {
  const prev = [makeWidget("a"), makeWidget("b"), makeWidget("c")];
  const next = reduceWidgets(
    prev,
    buildEvent("widget_remove", { widgetKey: "b" }),
  );
  assert.deepEqual(
    next.map((w) => w.widgetKey),
    ["a", "c"],
  );
});

test("reduceWidgets: widget_remove for missing key is a silent no-op (but SHOULD filter to same members)", () => {
  // Filter returns a new array even when no match — fine for React,
  // but the observable members must be identical. Pinning the shape
  // here so a future `if not present, return prev` optimisation
  // doesn't accidentally change externally-observable semantics.
  const prev = [makeWidget("a")];
  const next = reduceWidgets(
    prev,
    buildEvent("widget_remove", { widgetKey: "ghost" }),
  );
  assert.deepEqual(
    next.map((w) => w.widgetKey),
    ["a"],
  );
});

test("reduceWidgets: widget_remove without widgetKey returns prev", () => {
  const prev = [makeWidget("a")];
  const next = reduceWidgets(prev, buildEvent("widget_remove", {}));
  assert.equal(next, prev);
});

test("reduceWidgets: unrecognised event returns prev unchanged", () => {
  // Cross-slice isolation: a focus/text/tool frame must not touch
  // widgets. React bail-out depends on the same-reference return.
  const prev = [makeWidget("a")];
  for (const ev of [
    buildEvent("widget_focus", { widgetKey: "a" }),
    buildEvent("text", { delta: "hi" }),
    buildEvent("tool", { name: "x", status: "running" }),
    buildEvent("done", {}),
    buildEvent("who_knows", { foo: 1 }),
  ]) {
    assert.equal(reduceWidgets(prev, ev), prev, `must no-op for ${ev.event}`);
  }
});

test("reduceWidgets: malformed JSON in data returns prev", () => {
  const prev = [makeWidget("a")];
  const next = reduceWidgets(prev, { event: "widget_upsert", data: "{not json" });
  assert.equal(next, prev);
});

// ---- reduceFocusRequest --------------------------------------------

test("reduceFocusRequest: widget_focus sets key and bumps seq from 0", () => {
  const next = reduceFocusRequest(
    null,
    buildEvent("widget_focus", { widgetKey: "campaigns.list" }),
  );
  assert.ok(next);
  assert.equal(next!.widgetKey, "campaigns.list");
  assert.equal(next!.seq, 1);
});

test("reduceFocusRequest: repeated focus on the same key still bumps seq", () => {
  // Refining a filter twice in a row should scroll attention twice;
  // the dashboard effect fires on seq change even when widgetKey is
  // unchanged. This is the exact behaviour W4 required.
  const after1 = reduceFocusRequest(
    null,
    buildEvent("widget_focus", { widgetKey: "a" }),
  );
  const after2 = reduceFocusRequest(
    after1,
    buildEvent("widget_focus", { widgetKey: "a" }),
  );
  const after3 = reduceFocusRequest(
    after2,
    buildEvent("widget_focus", { widgetKey: "a" }),
  );
  assert.equal(after1!.seq, 1);
  assert.equal(after2!.seq, 2);
  assert.equal(after3!.seq, 3);
});

test("reduceFocusRequest: different key resets the visual target but seq still monotonic", () => {
  // seq is GLOBAL, not per-key. Even after switching targets, it keeps
  // increasing — the dashboard effect uses seq as an explicit
  // tie-breaker.
  const after1 = reduceFocusRequest(
    { widgetKey: "a", seq: 7 } as FocusRequest,
    buildEvent("widget_focus", { widgetKey: "b" }),
  );
  assert.equal(after1!.widgetKey, "b");
  assert.equal(after1!.seq, 8);
});

test("reduceFocusRequest: malformed widget_focus returns prev", () => {
  const prev: FocusRequest = { widgetKey: "a", seq: 1 };
  for (const ev of [
    buildEvent("widget_focus", {}),
    buildEvent("widget_focus", { widgetKey: 42 }),
    { event: "widget_focus", data: "not-json" } as WorkspaceSseEvent,
  ]) {
    assert.equal(reduceFocusRequest(prev, ev), prev);
  }
});

test("reduceFocusRequest: unrecognised event returns prev unchanged", () => {
  const prev: FocusRequest = { widgetKey: "a", seq: 3 };
  for (const ev of [
    buildEvent("workspace_snapshot", { widgets: [] }),
    buildEvent("widget_upsert", makeWidget("a")),
    buildEvent("text", { delta: "x" }),
    buildEvent("done", {}),
  ]) {
    assert.equal(reduceFocusRequest(prev, ev), prev);
  }
});

// ---- reduceTurns ---------------------------------------------------

test("reduceTurns: text delta appends to the last text block when present", () => {
  // Keep-appending is the streaming happy path — tokens land back-to-
  // back, we don't want one block per delta.
  const prev: Turn[] = [
    makeAssistant("a", [{ type: "text", text: "hello" }]) as AssistantTurn,
  ];
  const next = reduceTurns(prev, buildEvent("text", { delta: " world" }), {
    assistantId: "a",
  });
  const turn = next[0] as AssistantTurn;
  assert.equal(turn.blocks.length, 1);
  assert.equal((turn.blocks[0] as { text: string }).text, "hello world");
});

test("reduceTurns: text delta opens a new text block when last block isn't text", () => {
  const prev: Turn[] = [
    makeAssistant("a", [
      { type: "tool", name: "x", status: "ok" },
    ]) as AssistantTurn,
  ];
  const next = reduceTurns(prev, buildEvent("text", { delta: "after-tool" }), {
    assistantId: "a",
  });
  const turn = next[0] as AssistantTurn;
  assert.equal(turn.blocks.length, 2);
  assert.equal(turn.blocks[1]!.type, "text");
  assert.equal((turn.blocks[1] as { text: string }).text, "after-tool");
});

test("reduceTurns: text delta targeting a different assistantId is ignored", () => {
  // Older turns are immutable. If a late delta leaks from a prior
  // stream it must not corrupt the historical block.
  const prev: Turn[] = [
    makeAssistant("old", [{ type: "text", text: "frozen" }]) as AssistantTurn,
    makeAssistant("new", []) as AssistantTurn,
  ];
  const next = reduceTurns(prev, buildEvent("text", { delta: "leak" }), {
    assistantId: "new",
  });
  assert.equal(
    ((next[0] as AssistantTurn).blocks[0] as { text: string }).text,
    "frozen",
  );
});

test("reduceTurns: tool running upgrades in place on terminal status", () => {
  // The pill is reused — same {name, status: running} block flips to
  // {status: ok/error} at the same index. That's how the transcript
  // avoids stale "running…" pills when the tool finishes.
  const prev: Turn[] = [
    makeAssistant("a", [
      { type: "tool", name: "list", status: "running" },
    ]) as AssistantTurn,
  ];
  const next = reduceTurns(
    prev,
    buildEvent("tool", { name: "list", status: "ok" }),
    { assistantId: "a" },
  );
  const turn = next[0] as AssistantTurn;
  assert.equal(turn.blocks.length, 1);
  assert.equal((turn.blocks[0] as { status: string }).status, "ok");
});

test("reduceTurns: tool with mismatched name appends a new pill", () => {
  const prev: Turn[] = [
    makeAssistant("a", [
      { type: "tool", name: "list", status: "running" },
    ]) as AssistantTurn,
  ];
  const next = reduceTurns(
    prev,
    buildEvent("tool", { name: "detail", status: "running" }),
    { assistantId: "a" },
  );
  const turn = next[0] as AssistantTurn;
  assert.equal(turn.blocks.length, 2);
});

test("reduceTurns: directive appends a directive block with optional messageId", () => {
  const prev: Turn[] = [makeAssistant("a") as AssistantTurn];
  const next = reduceTurns(
    prev,
    buildEvent("directive", {
      kind: "campaign_list",
      props: { items: [] },
      messageId: "msg_42",
    }),
    { assistantId: "a" },
  );
  const turn = next[0] as AssistantTurn;
  assert.equal(turn.blocks.length, 1);
  const block = turn.blocks[0] as {
    type: string;
    payload: { kind: string; messageId?: string };
  };
  assert.equal(block.type, "directive");
  assert.equal(block.payload.kind, "campaign_list");
  assert.equal(block.payload.messageId, "msg_42");
});

test("reduceTurns: directive without messageId omits the field (not 'undefined')", () => {
  // Explicit absence vs literal `undefined` — the downstream renderer
  // distinguishes `messageId in payload` via an `in` check.
  const prev: Turn[] = [makeAssistant("a") as AssistantTurn];
  const next = reduceTurns(
    prev,
    buildEvent("directive", { kind: "campaign_list", props: { items: [] } }),
    { assistantId: "a" },
  );
  const block = (next[0] as AssistantTurn).blocks[0] as {
    payload: Record<string, unknown>;
  };
  assert.equal("messageId" in block.payload, false);
});

test("reduceTurns: error finalizes the streaming flag with a message", () => {
  const prev: Turn[] = [makeAssistant("a") as AssistantTurn];
  const next = reduceTurns(
    prev,
    buildEvent("error", { message: "upstream_429" }),
    { assistantId: "a" },
  );
  const turn = next[0] as AssistantTurn;
  assert.equal(turn.streaming, false);
  assert.equal(turn.error, "upstream_429");
});

test("reduceTurns: error with no message defaults to 'stream_error'", () => {
  const prev: Turn[] = [makeAssistant("a") as AssistantTurn];
  const next = reduceTurns(prev, buildEvent("error", {}), { assistantId: "a" });
  assert.equal((next[0] as AssistantTurn).error, "stream_error");
});

test("reduceTurns: done clears the streaming flag without setting error", () => {
  const prev: Turn[] = [makeAssistant("a") as AssistantTurn];
  const next = reduceTurns(prev, buildEvent("done", {}), { assistantId: "a" });
  const turn = next[0] as AssistantTurn;
  assert.equal(turn.streaming, false);
  assert.equal(turn.error, undefined);
});

test("reduceTurns: unrecognised event returns prev unchanged", () => {
  // Cross-slice isolation: widget frames must not touch turns.
  const prev: Turn[] = [makeAssistant("a") as AssistantTurn];
  for (const ev of [
    buildEvent("workspace_snapshot", { widgets: [] }),
    buildEvent("widget_upsert", makeWidget("x")),
    buildEvent("widget_remove", { widgetKey: "x" }),
    buildEvent("widget_focus", { widgetKey: "x" }),
    buildEvent("mystery", {}),
  ]) {
    assert.equal(reduceTurns(prev, ev, { assistantId: "a" }), prev);
  }
});

test("reduceTurns: malformed payloads return prev for every event kind", () => {
  const prev: Turn[] = [makeAssistant("a") as AssistantTurn];
  const ctx = { assistantId: "a" };
  for (const ev of [
    buildEvent("text", { delta: 42 }),
    buildEvent("text", {}),
    buildEvent("tool", { name: "x" }), // missing status
    buildEvent("tool", { status: "ok" }), // missing name
    buildEvent("directive", { kind: "x" }), // missing props
    buildEvent("directive", { props: {} }), // missing kind
    { event: "text", data: "{not-json" } as WorkspaceSseEvent,
  ]) {
    assert.equal(reduceTurns(prev, ev, ctx), prev, `must no-op for ${ev.event}`);
  }
});
