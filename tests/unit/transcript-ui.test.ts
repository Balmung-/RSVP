import { test } from "node:test";
import assert from "node:assert/strict";

import {
  rebuildUiTurns,
  type UiAssistantTurn,
  type UiTranscriptRow,
} from "../../src/lib/ai/transcript-ui";

// Unit tests for the pure `rebuildUiTurns` transform used by
// `/api/chat/session/[id]` hydration (W2). The function takes DB rows
// (user / assistant / tool) and returns the same block-level UI
// shape ChatWorkspace builds up live — the client can set state to
// it directly without any further transformation.
//
// Coverage goals map to the grouping rule in transcript-ui.ts:
//   - user row -> UserTurn
//   - assistant row + immediate tool rows -> AssistantTurn with text,
//     tool pill(s), directive block(s) interleaved
//   - orphan tool row (no preceding assistant) -> silently skipped
//   - tool row with isError=true -> pill status "error", error text
//     parsed from "error: <reason>" content prefix
//   - renderDirective parses to a directive block, with tool row id
//     threaded as payload.messageId (so ConfirmSend POST anchor
//     matches the live SSE path)
//   - corrupt renderDirective JSON -> directive block omitted, tool
//     pill still rendered (defence-in-depth, not defence-in-brittle)
//   - streaming is always `false` on hydration (settled turns)
//
// Helpers below build rows with just enough fields for the transform
// to read — the `UiTranscriptRow` shape is a narrow Pick of
// ChatMessage so tests don't need to fabricate the full schema.

// A minimum fully-valid campaign_list item — every field the
// per-kind validator in `directive-validate.ts` requires. Used where
// a test needs a directive that SURVIVES the read-path validator.
const VALID_CAMPAIGN_ITEM = {
  id: "c1",
  name: "Royal Dinner",
  status: "scheduled",
  event_at: null,
  venue: null,
  team_id: null,
  stats: { total: 0, responded: 0, headcount: 0 },
};

// ---- row builders ----

function userRow(id: string, content: string): UiTranscriptRow {
  return {
    id,
    role: "user",
    content,
    toolName: null,
    renderDirective: null,
    isError: false,
  };
}

function assistantRow(id: string, content: string): UiTranscriptRow {
  return {
    id,
    role: "assistant",
    content,
    toolName: null,
    renderDirective: null,
    isError: false,
  };
}

function toolRow(
  id: string,
  name: string,
  opts: {
    content?: string;
    isError?: boolean;
    renderDirective?: string | null;
  } = {},
): UiTranscriptRow {
  return {
    id,
    role: "tool",
    content: opts.content ?? "",
    toolName: name,
    renderDirective: opts.renderDirective ?? null,
    isError: opts.isError ?? false,
  };
}

// Narrow an AssistantTurn out of the Turn union with an assert so
// the block-level assertions don't need repeated discriminant checks.
function asAssistant(turn: unknown): UiAssistantTurn {
  assert.ok(
    turn !== null && typeof turn === "object",
    "expected non-null turn",
  );
  const t = turn as { kind: string };
  assert.equal(t.kind, "assistant", `expected assistant turn, got ${t.kind}`);
  return turn as UiAssistantTurn;
}

// ---- base cases ----

test("rebuildUiTurns: empty rows -> empty turns", () => {
  const turns = rebuildUiTurns([]);
  assert.deepEqual(turns, []);
});

test("rebuildUiTurns: a lone user row becomes a UserTurn", () => {
  const turns = rebuildUiTurns([userRow("u1", "hello")]);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0], { kind: "user", id: "u1", text: "hello" });
});

test("rebuildUiTurns: a bare assistant row becomes an AssistantTurn with one text block", () => {
  const turns = rebuildUiTurns([assistantRow("a1", "hi there")]);
  assert.equal(turns.length, 1);
  const a = asAssistant(turns[0]);
  assert.equal(a.id, "a1");
  assert.equal(a.streaming, false);
  assert.deepEqual(a.blocks, [{ type: "text", text: "hi there" }]);
});

test("rebuildUiTurns: assistant with empty content produces no text block", () => {
  // Happens when the model produced only a tool_use (no intro text).
  // We deliberately don't emit an empty text block — the live stream
  // doesn't either, and an empty block would render as a blank line.
  const turns = rebuildUiTurns([
    assistantRow("a1", ""),
    toolRow("t1", "list_campaigns"),
  ]);
  const a = asAssistant(turns[0]);
  assert.equal(a.blocks.length, 1);
  assert.equal(a.blocks[0].type, "tool");
});

// ---- grouping rule ----

test("rebuildUiTurns: user -> assistant -> tool pairs into two turns", () => {
  const turns = rebuildUiTurns([
    userRow("u1", "show campaigns"),
    assistantRow("a1", "Here are the campaigns:"),
    toolRow("t1", "list_campaigns"),
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].kind, "user");
  const a = asAssistant(turns[1]);
  assert.equal(a.id, "a1");
  assert.equal(a.blocks.length, 2);
  assert.equal(a.blocks[0].type, "text");
  assert.equal(a.blocks[1].type, "tool");
});

test("rebuildUiTurns: multiple trailing tool rows all attach to the same assistant", () => {
  const turns = rebuildUiTurns([
    assistantRow("a1", "Looking up both:"),
    toolRow("t1", "list_campaigns"),
    toolRow("t2", "list_contacts"),
  ]);
  assert.equal(turns.length, 1);
  const a = asAssistant(turns[0]);
  // text + two tool pills = 3 blocks
  assert.equal(a.blocks.length, 3);
  assert.equal(a.blocks[1].type, "tool");
  assert.equal(a.blocks[2].type, "tool");
  if (a.blocks[1].type === "tool") assert.equal(a.blocks[1].name, "list_campaigns");
  if (a.blocks[2].type === "tool") assert.equal(a.blocks[2].name, "list_contacts");
});

test("rebuildUiTurns: two assistant turns separated by a user row DON'T cross-pollinate tools", () => {
  // Tools belong to the IMMEDIATELY-PRECEDING assistant. A user row
  // between them breaks the chain. Mirrors transcript.ts behavior.
  const turns = rebuildUiTurns([
    assistantRow("a1", "first answer"),
    toolRow("t1", "list_campaigns"),
    userRow("u1", "and contacts?"),
    assistantRow("a2", "here:"),
    toolRow("t2", "list_contacts"),
  ]);
  assert.equal(turns.length, 3);
  const a1 = asAssistant(turns[0]);
  const a2 = asAssistant(turns[2]);
  assert.equal(a1.blocks.length, 2); // text + 1 tool
  assert.equal(a2.blocks.length, 2); // text + 1 tool
  if (a1.blocks[1].type === "tool") assert.equal(a1.blocks[1].name, "list_campaigns");
  if (a2.blocks[1].type === "tool") assert.equal(a2.blocks[1].name, "list_contacts");
});

test("rebuildUiTurns: orphan tool row (no preceding assistant) is skipped silently", () => {
  // Shouldn't happen in practice — the handler never writes a tool
  // row without an assistant turn first — but defensive skip matches
  // transcript.ts and keeps a corrupted session from erroring out.
  const turns = rebuildUiTurns([
    toolRow("t0", "list_campaigns"),
    userRow("u1", "hi"),
    assistantRow("a1", "hello"),
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].kind, "user");
  const a = asAssistant(turns[1]);
  assert.equal(a.blocks.length, 1);
});

// ---- tool pill status / error ----

test("rebuildUiTurns: tool row with isError=false renders a status=ok pill", () => {
  const turns = rebuildUiTurns([
    assistantRow("a1", ""),
    toolRow("t1", "list_campaigns"),
  ]);
  const a = asAssistant(turns[0]);
  const pill = a.blocks[0];
  assert.equal(pill.type, "tool");
  if (pill.type === "tool") {
    assert.equal(pill.status, "ok");
    assert.equal(pill.error, undefined);
  }
});

test("rebuildUiTurns: tool row with isError=true and 'error: <reason>' content parses the reason", () => {
  const turns = rebuildUiTurns([
    assistantRow("a1", ""),
    toolRow("t1", "send_campaign", {
      isError: true,
      content: "error: forbidden",
    }),
  ]);
  const a = asAssistant(turns[0]);
  const pill = a.blocks[0];
  assert.equal(pill.type, "tool");
  if (pill.type === "tool") {
    assert.equal(pill.status, "error");
    assert.equal(pill.error, "forbidden");
  }
});

test("rebuildUiTurns: tool row with isError=true and bare content keeps the content as the error", () => {
  // When a handler wrote the error WITHOUT the "error: " prefix we
  // still surface SOMETHING so the operator sees the failure reason.
  const turns = rebuildUiTurns([
    assistantRow("a1", ""),
    toolRow("t1", "send_campaign", {
      isError: true,
      content: "timeout",
    }),
  ]);
  const a = asAssistant(turns[0]);
  const pill = a.blocks[0];
  if (pill.type === "tool") {
    assert.equal(pill.status, "error");
    assert.equal(pill.error, "timeout");
  }
});

test("rebuildUiTurns: tool row with isError=true and empty content produces pill without error text", () => {
  const turns = rebuildUiTurns([
    assistantRow("a1", ""),
    toolRow("t1", "send_campaign", { isError: true, content: "" }),
  ]);
  const a = asAssistant(turns[0]);
  const pill = a.blocks[0];
  if (pill.type === "tool") {
    assert.equal(pill.status, "error");
    assert.equal(pill.error, undefined);
  }
});

test("rebuildUiTurns: tool row with missing toolName falls back to 'unknown_tool'", () => {
  // Shouldn't happen — handlers always persist a toolName — but the
  // transform shouldn't throw if it does.
  const row: UiTranscriptRow = {
    id: "t1",
    role: "tool",
    content: "",
    toolName: null,
    renderDirective: null,
    isError: false,
  };
  const turns = rebuildUiTurns([assistantRow("a1", ""), row]);
  const a = asAssistant(turns[0]);
  const pill = a.blocks[0];
  if (pill.type === "tool") {
    assert.equal(pill.name, "unknown_tool");
  }
});

// ---- directive extraction ----

test("rebuildUiTurns: tool row with valid renderDirective emits a directive block after its pill", () => {
  const directive = {
    kind: "campaign_list",
    // A fully-shaped item so the read-path validator has something
    // real to accept — if this test regresses we'll know within
    // milliseconds of someone widening the prop schema.
    props: { items: [VALID_CAMPAIGN_ITEM] },
  };
  const turns = rebuildUiTurns([
    assistantRow("a1", "Here you go:"),
    toolRow("t1", "list_campaigns", {
      renderDirective: JSON.stringify(directive),
    }),
  ]);
  const a = asAssistant(turns[0]);
  // text + pill + directive
  assert.equal(a.blocks.length, 3);
  assert.equal(a.blocks[2].type, "directive");
  if (a.blocks[2].type === "directive") {
    assert.equal(a.blocks[2].payload.kind, "campaign_list");
    assert.deepEqual(a.blocks[2].payload.props, {
      items: [VALID_CAMPAIGN_ITEM],
    });
    // messageId is the tool row id — same anchor the live SSE path
    // threads for ConfirmSend round-trips.
    assert.equal(a.blocks[2].payload.messageId, "t1");
  }
});

test("rebuildUiTurns: known kind with shape-invalid props DROPS the directive block (pill stays)", () => {
  // W2 read-path trust-boundary regression. Persisted directives
  // whose envelope is fine but whose per-kind prop shape is wrong
  // must not reach the renderer — DirectiveRenderer casts props
  // straight into concrete types (`CampaignListProps`, etc.) with
  // no runtime guard, so a drifted row would crash the renderer.
  //
  // This covers:
  //   - Old rows written before Push 11's write-side validator
  //     landed.
  //   - Rows whose kind's prop schema evolved between write and
  //     read (schema drift).
  //   - Rows touched by manual DB repair / migration.
  //
  // The item here is MISSING required fields (`status`, `event_at`,
  // `venue`, `team_id`, `stats.*`) — envelope is valid, per-kind
  // shape is not.
  const directive = {
    kind: "campaign_list",
    props: { items: [{ id: "c1", name: "Royal Dinner" }] },
  };
  const turns = rebuildUiTurns([
    assistantRow("a1", "Here you go:"),
    toolRow("t1", "list_campaigns", {
      renderDirective: JSON.stringify(directive),
    }),
  ]);
  const a = asAssistant(turns[0]);
  // text + pill ONLY — directive was dropped, pill preserved so the
  // operator still sees that a tool ran.
  assert.equal(a.blocks.length, 2);
  assert.equal(a.blocks[0].type, "text");
  assert.equal(a.blocks[1].type, "tool");
});

test("rebuildUiTurns: unknown kind in renderDirective DROPS the directive block", () => {
  // Envelope-valid ({kind: string, props: {}}) but `kind` isn't in
  // the closed registry. The write-side validator would have
  // rejected this, so a row like this implies DB drift or
  // tampering — drop it on read to keep the renderer trust
  // boundary intact.
  const directive = {
    kind: "not_a_real_kind",
    props: { anything: true },
  };
  const turns = rebuildUiTurns([
    assistantRow("a1", ""),
    toolRow("t1", "list_campaigns", {
      renderDirective: JSON.stringify(directive),
    }),
  ]);
  const a = asAssistant(turns[0]);
  assert.equal(a.blocks.length, 1);
  assert.equal(a.blocks[0].type, "tool");
});

test("rebuildUiTurns: corrupt renderDirective JSON keeps the pill, drops only the directive block", () => {
  const turns = rebuildUiTurns([
    assistantRow("a1", ""),
    toolRow("t1", "list_campaigns", {
      renderDirective: "{not-json",
    }),
  ]);
  const a = asAssistant(turns[0]);
  // Just the pill — no directive block
  assert.equal(a.blocks.length, 1);
  assert.equal(a.blocks[0].type, "tool");
});

test("rebuildUiTurns: renderDirective missing 'kind' drops the directive block", () => {
  const turns = rebuildUiTurns([
    assistantRow("a1", ""),
    toolRow("t1", "list_campaigns", {
      renderDirective: JSON.stringify({ props: { items: [] } }),
    }),
  ]);
  const a = asAssistant(turns[0]);
  assert.equal(a.blocks.length, 1);
});

test("rebuildUiTurns: renderDirective missing 'props' drops the directive block", () => {
  const turns = rebuildUiTurns([
    assistantRow("a1", ""),
    toolRow("t1", "list_campaigns", {
      renderDirective: JSON.stringify({ kind: "campaign_list" }),
    }),
  ]);
  const a = asAssistant(turns[0]);
  assert.equal(a.blocks.length, 1);
});

test("rebuildUiTurns: renderDirective with array-as-props drops the directive block", () => {
  // defence-in-depth: our validator rejects array props too, but the
  // transform's shape check needs to hold even if a malformed row
  // slipped through an older codepath.
  const turns = rebuildUiTurns([
    assistantRow("a1", ""),
    toolRow("t1", "list_campaigns", {
      renderDirective: JSON.stringify({ kind: "campaign_list", props: [] }),
    }),
  ]);
  const a = asAssistant(turns[0]);
  assert.equal(a.blocks.length, 1);
});

// ---- streaming flag ----

test("rebuildUiTurns: every AssistantTurn has streaming=false", () => {
  const turns = rebuildUiTurns([
    assistantRow("a1", "first"),
    toolRow("t1", "list_campaigns"),
    userRow("u1", "more"),
    assistantRow("a2", "second"),
  ]);
  for (const t of turns) {
    if (t.kind === "assistant") {
      assert.equal(t.streaming, false);
    }
  }
});

// ---- id fidelity ----

test("rebuildUiTurns: turn ids match their source row ids", () => {
  const turns = rebuildUiTurns([
    userRow("user-uuid-1", "hello"),
    assistantRow("asst-uuid-1", "hi"),
  ]);
  assert.equal(turns[0].id, "user-uuid-1");
  assert.equal(turns[1].id, "asst-uuid-1");
});

// ---- mixed realistic transcript ----

test("rebuildUiTurns: realistic interleave (user, assistant+tool+directive, user, assistant)", () => {
  const rows: UiTranscriptRow[] = [
    userRow("u1", "show active campaigns"),
    assistantRow("a1", "Looking up active campaigns:"),
    toolRow("t1", "list_campaigns", {
      renderDirective: JSON.stringify({
        kind: "campaign_list",
        props: { items: [VALID_CAMPAIGN_ITEM] },
      }),
    }),
    userRow("u2", "thanks"),
    assistantRow("a2", "Anytime."),
  ];
  const turns = rebuildUiTurns(rows);
  assert.equal(turns.length, 4);
  const a1 = asAssistant(turns[1]);
  // text + pill + directive
  assert.equal(a1.blocks.length, 3);
  assert.equal(a1.blocks[0].type, "text");
  assert.equal(a1.blocks[1].type, "tool");
  assert.equal(a1.blocks[2].type, "directive");
  const a2 = asAssistant(turns[3]);
  assert.equal(a2.blocks.length, 1);
  assert.equal(a2.blocks[0].type, "text");
});
