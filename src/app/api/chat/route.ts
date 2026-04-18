import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlock,
  Tool as AnthropicTool,
  TextBlock,
  ToolUseBlock,
  ToolResultBlockParam,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/ratelimit";
import { prisma } from "@/lib/db";
import { readAdminLocale } from "@/lib/adminLocale";
import { logAction } from "@/lib/audit";
import { buildToolCtx } from "@/lib/ai/ctx";
import { buildContext } from "@/lib/ai/context";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";
import { listTools, dispatch } from "@/lib/ai/tools";
import { rebuildMessages, assistantTurnFromBlocks } from "@/lib/ai/transcript";

// The chat endpoint. Accepts a POST body `{ sessionId?, message }`,
// authenticates via the usual session cookie, then opens a
// Server-Sent Events stream. The stream carries three kinds of
// frames:
//
//   event: session  — one-shot at the start, carries the canonical
//                     session id so the client can persist it on a
//                     new conversation.
//   event: text     — incremental assistant text delta. Concatenate
//                     on the client.
//   event: directive — a typed render payload emitted by a tool
//                     handler. Shape is `{ kind, props }`; the
//                     client matches `kind` against a fixed
//                     component registry and drops unknowns.
//   event: tool     — lifecycle frame around tool dispatch
//                     (`{name, status:"running|ok|error", ...}`).
//                     Purely advisory for the UI.
//   event: error    — terminal, non-recoverable.
//   event: done     — normal termination (final event).
//
// Destructive tools are intercepted by dispatch() when
// `allowDestructive=false` (the default on this route). A separate
// /api/chat/confirm route — landing in Push 7 — will re-execute a
// specific tool call with the confirmation flag flipped after the
// operator clicks confirm on a previously-proposed directive.
//
// Prompt caching: the SDK stable `messages` endpoint doesn't surface
// cache_control in its typings (only the beta namespace does). We
// concatenate static + dynamic system blocks here for now and will
// layer in a proper `TextBlockParam[]` with a cache_control
// breakpoint in a follow-up push. The prompt builder already returns
// the split shape so the migration is mechanical.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Upper bound on tool-use loop iterations. Real turns usually land
// within 1–3 (user asks → tool call → assistant summary → done).
// The cap exists to stop a pathological loop from burning tokens.
const MAX_TOOL_ITERATIONS = 8;
const MODEL = "claude-3-5-sonnet-latest";
const MAX_TOKENS = 4096;

// Max session messages to feed the model as history. A full event
// office can accumulate thousands over a week; older turns can be
// summarized out of band later. Keep the tail for now.
const HISTORY_TAIL = 40;

type ChatBody = { sessionId?: string; message?: string };

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // Cheap per-user throttle. Chat is intentionally quieter than the
  // command palette — each request kicks off an LLM call plus
  // potential tool dispatches, so an 8/burst + 0.3/s refill
  // (roughly one message every 3–4 seconds sustained) is generous
  // for a real operator and tight on abuse.
  const rl = rateLimit(`chat:${me.id}`, { capacity: 8, refillPerSec: 0.3 });
  if (!rl.ok) {
    return NextResponse.json(
      { ok: false, error: "rate_limited", retryAfterMs: rl.retryAfterMs },
      { status: 429 },
    );
  }

  // Parse body up front so we can reject malformed requests without
  // opening a stream.
  let body: ChatBody;
  try {
    body = (await req.json()) as ChatBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json({ ok: false, error: "empty_message" }, { status: 400 });
  }
  if (message.length > 8000) {
    return NextResponse.json({ ok: false, error: "message_too_long" }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "anthropic_not_configured" },
      { status: 503 },
    );
  }

  // Resolve / create the session. Ownership is enforced on load:
  // supplying someone else's session id is treated as
  // `session_not_found` so an attacker can't probe for valid ids.
  let sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
  if (sessionId) {
    const existing = await prisma.chatSession.findFirst({
      where: { id: sessionId, userId: me.id, archivedAt: null },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json(
        { ok: false, error: "session_not_found" },
        { status: 404 },
      );
    }
  } else {
    const created = await prisma.chatSession.create({
      data: { userId: me.id },
      select: { id: true },
    });
    sessionId = created.id;
  }

  // Persist the user's message BEFORE we start streaming. If the
  // stream dies mid-flight (network blip, model timeout) we still
  // have an honest record of what was asked. Capture the id so we
  // can exclude it from the history-replay query below.
  const userMsg = await prisma.chatMessage.create({
    data: {
      sessionId,
      role: "user",
      content: message,
    },
    select: { id: true },
  });

  // Build the tenant awareness + tool ctx. Both are request-scoped
  // via React.cache(); calling them from multiple places in this
  // same request is free after the first call.
  const [ctx, tenantContext] = await Promise.all([
    buildToolCtx(me),
    buildContext(me),
  ]);
  const locale = readAdminLocale();
  const systemParts = buildSystemPrompt({
    locale,
    tenantContext: tenantContext.text,
    nowLocal: tenantContext.grounding.nowLocal,
    tz: tenantContext.grounding.tz,
    todayKey: tenantContext.grounding.todayKey,
  });
  const systemString = `${systemParts.static}\n\n${systemParts.dynamic}`;

  // Build the tools array for Anthropic. We expose every read/write
  // tool — destructive ones too, since the model is allowed to
  // PROPOSE them; the dispatch layer intercepts before any
  // destructive execution.
  const toolsForApi: AnthropicTool[] = listTools().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as AnthropicTool["input_schema"],
  }));

  // Load the recent tail of history, excluding the user message we
  // just wrote (it's appended back below as the live turn opener).
  // We order desc + take so a long-running session bounded at 40
  // rows always returns the MOST-RECENT N, not the oldest; then
  // reverse back to chronological order for the model.
  const historyDesc = await prisma.chatMessage.findMany({
    where: { sessionId, id: { not: userMsg.id } },
    orderBy: { createdAt: "desc" },
    take: HISTORY_TAIL,
  });
  const history = historyDesc.reverse();
  const priorMessages = rebuildMessages(history);
  const liveMessages: MessageParam[] = [
    ...priorMessages,
    { role: "user", content: message },
  ];

  const client = new Anthropic({ apiKey });

  // SSE stream. Node's `ReadableStream` is the idiomatic Next.js 14
  // shape; we frame events manually.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function send(event: string, data: unknown) {
        const payload =
          typeof data === "string" ? data : JSON.stringify(data);
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${payload}\n\n`),
        );
      }

      function close() {
        try {
          controller.close();
        } catch {
          // already closed — swallow
        }
      }

      try {
        send("session", { id: sessionId });

        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter += 1) {
          // One round-trip to Anthropic. We stream the response so
          // text deltas reach the operator immediately; tool_use
          // blocks are accumulated until the stream closes, then
          // dispatched in order.
          const apiStream = (await client.messages.create({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: systemString,
            tools: toolsForApi,
            messages: liveMessages,
            stream: true,
          })) as AsyncIterable<RawMessageStreamEvent>;

          // Accumulators for the turn. Indexed by content-block
          // index because the API interleaves deltas across blocks.
          const blockText = new Map<number, string>();
          const blockToolUse = new Map<
            number,
            { id: string; name: string; partialJson: string }
          >();
          let stopReason:
            | "end_turn"
            | "max_tokens"
            | "stop_sequence"
            | "tool_use"
            | null = null;

          for await (const ev of apiStream) {
            if (ev.type === "content_block_start") {
              const block = ev.content_block;
              if (block.type === "text") {
                blockText.set(ev.index, "");
              } else if (block.type === "tool_use") {
                blockToolUse.set(ev.index, {
                  id: block.id,
                  name: block.name,
                  partialJson: "",
                });
              }
              continue;
            }
            if (ev.type === "content_block_delta") {
              if (ev.delta.type === "text_delta") {
                const cur = blockText.get(ev.index) ?? "";
                const next = cur + ev.delta.text;
                blockText.set(ev.index, next);
                send("text", { delta: ev.delta.text });
                continue;
              }
              if (ev.delta.type === "input_json_delta") {
                const cur = blockToolUse.get(ev.index);
                if (cur) cur.partialJson += ev.delta.partial_json;
                continue;
              }
              continue;
            }
            if (ev.type === "message_delta") {
              if (ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
              continue;
            }
            // content_block_stop / message_start / message_stop — nothing to do
          }

          // Reconstruct the assistant turn's blocks in index order.
          const indices = Array.from(
            new Set([...blockText.keys(), ...blockToolUse.keys()]),
          ).sort((a, b) => a - b);
          const orderedBlocks: ContentBlock[] = [];
          const textPieces: string[] = [];
          const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
          for (const idx of indices) {
            if (blockText.has(idx)) {
              const text = blockText.get(idx) ?? "";
              orderedBlocks.push({ type: "text", text } as TextBlock);
              if (text) textPieces.push(text);
              continue;
            }
            const tu = blockToolUse.get(idx);
            if (tu) {
              let parsed: unknown = {};
              if (tu.partialJson.length > 0) {
                try {
                  parsed = JSON.parse(tu.partialJson);
                } catch {
                  parsed = {};
                }
              }
              orderedBlocks.push({
                type: "tool_use",
                id: tu.id,
                name: tu.name,
                input: parsed,
              } as ToolUseBlock);
              toolCalls.push({ id: tu.id, name: tu.name, input: parsed });
            }
          }

          // Persist the assistant turn (text portion). Tool rows
          // follow so rebuildMessages can pair them back.
          const assistantText = textPieces.join("");
          await prisma.chatMessage.create({
            data: {
              sessionId,
              role: "assistant",
              content: assistantText,
            },
          });

          // If the model didn't request tools, we're done. The
          // stream produced its final text already.
          if (stopReason !== "tool_use" || toolCalls.length === 0) {
            send("done", { sessionId });
            close();
            return;
          }

          // Dispatch tool calls in order. Each one is persisted
          // before the next call so a mid-loop crash still leaves a
          // coherent transcript.
          const toolResults: ToolResultBlockParam[] = [];
          for (const call of toolCalls) {
            send("tool", { name: call.name, status: "running" });
            const result = await dispatch(call.name, call.input, ctx, {
              allowDestructive: false,
            });

            let outputForModel: string;
            let outputForStorage: unknown;
            let directiveForStorage: unknown = null;
            let isError = false;

            if (result.ok) {
              const r = result.result;
              outputForStorage = r.output;
              outputForModel =
                typeof r.output === "string"
                  ? r.output
                  : JSON.stringify(r.output);
              if (r.directive) {
                directiveForStorage = r.directive;
              }
            } else {
              isError = true;
              // Surface a structured error to the model so it can
              // recover (retry with different args, explain to the
              // operator, propose confirmation, etc.). Destructive
              // short-circuit shows up here as "needs_confirmation".
              outputForModel = `error: ${result.error}`;
              outputForStorage = { error: result.error };
            }

            // Persist BEFORE emitting the directive — we need the
            // row id to thread into the SSE envelope as `messageId`.
            // That id is the authorization anchor the confirm route
            // (`/api/chat/confirm/[messageId]`) uses to re-dispatch
            // destructive actions on operator click. If we emitted
            // the directive first, the client would render a
            // ConfirmSend button with no id to POST to — the confirm
            // round-trip relies on the persisted row existing.
            const toolRow = await prisma.chatMessage.create({
              data: {
                sessionId,
                role: "tool",
                content: isError
                  ? `error: ${result.ok ? "" : result.error}`
                  : summarizeOutput(outputForStorage),
                toolName: call.name,
                toolInput: safeStringify(call.input),
                toolOutput: safeStringify(outputForStorage),
                renderDirective: directiveForStorage
                  ? safeStringify(directiveForStorage)
                  : null,
                // Carried through to ToolResultBlockParam.is_error
                // on next-turn replay (src/lib/ai/transcript.ts).
                // Without this, destructive short-circuits
                // (`needs_confirmation`) and handler throws would
                // replay as successful tool_results.
                isError,
              },
              select: { id: true },
            });

            if (result.ok) {
              if (directiveForStorage) {
                // Envelope shape: `{kind, props, messageId}`. The
                // client's DirectiveRenderer threads messageId into
                // confirmation directives (ConfirmSend) so the
                // button knows which row to POST against. Directives
                // that don't need a confirm round-trip (CampaignList,
                // ConfirmDraft) ignore the extra field.
                send("directive", {
                  ...(directiveForStorage as Record<string, unknown>),
                  messageId: toolRow.id,
                });
              }
              send("tool", { name: call.name, status: "ok" });
            } else {
              send("tool", {
                name: call.name,
                status: "error",
                error: result.error,
              });
            }

            // Audit every tool invocation. `data.via = "chat"`
            // matches the convention used elsewhere for AI-origin
            // actions (see src/lib/audit.ts comments).
            await logAction({
              kind: `ai.tool.${call.name}`,
              refType: "ChatSession",
              refId: sessionId,
              actorId: me.id,
              data: {
                via: "chat",
                ok: result.ok,
                error: result.ok ? null : result.error,
                sessionId,
              },
            });

            toolResults.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: outputForModel,
              is_error: isError,
            });
          }

          // Feed assistant turn + tool results back for the next
          // iteration. We use the LIVE Anthropic ids here so the
          // tool_use/tool_result pairing is self-consistent.
          liveMessages.push(assistantTurnFromBlocks(orderedBlocks));
          liveMessages.push({ role: "user", content: toolResults });
        }

        // Loop exhausted without a natural end_turn. Tell the
        // client; the transcript is still intact in the DB.
        send("error", {
          message: "tool_loop_exceeded",
          iterations: MAX_TOOL_ITERATIONS,
        });
        send("done", { sessionId });
        close();
      } catch (err) {
        // Any uncaught error (Anthropic 5xx, JSON blow-up) lands
        // here. Persist nothing extra — user + assistant-so-far
        // rows are already in the DB — and tell the client.
        const msg = err instanceof Error ? err.message : String(err);
        try {
          send("error", { message: msg.slice(0, 400) });
        } catch {
          // controller may already be closed
        }
        close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Proxies sometimes buffer SSE; this tells nginx to stop.
      "X-Accel-Buffering": "no",
    },
  });
}

// Compact human summary of a tool output for the ChatMessage.content
// field. Not fed to the model (tool replay uses `toolOutput` JSON);
// just for debug / UI fallback if renderDirective isn't recognized.
function summarizeOutput(out: unknown): string {
  if (typeof out === "string") {
    return out.slice(0, 500);
  }
  if (out && typeof out === "object") {
    const anyOut = out as Record<string, unknown>;
    if (typeof anyOut.summary === "string") return anyOut.summary.slice(0, 500);
  }
  try {
    return JSON.stringify(out).slice(0, 500);
  } catch {
    return "";
  }
}

// JSON.stringify with an exception trap. Handlers control their own
// output shape, but a rogue bigint / circular reference shouldn't
// kill the persistence write.
function safeStringify(v: unknown): string | null {
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}
