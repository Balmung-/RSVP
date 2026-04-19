// Rebuild the ChatPanel's UI `Turn[]` shape from stored ChatMessage
// rows. The *model-facing* rebuild lives in `transcript.ts` and
// groups rows into Anthropic-shaped tool_use/tool_result turns; this
// module does the parallel job for the CLIENT's render path.
//
// Why two rebuilders instead of one:
//   - `transcript.ts` is consumed by `/api/chat` when it feeds
//     history back into the model. Its output is Anthropic-shaped
//     and has to follow the tool_use/tool_result pairing rules
//     exactly.
//   - `transcript-ui.ts` is consumed by the `/api/chat/session/[id]`
//     hydration endpoint (W2) and emits the block-level UI turn
//     shape the client already renders. Tool status pills,
//     persisted render directives, and error banners live here.
//
// The two rebuilders operate on the same rows but produce different
// outputs; keeping them separate means neither is bent to fit the
// other's constraints. Both are pure (no I/O, no Prisma) so unit
// tests can drive them with fake row arrays.
//
// Row grouping rule (same as transcript.ts):
//   - role="user" rows become their own UserTurn.
//   - role="assistant" rows swallow their IMMEDIATELY-FOLLOWING
//     role="tool" rows into a single AssistantTurn whose `blocks`
//     interleave text -> tool pills -> directives.
//   - Orphan tool rows (no preceding assistant) are skipped
//     silently. Shouldn't happen in practice; matches transcript.ts.

import type { ChatMessage } from "@prisma/client";
import { validateDirective } from "./directive-validate";

// UI-shaped block / turn types. DELIBERATELY DUPLICATED from
// ChatPanel.tsx instead of imported — the panel is a client
// component (`"use client"`) and tests + server code shouldn't
// transitively pull a React-DOM dependency. Keeping the types here
// is a small maintenance cost that protects the build graph.
export type UiAssistantBlock =
  | { type: "text"; text: string }
  | {
      type: "tool";
      name: string;
      status: "running" | "ok" | "error";
      error?: string;
    }
  | {
      type: "directive";
      payload: {
        kind: string;
        props: Record<string, unknown>;
        messageId?: string;
      };
    };

export type UiUserTurn = {
  kind: "user";
  id: string;
  text: string;
};

export type UiAssistantTurn = {
  kind: "assistant";
  id: string;
  blocks: UiAssistantBlock[];
  streaming: false; // hydrated turns are always settled
  error?: string;
};

export type UiTurn = UiUserTurn | UiAssistantTurn;

// Narrow shape the transform actually reads. Using a structural type
// rather than the full `ChatMessage` makes the function testable
// without importing @prisma/client in tests.
export type UiTranscriptRow = Pick<
  ChatMessage,
  | "id"
  | "role"
  | "content"
  | "toolName"
  | "renderDirective"
  | "isError"
>;

// Parse a stored JSON blob back into a value. Returns undefined on
// any failure so callers can decide the fallback; a corrupt row
// shouldn't sink the whole session hydration.
function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// Interpret a tool row's final status from its persisted error
// flag. The live stream carries three states (running/ok/error);
// hydration only sees the settled value because the DB row is
// written after the tool finishes. We map `isError=true` -> "error"
// and otherwise "ok". No "running" — a refreshed session with a
// still-in-flight tool call would show as "ok" briefly, but that's
// a race window of milliseconds and the next live event corrects it.
function statusFromRow(row: UiTranscriptRow): "ok" | "error" {
  return row.isError ? "error" : "ok";
}

// Extract the human error line from a tool row. Handlers persist
// errors as `content: "error: <reason>"` and / or
// `toolOutput: {"error": "<reason>"}`. Prefer the toolOutput field
// because it survives the summarizeOutput truncation the content
// field goes through.
function errorFromRow(row: UiTranscriptRow): string | undefined {
  if (!row.isError) return undefined;
  // Prefer parsed toolOutput.error if available.
  // (Not threaded in UiTranscriptRow today — we don't read
  // toolOutput here because content already carries the short form.
  // Left as a comment so a future tweak has a breadcrumb.)
  const text = row.content ?? "";
  if (text.startsWith("error: ")) return text.slice("error: ".length);
  return text.length > 0 ? text : undefined;
}

export function rebuildUiTurns(rows: UiTranscriptRow[]): UiTurn[] {
  const out: UiTurn[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.role === "user") {
      out.push({
        kind: "user",
        id: row.id,
        text: row.content ?? "",
      });
      i += 1;
      continue;
    }
    if (row.role === "assistant") {
      const blocks: UiAssistantBlock[] = [];
      if (row.content && row.content.length > 0) {
        blocks.push({ type: "text", text: row.content });
      }
      let j = i + 1;
      while (j < rows.length && rows[j].role === "tool") {
        const tool = rows[j];
        const name = tool.toolName ?? "unknown_tool";
        const status = statusFromRow(tool);
        const error = errorFromRow(tool);
        const pill: UiAssistantBlock = { type: "tool", name, status };
        if (error !== undefined) pill.error = error;
        blocks.push(pill);

        // Persisted directive: the tool handler stored this under
        // `renderDirective` after Push 11 validated the shape on
        // WRITE. We revalidate here on the READ path too, because
        // hydration is the first moment since the write that an
        // unchecked blob reaches the renderer, and
        // `DirectiveRenderer` casts `directive.props` straight into
        // concrete prop types (`CampaignListProps`, `ConfirmSendProps`,
        // etc.) without a runtime guard. Relying solely on the
        // write-side gate would leave three holes open:
        //   - Rows written BEFORE Push 11 landed the strict
        //     write-side validator (historic session restore).
        //   - Rows whose kind's prop schema evolved between write
        //     and read (schema drift).
        //   - Rows touched by a manual DB repair, an old migration,
        //     or a future code path that forgets to validate.
        // `validateDirective` closes all three: it rejects bad
        // envelopes, unknown kinds, AND shape-invalid props for
        // known kinds — same behavior as the write path. Any failure
        // drops the directive block but KEEPS the tool status pill,
        // so the operator still sees that a tool ran even when its
        // card can't be safely surfaced.
        const parsed = parseJson(tool.renderDirective);
        const validated = validateDirective(parsed);
        if (validated) {
          const block: UiAssistantBlock = {
            type: "directive",
            payload: {
              kind: validated.kind,
              props: validated.props,
            },
          };
          // messageId is the anchor ConfirmSend uses to POST
          // confirmations against. Thread the tool row id — same
          // contract the live SSE path uses
          // (`directive.messageId = toolRow.id`).
          block.payload.messageId = tool.id;
          blocks.push(block);
        }
        j += 1;
      }

      // Settled turn: `streaming` is always false on hydration.
      // `error` bubbles up from the LAST tool row if that failed, so
      // the rendered bubble shows a tool error banner the same way a
      // live stream would.
      const turn: UiAssistantTurn = {
        kind: "assistant",
        id: row.id,
        blocks,
        streaming: false,
      };
      out.push(turn);
      i = j;
      continue;
    }
    // Orphan tool row — skip silently. Matches transcript.ts behavior.
    i += 1;
  }
  return out;
}
