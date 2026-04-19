import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  BetaTextBlockParam,
  BetaTool,
  BetaToolUnion,
  BetaToolResultBlockParam,
  BetaToolUseBlockParam,
  BetaTextBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type {
  AIRuntime,
  ChatStreamRequest,
  InternalMessage,
  InternalStreamEvent,
  InternalSystemBlock,
  InternalTool,
} from "./types";

// Anthropic runtime. Wraps the SDK call that used to live inline in
// `/api/chat/route.ts` and translates the request/response at this
// boundary so the route can depend on the internal contract only.
//
// Behavioral guarantees (must not regress from the pre-seam route):
//   - `cache_control: { type: "ephemeral" }` lands on every system
//     block marked with `cacheBreakpoint` AND on the last tool with
//     `cacheBreakpoint` — same positions the old route set them.
//   - `betas: ["prompt-caching-2024-07-31"]` is sent on every
//     request (same as before).
//   - The stream yields text/tool_use/tool_result events in the same
//     ORDER the route expects, with the same `index` semantics.
//   - Parse errors on `input_json_delta` stay inline: the route
//     assembles the full partial_json string across deltas and only
//     parses at end-of-block.

// Production SDK factory. Exposed as a default so tests can substitute
// an in-memory stream source without mocking the real module.
export type AnthropicClientLike = {
  beta: {
    messages: {
      create: (args: Record<string, unknown>) => Promise<unknown>;
    };
  };
};

export type AnthropicRuntimeOptions = {
  apiKey: string;
  // Override for tests — in production, we construct a real SDK
  // client. The function is called once per runtime instance.
  clientFactory?: (apiKey: string) => AnthropicClientLike;
};

function defaultClientFactory(apiKey: string): AnthropicClientLike {
  return new Anthropic({ apiKey }) as unknown as AnthropicClientLike;
}

export function createAnthropicRuntime(
  opts: AnthropicRuntimeOptions,
): AIRuntime {
  const client = (opts.clientFactory ?? defaultClientFactory)(opts.apiKey);

  return {
    name: "anthropic",
    async *stream(
      request: ChatStreamRequest,
    ): AsyncIterable<InternalStreamEvent> {
      const apiStream = (await client.beta.messages.create({
        model: request.model,
        max_tokens: request.maxTokens,
        system: toSystemBlocks(request.system),
        tools: toBetaTools(request.tools),
        messages: toBetaMessages(request.messages),
        stream: true,
        betas: ["prompt-caching-2024-07-31"],
      })) as AsyncIterable<BetaRawMessageStreamEvent>;

      for await (const ev of apiStream) {
        if (ev.type === "content_block_start") {
          const block = ev.content_block;
          if (block.type === "tool_use") {
            yield {
              type: "tool_use_start",
              index: ev.index,
              id: block.id,
              name: block.name,
            };
          }
          // text blocks don't need a start event — the first
          // text_delta is enough for the route's accumulator.
          continue;
        }
        if (ev.type === "content_block_delta") {
          if (ev.delta.type === "text_delta") {
            yield { type: "text_delta", index: ev.index, text: ev.delta.text };
            continue;
          }
          if (ev.delta.type === "input_json_delta") {
            yield {
              type: "tool_input_delta",
              index: ev.index,
              partialJson: ev.delta.partial_json,
            };
            continue;
          }
          continue;
        }
        if (ev.type === "message_delta") {
          if (ev.delta.stop_reason) {
            yield { type: "stop", reason: ev.delta.stop_reason };
          }
          continue;
        }
        // content_block_stop / message_start / message_stop — nothing to yield
      }
    },
  };
}

// ---- request-side translation ----

export function toSystemBlocks(
  blocks: InternalSystemBlock[],
): BetaTextBlockParam[] {
  return blocks.map((b) => {
    const out: BetaTextBlockParam = { type: "text", text: b.text };
    if (b.cacheBreakpoint) {
      out.cache_control = { type: "ephemeral" };
    }
    return out;
  });
}

export function toBetaTools(tools: InternalTool[]): BetaToolUnion[] {
  return tools.map((t) => {
    const def: BetaTool = {
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as BetaTool["input_schema"],
    };
    if (t.cacheBreakpoint) {
      def.cache_control = { type: "ephemeral" };
    }
    return def as BetaToolUnion;
  });
}

export function toBetaMessages(
  messages: InternalMessage[],
): BetaMessageParam[] {
  return messages.map((m) => {
    if (m.role === "user") {
      if (typeof m.content === "string") {
        return { role: "user", content: m.content };
      }
      const content: BetaToolResultBlockParam[] = m.content.map((r) => {
        const out: BetaToolResultBlockParam = {
          type: "tool_result",
          tool_use_id: r.tool_use_id,
          content: r.content,
        };
        if (r.is_error) out.is_error = true;
        return out;
      });
      return { role: "user", content };
    }
    // assistant
    const content: Array<BetaTextBlock | BetaToolUseBlockParam> = m.content.map(
      (b) => {
        if (b.type === "text") {
          return { type: "text", text: b.text } as BetaTextBlock;
        }
        return {
          type: "tool_use",
          id: b.id,
          name: b.name,
          input: b.input,
        } as BetaToolUseBlockParam;
      },
    );
    return { role: "assistant", content };
  });
}
