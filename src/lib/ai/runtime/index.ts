import { createAnthropicRuntime } from "./anthropic";
import type { AIRuntime } from "./types";

// Runtime selector. Reads `AI_RUNTIME` at resolution time and hands
// back a concrete runtime instance configured from the backend's env.
// The chat route is the only caller; it resolves once per request so
// env flips take effect without a server restart (useful in dev,
// cheap in prod because resolution is a few ENV reads).
//
// Defaults:
//   - `AI_RUNTIME` unset or `anthropic` → Anthropic (current behavior)
//   - `AI_RUNTIME=openrouter` → reserved for P2. Not wired here yet;
//     resolving it now returns a typed failure.
//
// Shape is a discriminated union so the caller handles the missing-
// env case (503) before constructing a stream. Throwing from a
// factory would force us to wrap in try/catch at every callsite and
// swallow the distinction between "key missing" and "key wrong".

export type RuntimeResolution =
  | { ok: true; runtime: AIRuntime }
  | { ok: false; reason: RuntimeResolutionError };

export type RuntimeResolutionError =
  | "anthropic_not_configured"
  | "openrouter_not_configured"
  | "unknown_runtime";

export type RuntimeEnv = {
  AI_RUNTIME?: string;
  ANTHROPIC_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
};

// Exposed as a parameter so unit tests can simulate env states
// without mutating `process.env`. Production callers pass nothing
// and pick up the live env.
export function resolveRuntime(
  env: RuntimeEnv = process.env as RuntimeEnv,
): RuntimeResolution {
  const name = (env.AI_RUNTIME ?? "anthropic").toLowerCase();

  if (name === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) return { ok: false, reason: "anthropic_not_configured" };
    return { ok: true, runtime: createAnthropicRuntime({ apiKey }) };
  }

  if (name === "openrouter") {
    // P2 lands the real wrapper. Until then, declining early keeps
    // the failure mode explicit rather than constructing a runtime
    // that would blow up on first stream event.
    return { ok: false, reason: "openrouter_not_configured" };
  }

  return { ok: false, reason: "unknown_runtime" };
}

export type {
  AIRuntime,
  ChatStreamRequest,
  InternalStreamEvent,
  InternalMessage,
  InternalSystemBlock,
  InternalTool,
  InternalTextBlock,
  InternalToolUseBlock,
  InternalToolResultBlock,
  InternalAssistantContent,
  StopReason,
} from "./types";
