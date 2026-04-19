import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "@prisma/client";

import {
  rebuildMessages,
  assistantTurnFromBlocks,
} from "../../src/lib/ai/transcript";
import type {
  InternalAssistantContent,
  InternalMessage,
} from "../../src/lib/ai/runtime/types";

// P1 — transcript module speaks internal runtime types now.
//
// The rebuild logic itself is unchanged from the Anthropic-only era,
// but the output shape is. These tests pin:
//   - user rows become `{role: "user", content: string}`
//   - assistant + trailing tool rows collapse into one assistant
//     turn (mixed text + tool_use blocks) followed by a user turn
//     carrying the tool_results
//   - is_error is preserved so destructive short-circuits replay
//     as errors and not successes
//   - the degenerate empty-assistant case gets a single-space text
//     block so the provider doesn't reject the turn

type Row = Partial<ChatMessage> & {
  id: string;
  sessionId: string;
  role: string;
};

function row(r: Row): ChatMessage {
  return {
    id: r.id,
    sessionId: r.sessionId,
    role: r.role,
    content: r.content ?? null,
    createdAt: r.createdAt ?? new Date(),
    toolName: r.toolName ?? null,
    toolInput: r.toolInput ?? null,
    toolOutput: r.toolOutput ?? null,
    renderDirective: r.renderDirective ?? null,
    isError: r.isError ?? false,
  } as ChatMessage;
}

test("rebuildMessages: user-only history yields a single user message", () => {
  const rows = [row({ id: "a", sessionId: "s", role: "user", content: "hi" })];
  const out = rebuildMessages(rows);
  assert.deepEqual(out, [{ role: "user", content: "hi" }]);
});

test("rebuildMessages: assistant + tool rows collapse into one turn + tool_result user turn", () => {
  const rows = [
    row({ id: "u1", sessionId: "s", role: "user", content: "what's up" }),
    row({
      id: "a1",
      sessionId: "s",
      role: "assistant",
      content: "looking into it",
    }),
    row({
      id: "t1",
      sessionId: "s",
      role: "tool",
      toolName: "list_campaigns",
      toolInput: '{"limit":5}',
      toolOutput: '{"count":2}',
      content: "summary",
    }),
  ];
  const out = rebuildMessages(rows);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { role: "user", content: "what's up" });
  const assistant = out[1] as Extract<InternalMessage, { role: "assistant" }>;
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.content.length, 2);
  assert.deepEqual(assistant.content[0], {
    type: "text",
    text: "looking into it",
  });
  assert.deepEqual(assistant.content[1], {
    type: "tool_use",
    id: "toolu_t1",
    name: "list_campaigns",
    input: { limit: 5 },
  });
  const toolResultTurn = out[2] as Extract<
    InternalMessage,
    { role: "user"; content: unknown[] }
  >;
  assert.equal(toolResultTurn.role, "user");
  assert.equal(Array.isArray(toolResultTurn.content), true);
  const results = toolResultTurn.content as Array<{
    type: string;
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  }>;
  assert.equal(results.length, 1);
  assert.equal(results[0].type, "tool_result");
  assert.equal(results[0].tool_use_id, "toolu_t1");
  assert.equal(results[0].content, '{"count":2}');
  assert.equal(
    results[0].is_error,
    undefined,
    "successful tool row must not carry is_error",
  );
});

test("rebuildMessages: tool-row with isError=true preserves is_error on replay", () => {
  const rows = [
    row({
      id: "a1",
      sessionId: "s",
      role: "assistant",
      content: "trying",
    }),
    row({
      id: "t1",
      sessionId: "s",
      role: "tool",
      toolName: "send_campaign",
      toolInput: "{}",
      toolOutput: '{"error":"needs_confirmation"}',
      content: "error: needs_confirmation",
      isError: true,
    }),
  ];
  const out = rebuildMessages(rows);
  assert.equal(out.length, 2);
  const toolResultTurn = out[1] as Extract<
    InternalMessage,
    { role: "user"; content: unknown[] }
  >;
  const results = toolResultTurn.content as Array<{
    is_error?: boolean;
  }>;
  assert.equal(results[0].is_error, true);
});

test("rebuildMessages: empty assistant row gets single-space text block fallback", () => {
  const rows = [
    row({ id: "a1", sessionId: "s", role: "assistant", content: "" }),
  ];
  const out = rebuildMessages(rows);
  assert.equal(out.length, 1);
  const assistant = out[0] as Extract<InternalMessage, { role: "assistant" }>;
  assert.equal(assistant.content.length, 1);
  assert.deepEqual(assistant.content[0], { type: "text", text: " " });
});

test("rebuildMessages: orphan tool row is skipped, not injected", () => {
  const rows = [
    row({
      id: "t1",
      sessionId: "s",
      role: "tool",
      toolName: "list_campaigns",
      toolInput: "{}",
      toolOutput: "ok",
    }),
    row({ id: "u1", sessionId: "s", role: "user", content: "hi" }),
  ];
  const out = rebuildMessages(rows);
  assert.deepEqual(out, [{ role: "user", content: "hi" }]);
});

test("assistantTurnFromBlocks: empty input gets a single-space text fallback", () => {
  const out = assistantTurnFromBlocks([]);
  assert.deepEqual(out, {
    role: "assistant",
    content: [{ type: "text", text: " " }],
  });
});

test("assistantTurnFromBlocks: preserves text + tool_use blocks with live ids", () => {
  const blocks: InternalAssistantContent = [
    { type: "text", text: "thinking" },
    {
      type: "tool_use",
      id: "toolu_live_123",
      name: "draft_campaign",
      input: { title: "Gala", locale: "ar" },
    },
  ];
  const out = assistantTurnFromBlocks(blocks);
  assert.deepEqual(out, {
    role: "assistant",
    content: [
      { type: "text", text: "thinking" },
      {
        type: "tool_use",
        id: "toolu_live_123",
        name: "draft_campaign",
        input: { title: "Gala", locale: "ar" },
      },
    ],
  });
});

test("assistantTurnFromBlocks: non-object tool_use input is normalized to empty object", () => {
  const blocks: InternalAssistantContent = [
    {
      type: "tool_use",
      id: "toolu_x",
      name: "noop",
      input: null as unknown as Record<string, unknown>,
    },
  ];
  const out = assistantTurnFromBlocks(blocks);
  const content = out.content as Array<{
    type: string;
    input?: Record<string, unknown>;
  }>;
  assert.deepEqual(content[0].input, {});
});
