import type {
  AIRuntime,
  ChatStreamRequest,
  InternalMessage,
  InternalStreamEvent,
  InternalSystemBlock,
  InternalTool,
  StopReason,
} from "./types";

// OpenRouter runtime. Implements the same internal contract as the
// Anthropic runtime, talking to OpenRouter's OpenAI-compatible
// chat-completions endpoint.
//
// Why this file exists (P2):
//   - The route already depends on the internal types (P1). This is
//     the second concrete backend behind the same seam, selectable
//     via `AI_RUNTIME=openrouter`.
//   - OpenRouter is OpenAI-schema-compatible: `POST /api/v1/chat/
//     completions`, Bearer auth, SSE with `stream: true`, plus two
//     optional identification headers (`HTTP-Referer`, `X-Title`)
//     that OpenRouter uses for analytics — they are not required
//     for auth but help us show up in their dashboard.
//
// Behavioral notes vs Anthropic:
//   - Prompt caching: OpenRouter offers provider-side caching we
//     can't steer from the request body. `cacheBreakpoint` markers
//     on system/tool blocks are DROPPED. Documented in the roadmap
//     as the one cleanly-irreducible Anthropic behavior.
//   - System blocks: flattened to a single `{ role: "system" }`
//     message (joined by `\n\n`) and prepended. Semantically equal
//     for our usage — we don't rely on per-block metadata.
//   - Tool calls: OpenAI's `tool_calls[i].index` identifies a tool
//     call within the assistant's message. We offset by +1 so text
//     (always index 0) and tool calls (index ≥ 1) don't collide.
//   - Stream termination: OpenAI SSE ends with `data: [DONE]`.
//   - Model id: OpenRouter uses namespaced ids (e.g.
//     `anthropic/claude-sonnet-4-6`, `openai/gpt-4o`). The incoming
//     `request.model` is Anthropic-native today, so we IGNORE it
//     and substitute the env-provided `OPENROUTER_MODEL`. This is
//     called out in the roadmap ("initial model choice should be
//     env-driven").

export type OpenRouterRuntimeOptions = {
  apiKey: string;
  model: string;
  httpReferer?: string;
  xTitle?: string;
  // Test seam — swap fetch to feed a canned SSE response body.
  fetchImpl?: typeof fetch;
  // Endpoint override is exposed but defaulted to the public URL.
  // Lets a proxy or a record/replay test rig point elsewhere
  // without re-implementing the whole wrapper.
  endpoint?: string;
};

export function createOpenRouterRuntime(opts: OpenRouterRuntimeOptions): AIRuntime {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const endpoint = opts.endpoint ?? "https://openrouter.ai/api/v1/chat/completions";

  return {
    name: "openrouter",
    async *stream(request: ChatStreamRequest): AsyncIterable<InternalStreamEvent> {
      const body = toOpenRouterRequest(request, opts.model);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      };
      if (opts.httpReferer) headers["HTTP-Referer"] = opts.httpReferer;
      if (opts.xTitle) headers["X-Title"] = opts.xTitle;

      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        const preview = await res.text().catch(() => "");
        throw new Error(`openrouter_http_${res.status}: ${preview.slice(0, 200)}`);
      }

      yield* parseOpenRouterStream(res.body);
    },
  };
}

// ---- request translation --------------------------------------------

export type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "tool"; tool_call_id: string; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };

export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export function toOpenRouterRequest(
  request: ChatStreamRequest,
  model: string,
): Record<string, unknown> {
  const messages: OpenAIMessage[] = [];
  const system = toSystemMessage(request.system);
  if (system) messages.push(system);
  for (const m of toOpenAIMessages(request.messages)) messages.push(m);

  const body: Record<string, unknown> = {
    model,
    max_tokens: request.maxTokens,
    messages,
    stream: true,
  };
  if (request.tools.length > 0) {
    body.tools = toOpenAITools(request.tools);
  }
  return body;
}

export function toSystemMessage(blocks: InternalSystemBlock[]): OpenAIMessage | null {
  if (blocks.length === 0) return null;
  // `cacheBreakpoint` is dropped — OpenRouter doesn't expose
  // request-level cache steering. We concatenate text because
  // the semantic "here's the system context" is block-order-
  // sensitive, not block-count-sensitive.
  const content = blocks.map((b) => b.text).join("\n\n");
  return { role: "system", content };
}

export function toOpenAITools(tools: InternalTool[]): OpenAITool[] {
  // `cacheBreakpoint` on the last tool is dropped (see above).
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

export function toOpenAIMessages(messages: InternalMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      if (typeof m.content === "string") {
        out.push({ role: "user", content: m.content });
        continue;
      }
      // Tool results become one `role: tool` message per block.
      // OpenAI requires tool messages to carry `tool_call_id`; the
      // internal block already does.
      for (const r of m.content) {
        out.push({ role: "tool", tool_call_id: r.tool_use_id, content: r.content });
      }
      continue;
    }
    // assistant — split the block list into text-parts and
    // tool-parts. `content` is the text concat (or null if none),
    // `tool_calls` is the ordered function-call array.
    const textParts: string[] = [];
    const toolCalls: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }> = [];
    for (const b of m.content) {
      if (b.type === "text") {
        textParts.push(b.text);
      } else {
        toolCalls.push({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
      }
    }
    const msg: OpenAIMessage = {
      role: "assistant",
      content: textParts.length > 0 ? textParts.join("") : null,
    };
    if (toolCalls.length > 0) {
      msg.tool_calls = toolCalls;
    }
    out.push(msg);
  }
  return out;
}

// ---- stream parser --------------------------------------------------

// OpenAI-compatible streaming chunk shape. We only read the fields we
// need; unknown fields are left alone. Keeping this loose on purpose
// — different providers behind OpenRouter add vendor extensions.
type OpenAIStreamChunk = {
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
};

export async function* parseOpenRouterStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<InternalStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const seenToolIndices = new Set<number>();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const ev of handleFrame(frame, seenToolIndices)) yield ev;
      }
    }
    const tail = buffer.trim();
    if (tail.length > 0) {
      for (const ev of handleFrame(tail, seenToolIndices)) yield ev;
    }
  } finally {
    reader.releaseLock();
  }
}

function* handleFrame(
  frame: string,
  seenToolIndices: Set<number>,
): Generator<InternalStreamEvent> {
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    dataLines.push(value);
  }
  if (dataLines.length === 0) return;
  const payload = dataLines.join("\n").trim();
  if (payload.length === 0) return;
  if (payload === "[DONE]") return;

  let chunk: OpenAIStreamChunk;
  try {
    chunk = JSON.parse(payload) as OpenAIStreamChunk;
  } catch {
    // Silently skip unparseable frames — OpenRouter occasionally
    // emits vendor-specific non-JSON keep-alives we can ignore.
    return;
  }

  const choice = chunk.choices?.[0];
  if (!choice) return;

  const delta = choice.delta;
  if (delta) {
    if (typeof delta.content === "string" && delta.content.length > 0) {
      yield { type: "text_delta", index: 0, text: delta.content };
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        // Offset by +1 so text (index 0) never collides with tools.
        const internalIndex = tc.index + 1;
        if (!seenToolIndices.has(tc.index)) {
          // Start event: only emit once per tool-call index. The id
          // and name typically land on the first chunk; if the
          // upstream provider splits them, we accept whichever we
          // see first here. A missing id/name falls back to empty
          // string — consumers treat blanks as malformed but don't
          // crash.
          seenToolIndices.add(tc.index);
          yield {
            type: "tool_use_start",
            index: internalIndex,
            id: tc.id ?? "",
            name: tc.function?.name ?? "",
          };
        }
        const args = tc.function?.arguments;
        if (typeof args === "string" && args.length > 0) {
          yield {
            type: "tool_input_delta",
            index: internalIndex,
            partialJson: args,
          };
        }
      }
    }
  }

  if (choice.finish_reason) {
    yield { type: "stop", reason: mapFinishReason(choice.finish_reason) };
  }
}

export function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "stop_sequence";
    default:
      return null;
  }
}
