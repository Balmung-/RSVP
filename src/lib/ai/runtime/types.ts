// Internal AI runtime contract. Provider-agnostic types the chat
// route + transcript layer depend on, so that swapping between
// Anthropic and OpenRouter (P2) is a runtime-seam change, not a
// route rewrite.
//
// Design rules:
//   1. Keep this file the ONLY place chat-flow types live. The route
//      and transcript module import from here, never from an SDK.
//   2. Shapes mirror the Anthropic tool-use/content-block model
//      because that is the richer of the two targets — OpenRouter's
//      OpenAI-compatible tool_calls are a strict subset we can map
//      into this shape with no information loss.
//   3. `cacheBreakpoint` is an advisory hint. Providers that support
//      prompt caching (Anthropic beta) translate it to a real
//      breakpoint; providers that don't ignore it. Never a hard
//      requirement.
//   4. No vendor ids, no vendor-specific enums. `StopReason` is the
//      intersection of what both providers can tell us about turn
//      termination.

export type InternalTextBlock = { type: "text"; text: string };

export type InternalToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type InternalToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

// A system block is always text. `cacheBreakpoint` flips this block
// into a provider-level cache boundary when the backend supports it.
// Anthropic maps it to `cache_control: { type: "ephemeral" }`;
// OpenRouter silently drops it (their prompt caching is provider-
// side and not configurable from the request).
export type InternalSystemBlock = {
  type: "text";
  text: string;
  cacheBreakpoint?: boolean;
};

// Assistant content is a mix of text + tool_use blocks (in order).
// User content is EITHER a plain string (live operator message) or
// an array of tool_result blocks (tool dispatch feedback fed back
// into the next turn).
export type InternalAssistantContent = Array<
  InternalTextBlock | InternalToolUseBlock
>;

export type InternalMessage =
  | { role: "user"; content: string }
  | { role: "user"; content: InternalToolResultBlock[] }
  | { role: "assistant"; content: InternalAssistantContent };

// Tool registry definition. `inputSchema` is a JSONSchema object
// both providers accept verbatim under their respective wrapper
// fields. `cacheBreakpoint` on the LAST tool turns the tools block
// into a cacheable prefix on Anthropic; OpenRouter ignores it.
export type InternalTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  cacheBreakpoint?: boolean;
};

// Streaming events the runtime yields as the model generates. The
// route consumes this sequence and reconstructs the full turn.
//
// `index` on block events identifies the content block within the
// current assistant turn — providers that don't surface an index
// natively (OpenRouter) MUST synthesize one that is stable across
// all deltas belonging to the same block.
export type InternalStreamEvent =
  | { type: "text_delta"; index: number; text: string }
  | { type: "tool_use_start"; index: number; id: string; name: string }
  | { type: "tool_input_delta"; index: number; partialJson: string }
  | {
      type: "stop";
      reason:
        | "end_turn"
        | "max_tokens"
        | "stop_sequence"
        | "tool_use"
        | null;
    };

// Allowed turn-termination reasons. Callers switch on "tool_use" to
// decide whether to dispatch; everything else is a natural end.
export type StopReason = Extract<InternalStreamEvent, { type: "stop" }>["reason"];

// The request shape every runtime consumes. Provider-specific knobs
// (prompt caching beta flags, OpenRouter referer/title) are NOT in
// here — they live inside the provider module, configured from env.
export type ChatStreamRequest = {
  model: string;
  maxTokens: number;
  system: InternalSystemBlock[];
  tools: InternalTool[];
  messages: InternalMessage[];
};

// The single-method runtime contract. Implementations yield the
// stream event sequence above and translate the request into
// whatever the underlying SDK expects.
//
// `name` is a pure identifier for logging/audit; it does not change
// behavior.
export interface AIRuntime {
  readonly name: "anthropic" | "openrouter";
  stream(request: ChatStreamRequest): AsyncIterable<InternalStreamEvent>;
}
