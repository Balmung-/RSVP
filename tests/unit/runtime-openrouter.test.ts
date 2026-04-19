import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createOpenRouterRuntime,
  mapFinishReason,
  parseOpenRouterStream,
  toOpenAIMessages,
  toOpenAITools,
  toOpenRouterRequest,
  toSystemMessage,
} from "../../src/lib/ai/runtime/openrouter";
import type {
  ChatStreamRequest,
  InternalMessage,
  InternalStreamEvent,
  InternalSystemBlock,
  InternalTool,
} from "../../src/lib/ai/runtime/types";

// P2 — OpenRouter runtime.
//
// Three test surfaces:
//   1. Pure request mappers (system/tools/messages) — pin the
//      OpenAI-schema shape so a future OpenRouter schema drift
//      fails here, not in production.
//   2. Pure SSE parser — feed canned `data: ...` frames through
//      `parseOpenRouterStream` and assert the internal event
//      sequence matches what the route expects.
//   3. Full stream() integration with a fake fetch — proves the
//      wrapper wires endpoint, headers, auth, and body correctly.

// ---- toSystemMessage ----------------------------------------------

test("toSystemMessage: empty input returns null", () => {
  assert.equal(toSystemMessage([]), null);
});

test("toSystemMessage: concatenates blocks with blank-line separator", () => {
  const blocks: InternalSystemBlock[] = [
    { type: "text", text: "Alpha" },
    { type: "text", text: "Beta" },
  ];
  const msg = toSystemMessage(blocks);
  assert.ok(msg && msg.role === "system");
  if (msg && msg.role === "system") {
    assert.equal(msg.content, "Alpha\n\nBeta");
  }
});

test("toSystemMessage: cacheBreakpoint is dropped (OpenRouter has no request-level caching)", () => {
  const blocks: InternalSystemBlock[] = [
    { type: "text", text: "static", cacheBreakpoint: true },
    { type: "text", text: "dynamic" },
  ];
  const msg = toSystemMessage(blocks);
  assert.ok(msg);
  const bag = msg as unknown as Record<string, unknown>;
  assert.equal(bag.cache_control, undefined);
  assert.equal(bag.cacheBreakpoint, undefined);
});

// ---- toOpenAITools -------------------------------------------------

test("toOpenAITools: wraps each tool in { type: function, function: {...} }", () => {
  const tools: InternalTool[] = [
    {
      name: "search_contacts",
      description: "Search the contact directory.",
      inputSchema: {
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      },
    },
  ];
  const out = toOpenAITools(tools);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "function");
  assert.equal(out[0].function.name, "search_contacts");
  assert.equal(out[0].function.description, "Search the contact directory.");
  assert.deepEqual(out[0].function.parameters, {
    type: "object",
    properties: { q: { type: "string" } },
    required: ["q"],
  });
});

test("toOpenAITools: cacheBreakpoint markers are stripped", () => {
  const tools: InternalTool[] = [
    { name: "a", description: "", inputSchema: {}, cacheBreakpoint: true },
  ];
  const out = toOpenAITools(tools);
  const bag = out[0] as unknown as Record<string, unknown>;
  assert.equal(bag.cache_control, undefined);
  assert.equal(bag.cacheBreakpoint, undefined);
});

// ---- toOpenAIMessages ----------------------------------------------

test("toOpenAIMessages: plain user text passes through as role=user", () => {
  const msgs: InternalMessage[] = [{ role: "user", content: "hello" }];
  const out = toOpenAIMessages(msgs);
  assert.deepEqual(out, [{ role: "user", content: "hello" }]);
});

test("toOpenAIMessages: tool_result user content expands to role=tool messages", () => {
  const msgs: InternalMessage[] = [
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "ok: 3" },
        { type: "tool_result", tool_use_id: "call_2", content: "fail", is_error: true },
      ],
    },
  ];
  const out = toOpenAIMessages(msgs);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { role: "tool", tool_call_id: "call_1", content: "ok: 3" });
  assert.deepEqual(out[1], { role: "tool", tool_call_id: "call_2", content: "fail" });
});

test("toOpenAIMessages: assistant text-only becomes role=assistant content=<text>", () => {
  const msgs: InternalMessage[] = [
    { role: "assistant", content: [{ type: "text", text: "Working on it." }] },
  ];
  const out = toOpenAIMessages(msgs);
  assert.equal(out.length, 1);
  const m = out[0] as { role: string; content: string | null; tool_calls?: unknown };
  assert.equal(m.role, "assistant");
  assert.equal(m.content, "Working on it.");
  assert.equal(m.tool_calls, undefined);
});

test("toOpenAIMessages: assistant with tool_use renders tool_calls + JSON-stringified arguments", () => {
  const msgs: InternalMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "Searching." },
        {
          type: "tool_use",
          id: "call_9",
          name: "search_contacts",
          input: { q: "ali" },
        },
      ],
    },
  ];
  const out = toOpenAIMessages(msgs);
  assert.equal(out.length, 1);
  const m = out[0] as {
    role: string;
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
  };
  assert.equal(m.content, "Searching.");
  assert.ok(m.tool_calls);
  if (m.tool_calls) {
    assert.equal(m.tool_calls.length, 1);
    assert.equal(m.tool_calls[0].id, "call_9");
    assert.equal(m.tool_calls[0].type, "function");
    assert.equal(m.tool_calls[0].function.name, "search_contacts");
    assert.equal(m.tool_calls[0].function.arguments, JSON.stringify({ q: "ali" }));
  }
});

test("toOpenAIMessages: assistant tool_use with no text yields content=null", () => {
  const msgs: InternalMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_10", name: "noop", input: {} },
      ],
    },
  ];
  const out = toOpenAIMessages(msgs);
  const m = out[0] as { content: string | null };
  assert.equal(m.content, null);
});

// ---- toOpenRouterRequest (composition) -----------------------------

test("toOpenRouterRequest: wires model + max_tokens + stream=true", () => {
  const req: ChatStreamRequest = {
    model: "claude-3-5-sonnet-latest", // substituted — OpenRouter uses its own model id
    maxTokens: 1024,
    system: [{ type: "text", text: "You are helpful." }],
    tools: [],
    messages: [{ role: "user", content: "hi" }],
  };
  const body = toOpenRouterRequest(req, "anthropic/claude-sonnet-4-6");
  assert.equal(body.model, "anthropic/claude-sonnet-4-6");
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.stream, true);
  const messages = body.messages as Array<{ role: string; content: string | null }>;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].role, "user");
  // Empty tools → omit `tools` entirely (OpenAI spec allows it but
  // omission is cleaner; confirms no accidental empty array).
  assert.equal((body as Record<string, unknown>).tools, undefined);
});

test("toOpenRouterRequest: non-empty tools land under `tools`", () => {
  const req: ChatStreamRequest = {
    model: "x",
    maxTokens: 100,
    system: [],
    tools: [{ name: "t", description: "d", inputSchema: {} }],
    messages: [{ role: "user", content: "hi" }],
  };
  const body = toOpenRouterRequest(req, "openai/gpt-4o");
  const tools = body.tools as Array<{ type: string; function: { name: string } }>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].function.name, "t");
});

// ---- parseOpenRouterStream -----------------------------------------

function makeStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= frames.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(frames[i]));
      i += 1;
    },
  });
}

async function collect(
  stream: AsyncIterable<InternalStreamEvent>,
): Promise<InternalStreamEvent[]> {
  const out: InternalStreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

test("parseOpenRouterStream: content deltas emit text_delta on index 0", async () => {
  const body = makeStream([
    'data: {"choices":[{"delta":{"role":"assistant","content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const events = await collect(parseOpenRouterStream(body));
  assert.deepEqual(events, [
    { type: "text_delta", index: 0, text: "Hello" },
    { type: "text_delta", index: 0, text: " world" },
    { type: "stop", reason: "end_turn" },
  ]);
});

test("parseOpenRouterStream: tool_calls emit start + arg deltas, offset by +1", async () => {
  const body = makeStream([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\":\\"ali\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const events = await collect(parseOpenRouterStream(body));
  assert.equal(events.length, 4);
  assert.deepEqual(events[0], { type: "tool_use_start", index: 1, id: "call_1", name: "search" });
  assert.deepEqual(events[1], { type: "tool_input_delta", index: 1, partialJson: '{"q' });
  assert.deepEqual(events[2], { type: "tool_input_delta", index: 1, partialJson: '":"ali"}' });
  assert.deepEqual(events[3], { type: "stop", reason: "tool_use" });
});

test("parseOpenRouterStream: two distinct tool calls get separate indices (1 and 2)", async () => {
  const body = makeStream([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"a","arguments":"{}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"b","arguments":"{}"}}]}}]}\n\n',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const events = await collect(parseOpenRouterStream(body));
  const starts = events.filter((e) => e.type === "tool_use_start");
  assert.equal(starts.length, 2);
  if (starts[0].type === "tool_use_start" && starts[1].type === "tool_use_start") {
    assert.equal(starts[0].index, 1);
    assert.equal(starts[0].id, "call_a");
    assert.equal(starts[1].index, 2);
    assert.equal(starts[1].id, "call_b");
  }
});

test("parseOpenRouterStream: chunks arriving in fragments still frame correctly", async () => {
  const body = makeStream([
    'data: {"choices":[{"delta":{"content":"A"',
    '}}]}\n\ndata: {"choices":[{"delta":{"content":"B"}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const events = await collect(parseOpenRouterStream(body));
  assert.deepEqual(events, [
    { type: "text_delta", index: 0, text: "A" },
    { type: "text_delta", index: 0, text: "B" },
  ]);
});

test("parseOpenRouterStream: unparseable data frames are skipped, not fatal", async () => {
  const body = makeStream([
    'data: {not json}\n\n',
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const events = await collect(parseOpenRouterStream(body));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: "text_delta", index: 0, text: "ok" });
});

test("parseOpenRouterStream: [DONE] sentinel is swallowed (no stop event emitted)", async () => {
  const body = makeStream(["data: [DONE]\n\n"]);
  const events = await collect(parseOpenRouterStream(body));
  assert.equal(events.length, 0);
});

test("parseOpenRouterStream: CRLF line endings parse the same as LF", async () => {
  const body = makeStream([
    'data: {"choices":[{"delta":{"content":"x"}}]}\r\n\r\ndata: [DONE]\r\n\r\n',
  ]);
  const events = await collect(parseOpenRouterStream(body));
  assert.equal(events.length, 1);
});

// ---- mapFinishReason -----------------------------------------------

test("mapFinishReason: OpenAI → internal mapping", () => {
  assert.equal(mapFinishReason("stop"), "end_turn");
  assert.equal(mapFinishReason("length"), "max_tokens");
  assert.equal(mapFinishReason("tool_calls"), "tool_use");
  assert.equal(mapFinishReason("function_call"), "tool_use");
  assert.equal(mapFinishReason("content_filter"), "stop_sequence");
  assert.equal(mapFinishReason("nonsense"), null);
});

// ---- full stream integration (fake fetch) --------------------------

type FetchCall = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

function fakeFetch(
  frames: string[],
  captured: FetchCall[],
  opts: { status?: number } = {},
): typeof fetch {
  const status = opts.status ?? 200;
  return ((input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k] = h[k];
    }
    captured.push({
      url,
      method: init?.method,
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      body: makeStream(frames),
      text: async () => "",
    } as unknown as Response);
  }) as unknown as typeof fetch;
}

test("stream(): posts to endpoint with Bearer auth and JSON body", async () => {
  const captured: FetchCall[] = [];
  const runtime = createOpenRouterRuntime({
    apiKey: "sk-or-xxx",
    model: "anthropic/claude-sonnet-4-6",
    httpReferer: "https://rsvp.example",
    xTitle: "Einai RSVP",
    fetchImpl: fakeFetch([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ], captured),
  });

  const events: InternalStreamEvent[] = [];
  for await (const ev of runtime.stream({
    model: "ignored-by-openrouter",
    maxTokens: 256,
    system: [],
    tools: [],
    messages: [{ role: "user", content: "hi" }],
  })) {
    events.push(ev);
  }

  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(captured[0].method, "POST");
  assert.equal(captured[0].headers?.Authorization, "Bearer sk-or-xxx");
  assert.equal(captured[0].headers?.["Content-Type"], "application/json");
  assert.equal(captured[0].headers?.["HTTP-Referer"], "https://rsvp.example");
  assert.equal(captured[0].headers?.["X-Title"], "Einai RSVP");

  const body = JSON.parse(captured[0].body ?? "{}");
  assert.equal(body.model, "anthropic/claude-sonnet-4-6");
  assert.equal(body.max_tokens, 256);
  assert.equal(body.stream, true);

  assert.equal(events.length, 2);
  assert.equal(events[0].type, "text_delta");
  assert.equal(events[1].type, "stop");
});

test("stream(): non-2xx response throws with status + preview", async () => {
  const captured: FetchCall[] = [];
  const runtime = createOpenRouterRuntime({
    apiKey: "k",
    model: "x",
    fetchImpl: fakeFetch([], captured, { status: 402 }),
  });
  await assert.rejects(
    (async () => {
      for await (const _ of runtime.stream({
        model: "x",
        maxTokens: 10,
        system: [],
        tools: [],
        messages: [{ role: "user", content: "hi" }],
      })) {
        // no-op
      }
    })(),
    /openrouter_http_402/,
  );
});

test("stream(): optional headers omitted when not provided", async () => {
  const captured: FetchCall[] = [];
  const runtime = createOpenRouterRuntime({
    apiKey: "k",
    model: "m",
    fetchImpl: fakeFetch(["data: [DONE]\n\n"], captured),
  });
  const it = runtime.stream({
    model: "x",
    maxTokens: 10,
    system: [],
    tools: [],
    messages: [{ role: "user", content: "hi" }],
  });
  for await (const _ of it) {
    /* drain */
  }
  assert.equal(captured[0].headers?.["HTTP-Referer"], undefined);
  assert.equal(captured[0].headers?.["X-Title"], undefined);
});

test("runtime.name is 'openrouter'", () => {
  const runtime = createOpenRouterRuntime({ apiKey: "k", model: "m" });
  assert.equal(runtime.name, "openrouter");
});
