import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createAnthropicRuntime,
  toBetaMessages,
  toBetaTools,
  toSystemBlocks,
  type AnthropicClientLike,
} from "../../src/lib/ai/runtime/anthropic";
import type {
  InternalMessage,
  InternalStreamEvent,
  InternalSystemBlock,
  InternalTool,
} from "../../src/lib/ai/runtime/types";

// P1 — Anthropic runtime wrapper.
//
// This file pins the seam translation so a future refactor can't
// silently drop prompt-caching markers or reshape the assistant
// content path. The three pure mappers get direct coverage; the
// full stream() integration gets a fake SDK client whose message
// stream yields the same event shapes the real SDK does.
//
// The fake is important: if these tests imported `@anthropic-ai/
// sdk` for real they'd cross a hidden network boundary. The
// wrapper exposes a `clientFactory` option exactly so tests stay
// hermetic.

// ---- toSystemBlocks ----

test("toSystemBlocks: passes text through and marks cacheBreakpoint as ephemeral", () => {
  const internal: InternalSystemBlock[] = [
    { type: "text", text: "static", cacheBreakpoint: true },
    { type: "text", text: "dynamic" },
  ];
  const out = toSystemBlocks(internal);
  assert.equal(out.length, 2);
  assert.equal(out[0].type, "text");
  assert.equal(out[0].text, "static");
  assert.deepEqual(out[0].cache_control, { type: "ephemeral" });
  assert.equal(out[1].text, "dynamic");
  assert.equal(
    out[1].cache_control,
    undefined,
    "second block must not carry a cache marker",
  );
});

test("toSystemBlocks: empty input produces empty output", () => {
  assert.deepEqual(toSystemBlocks([]), []);
});

// ---- toBetaTools ----

test("toBetaTools: carries name/description/input_schema and cacheBreakpoint only on marked entries", () => {
  const tools: InternalTool[] = [
    {
      name: "first",
      description: "first tool",
      inputSchema: { type: "object" } as Record<string, unknown>,
    },
    {
      name: "last",
      description: "last tool",
      inputSchema: { type: "object" } as Record<string, unknown>,
      cacheBreakpoint: true,
    },
  ];
  const out = toBetaTools(tools) as Array<{
    name: string;
    description: string;
    input_schema: unknown;
    cache_control?: { type: "ephemeral" };
  }>;
  assert.equal(out.length, 2);
  assert.equal(out[0].name, "first");
  assert.equal(out[0].description, "first tool");
  assert.deepEqual(out[0].input_schema, { type: "object" });
  assert.equal(
    out[0].cache_control,
    undefined,
    "first tool not marked — no cache_control",
  );
  assert.equal(out[1].name, "last");
  assert.deepEqual(out[1].cache_control, { type: "ephemeral" });
});

// ---- toBetaMessages ----

test("toBetaMessages: user text turn passes through as plain content", () => {
  const msgs: InternalMessage[] = [{ role: "user", content: "hello" }];
  const out = toBetaMessages(msgs) as Array<{
    role: string;
    content: unknown;
  }>;
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "user");
  assert.equal(out[0].content, "hello");
});

test("toBetaMessages: user tool_result turn maps content array + preserves is_error", () => {
  const msgs: InternalMessage[] = [
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "ok" },
        {
          type: "tool_result",
          tool_use_id: "b",
          content: "bad",
          is_error: true,
        },
      ],
    },
  ];
  const out = toBetaMessages(msgs) as Array<{
    role: string;
    content: Array<{
      type: string;
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }>;
  }>;
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "user");
  assert.equal(out[0].content.length, 2);
  assert.equal(out[0].content[0].type, "tool_result");
  assert.equal(out[0].content[0].tool_use_id, "a");
  assert.equal(out[0].content[0].content, "ok");
  assert.equal(
    out[0].content[0].is_error,
    undefined,
    "successful result must NOT carry is_error (false would still set is_error=true under truthy-check at the next boundary)",
  );
  assert.equal(out[0].content[1].is_error, true);
});

test("toBetaMessages: assistant turn maps text + tool_use blocks with stable ids", () => {
  const msgs: InternalMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "thinking" },
        {
          type: "tool_use",
          id: "toolu_123",
          name: "list_campaigns",
          input: { limit: 10 },
        },
      ],
    },
  ];
  const out = toBetaMessages(msgs) as Array<{
    role: string;
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
  }>;
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "assistant");
  assert.equal(out[0].content.length, 2);
  assert.equal(out[0].content[0].type, "text");
  assert.equal(out[0].content[0].text, "thinking");
  assert.equal(out[0].content[1].type, "tool_use");
  assert.equal(out[0].content[1].id, "toolu_123");
  assert.equal(out[0].content[1].name, "list_campaigns");
  assert.deepEqual(out[0].content[1].input, { limit: 10 });
});

// ---- stream() event translation ----
//
// The fake client yields the exact event shapes the real Anthropic
// SDK emits (`content_block_start` / `content_block_delta` /
// `message_delta`). The wrapper converts them into our internal
// discriminated union. We pin each mapping so a silent regression
// (dropped `tool_input_delta`, wrong `index`, missing `stop`) blows
// up a test instead of a production turn.

type SdkEvent =
  | {
      type: "content_block_start";
      index: number;
      content_block:
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: unknown };
    }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason: string | null };
    }
  | { type: "message_start" }
  | { type: "message_stop" };

function fakeClient(events: SdkEvent[]): AnthropicClientLike {
  return {
    beta: {
      messages: {
        create: async () => {
          return (async function* () {
            for (const ev of events) yield ev;
          })();
        },
      },
    },
  };
}

async function collect(
  stream: AsyncIterable<InternalStreamEvent>,
): Promise<InternalStreamEvent[]> {
  const out: InternalStreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

test("stream: forwards text_delta events with their index", async () => {
  const events: SdkEvent[] = [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hi " },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "there" },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ];
  const runtime = createAnthropicRuntime({
    apiKey: "test",
    clientFactory: () => fakeClient(events),
  });
  const out = await collect(
    runtime.stream({
      model: "m",
      maxTokens: 1,
      system: [],
      tools: [],
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.deepEqual(out, [
    { type: "text_delta", index: 0, text: "hi " },
    { type: "text_delta", index: 0, text: "there" },
    { type: "stop", reason: "end_turn" },
  ]);
});

test("stream: emits tool_use_start + tool_input_delta + stop=tool_use", async () => {
  const events: SdkEvent[] = [
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_abc",
        name: "draft_campaign",
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"tit' },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: 'le":"x"}' },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
  ];
  const runtime = createAnthropicRuntime({
    apiKey: "test",
    clientFactory: () => fakeClient(events),
  });
  const out = await collect(
    runtime.stream({
      model: "m",
      maxTokens: 1,
      system: [],
      tools: [],
      messages: [{ role: "user", content: "x" }],
    }),
  );
  assert.deepEqual(out, [
    {
      type: "tool_use_start",
      index: 0,
      id: "toolu_abc",
      name: "draft_campaign",
    },
    { type: "tool_input_delta", index: 0, partialJson: '{"tit' },
    { type: "tool_input_delta", index: 0, partialJson: 'le":"x"}' },
    { type: "stop", reason: "tool_use" },
  ]);
});

test("stream: does not emit a stop event when stop_reason is null", async () => {
  const events: SdkEvent[] = [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "a" },
    },
    { type: "message_delta", delta: { stop_reason: null } },
  ];
  const runtime = createAnthropicRuntime({
    apiKey: "test",
    clientFactory: () => fakeClient(events),
  });
  const out = await collect(
    runtime.stream({
      model: "m",
      maxTokens: 1,
      system: [],
      tools: [],
      messages: [{ role: "user", content: "x" }],
    }),
  );
  assert.equal(
    out.some((e) => e.type === "stop"),
    false,
    "null stop_reason must not produce a stop event",
  );
});

test("stream: passes the request through to the SDK (model, maxTokens, betas)", async () => {
  let captured: Record<string, unknown> | null = null;
  const client: AnthropicClientLike = {
    beta: {
      messages: {
        create: async (args) => {
          captured = args;
          return (async function* () {
            yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
          })();
        },
      },
    },
  };
  const runtime = createAnthropicRuntime({
    apiKey: "test",
    clientFactory: () => client,
  });
  await collect(
    runtime.stream({
      model: "claude-3-5-sonnet-latest",
      maxTokens: 4096,
      system: [{ type: "text", text: "sys", cacheBreakpoint: true }],
      tools: [
        {
          name: "t",
          description: "d",
          inputSchema: { type: "object" },
          cacheBreakpoint: true,
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    }),
  );
  assert.ok(captured, "SDK.create must have been invoked");
  const c = captured as Record<string, unknown>;
  assert.equal(c.model, "claude-3-5-sonnet-latest");
  assert.equal(c.max_tokens, 4096);
  assert.equal(c.stream, true);
  assert.deepEqual(c.betas, ["prompt-caching-2024-07-31"]);
  const system = c.system as Array<{ cache_control?: unknown }>;
  assert.deepEqual(system[0].cache_control, { type: "ephemeral" });
  const tools = c.tools as Array<{ cache_control?: unknown }>;
  assert.deepEqual(tools[0].cache_control, { type: "ephemeral" });
});
