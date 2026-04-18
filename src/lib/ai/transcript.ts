import type { ChatMessage } from "@prisma/client";
import type {
  MessageParam,
  ContentBlock,
  ToolResultBlockParam,
  ToolUseBlockParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages";

// Rebuild an Anthropic-shaped `messages` array from the stored
// ChatMessage rows of a session. The storage shape is flat (one row
// per "logical" message) but the API wants:
//   - user turns as {role:"user", content: text}
//   - assistant turns as {role:"assistant", content: [text + tool_use]}
//   - tool results as a FOLLOWING {role:"user", content: [tool_result...]}
//
// We persist each tool invocation as its OWN ChatMessage row
// (role="tool", toolName/toolInput/toolOutput populated) that always
// immediately follows the assistant row which produced it. Rebuilding
// groups those trailing tool rows back into the assistant turn.
//
// Tool-use IDs inside a single Anthropic request must match between
// the tool_use block and its corresponding tool_result. The IDs from
// the live stream are sealed at end-of-turn — when we REPLAY a past
// turn, we regenerate a stable id from the stored tool row's CUID:
// `toolu_<rowId>`. Anthropic doesn't care what the id is as long as
// it's consistent within the request, so this is safe.

const TOOL_USE_ID_PREFIX = "toolu_";

// Parse a `String?`-stored JSON blob back into an object/value.
// Returns undefined for null/empty/invalid so callers can decide the
// default. We lean forgiving here — a corrupt row shouldn't sink the
// whole session replay.
function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// Tool outputs are fed back to the model as strings. If the stored
// output is structured JSON, render it deterministically; if it's a
// plain string, pass it through; if it's missing, fall back to the
// row's `content` field, which handlers also populate with a compact
// human summary.
function toolOutputAsString(row: ChatMessage): string {
  const parsed = parseJson(row.toolOutput);
  if (typeof parsed === "string") return parsed;
  if (parsed && typeof parsed === "object") {
    try {
      return JSON.stringify(parsed);
    } catch {
      // fall through
    }
  }
  return row.content ?? "";
}

export function rebuildMessages(rows: ChatMessage[]): MessageParam[] {
  const out: MessageParam[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.role === "user") {
      out.push({ role: "user", content: row.content ?? "" });
      i += 1;
      continue;
    }
    if (row.role === "assistant") {
      const blocks: Array<TextBlockParam | ToolUseBlockParam> = [];
      if (row.content && row.content.length > 0) {
        blocks.push({ type: "text", text: row.content });
      }
      // Consume trailing tool rows; each becomes a tool_use in this
      // assistant turn AND feeds a following user-turn tool_result.
      const toolResults: ToolResultBlockParam[] = [];
      let j = i + 1;
      while (j < rows.length && rows[j].role === "tool") {
        const t = rows[j];
        const id = `${TOOL_USE_ID_PREFIX}${t.id}`;
        const input = parseJson(t.toolInput);
        blocks.push({
          type: "tool_use",
          id,
          name: t.toolName ?? "unknown_tool",
          input: (input && typeof input === "object" ? input : {}) as Record<
            string,
            unknown
          >,
        });
        // is_error is load-bearing across turns. Without it, a stored
        // failure like `needs_confirmation` replays as a SUCCESS
        // tool_result (the payload is still the JSON `{error: ...}`
        // blob, but Anthropic has no way to distinguish "the tool
        // returned a shape with an error field" from "the tool
        // itself failed"). Destructive gating and recovery behavior
        // both hinge on the model seeing the error status honestly.
        const resultParam: ToolResultBlockParam = {
          type: "tool_result",
          tool_use_id: id,
          content: toolOutputAsString(t),
        };
        if (t.isError) resultParam.is_error = true;
        toolResults.push(resultParam);
        j += 1;
      }
      if (blocks.length === 0) {
        // Degenerate case: empty assistant row with no text and no
        // tool calls. Emit a single-space text block so Anthropic
        // doesn't reject the turn — content can't be empty.
        blocks.push({ type: "text", text: " " });
      }
      out.push({ role: "assistant", content: blocks });
      if (toolResults.length > 0) {
        out.push({ role: "user", content: toolResults });
      }
      i = j;
      continue;
    }
    // Orphan tool row (no preceding assistant). Shouldn't happen in
    // practice but skip rather than inject an invalid shape.
    i += 1;
  }
  return out;
}

// Given an in-flight ContentBlock array (the blocks accumulated from
// the CURRENT streaming turn), convert them into an assistant
// MessageParam suitable for appending to messages[] on the next loop
// iteration. Text blocks pass through; tool_use blocks keep their
// live Anthropic IDs (which match the tool_use_ids we just handed to
// tool_result). This is the one place in the flow where we use the
// SDK's live IDs rather than synthesized ones.
export function assistantTurnFromBlocks(
  blocks: ContentBlock[],
): MessageParam {
  const params: Array<TextBlockParam | ToolUseBlockParam> = blocks.map((b) => {
    if (b.type === "text") {
      return { type: "text", text: b.text };
    }
    // tool_use
    return {
      type: "tool_use",
      id: b.id,
      name: b.name,
      input: (b.input && typeof b.input === "object"
        ? b.input
        : {}) as Record<string, unknown>,
    };
  });
  if (params.length === 0) {
    params.push({ type: "text", text: " " });
  }
  return { role: "assistant", content: params };
}
