import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/ratelimit";
import { prisma } from "@/lib/db";
import { readAdminLocale } from "@/lib/adminLocale";
import { logAction } from "@/lib/audit";
import { buildToolCtx } from "@/lib/ai/ctx";
import { buildContext } from "@/lib/ai/context";
import { buildSystemPrompt } from "@/lib/ai/system-prompt";
import { gatherMemoriesForUser } from "@/lib/ai/memory-recall";
import { renderMemoryContext } from "@/lib/ai/memory-context";
import { listTools, dispatch } from "@/lib/ai/tools";
import { rebuildMessages, assistantTurnFromBlocks } from "@/lib/ai/transcript";
import { validateDirective } from "@/lib/ai/directive-validate";
import { createWorkspaceEmitter } from "@/lib/ai/widgets";
import {
  tryRefreshSummaryForChatTool,
  tryRefreshSummaryForSnapshot,
} from "@/lib/ai/workspace-summary";
import { gateRuntimeForChatRoute } from "./runtime-gate";
import { handleToolSuccess } from "./handle-tool-success";
import { deriveSessionTitle } from "@/lib/ai/session-title";
import { touchChatSession } from "@/lib/chat/session-activity";
import type {
  InternalAssistantContent,
  InternalMessage,
  InternalSystemBlock,
  InternalTool,
  InternalToolResultBlock,
  StopReason,
} from "@/lib/ai/runtime";

// The chat endpoint. Accepts a POST body `{ sessionId?, message }`,
// authenticates via the usual session cookie, then opens a
// Server-Sent Events stream. The stream carries these frame kinds:
//
//   event: session  — one-shot at the start, carries the canonical
//                     session id so the client can persist it on a
//                     new conversation.
//   event: workspace_snapshot — one-shot right after `session`. Ships
//                     the authoritative list of persisted widgets
//                     for this session so a reload recovers the
//                     dashboard without replaying the transcript.
//                     Shape: `{ widgets: Widget[], skipped: number }`.
//                     `skipped` counts rows that failed revalidation
//                     on read (drift defence); normal is 0.
//   event: widget_upsert — emitted when a tool calls the workspace
//                     emitter's `.upsert(...)`. Shape is the full
//                     `Widget` object (widgetKey, kind, slot, props,
//                     order, sourceMessageId, createdAt, updatedAt).
//                     Client replaces any existing widget with the
//                     same widgetKey. Not emitted in W1 (no tool
//                     callers yet); the frame contract is fixed now
//                     so W3 is a pure code-move.
//   event: widget_remove — emitted when `.remove(widgetKey)` hit a
//                     row. Shape: `{ widgetKey }`. Client removes
//                     the widget with that key from local state.
//   event: widget_focus — optional. Emitted when `.focus(widgetKey)`
//                     resolves a known widget. Shape: `{ widgetKey }`.
//                     Purely advisory; client scrolls / highlights.
//   event: text     — incremental assistant text delta. Concatenate
//                     on the client.
//   event: directive — a typed render payload emitted by a tool
//                     handler. Shape is `{ kind, props }`; the
//                     client matches `kind` against a fixed
//                     component registry and drops unknowns. Kept
//                     as the current UI contract; W3 migrates each
//                     directive kind to a widget and the directive
//                     emit is eventually removed.
//   event: tool     — lifecycle frame around tool dispatch
//                     (`{name, status:"running|ok|error", ...}`).
//                     Purely advisory for the UI.
//   event: error    — terminal, non-recoverable.
//   event: done     — normal termination (final event).
//
// Destructive tools are intercepted by dispatch() when
// `allowDestructive=false` (the default on this route). A separate
// /api/chat/confirm route re-executes a specific tool call with the
// confirmation flag flipped after the operator clicks confirm on a
// previously-proposed directive.
//
// Prompt caching: this route marks `cacheBreakpoint: true` on the
// static system block and the last tool. Providers that support
// prompt caching (Anthropic, via `src/lib/ai/runtime/anthropic.ts`)
// translate those flags into real cache boundaries; providers that
// don't (OpenRouter, arriving in P2) ignore them — correctness
// unchanged, just fewer savings.
//
// On Anthropic specifically, the server hashes the request in a
// fixed order — `tools → system → messages` — so each breakpoint
// caches a PREFIX that respects that order, not the order fields
// appear in this source file. With two breakpoints we get two
// cached prefixes:
//   - Tool-tail breakpoint (on the LAST tool): caches the tools
//     block alone (~1000-1200 tokens).
//   - Static-system breakpoint (on the first system block): caches
//     tools + static system (~1500-1750 tokens) — the bigger win.
// The dynamic system block (tenant context + local date) changes
// per turn and sits OUTSIDE both prefixes; likewise the messages
// array. For two back-to-back turns in the same 5-minute window we
// read ~1500 tokens from cache at ~10% of normal input price.

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

  // Resolve the AI runtime at request time. `AI_RUNTIME` env flips
  // the backend (anthropic / openrouter). The gate translates the
  // resolver's typed failure into a 503 so the client gets the same
  // error-code surface as before (the "anthropic_not_configured"
  // string is preserved for the default/current path). The
  // translation itself is pinned at the route-seam level in
  // `tests/unit/chat-route-runtime.test.ts`.
  const gated = gateRuntimeForChatRoute();
  if (!gated.pass) {
    return NextResponse.json(gated.body, { status: gated.status });
  }
  const runtime = gated.runtime;

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
    // P4 — derive a title from the operator's first user message so
    // the session-picker has a meaningful label the moment the row
    // appears in GET /api/chat/sessions. `deriveSessionTitle` may
    // return null for whitespace-only messages (defensive — the
    // length check above already rejected empty-trim, so this is
    // extremely unlikely to be null here, but the column is nullable
    // so a null is a valid write). Subsequent turns in this session
    // never re-derive: the title is the ORIGINAL ask, not whatever
    // was most recently typed.
    const derivedTitle = deriveSessionTitle(message);
    const created = await prisma.chatSession.create({
      data: {
        userId: me.id,
        title: derivedTitle,
      },
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
  // Recency-bump AFTER the child write is durable. `@updatedAt` on
  // ChatSession doesn't fire on child-row INSERT, so the session
  // picker / resume-last ordering would otherwise see a stale
  // parent timestamp. See `src/lib/chat/session-activity.ts`.
  await touchChatSession(prisma, sessionId);

  // Build the tenant awareness + tool ctx. Both are request-scoped
  // via React.cache(); calling them from multiple places in this
  // same request is free after the first call.
  //
  // P16-D — memory recall is gathered IN PARALLEL with the other
  // two context builders. It shares the same fail-closed posture
  // as the rest of this route: if the gather throws, an empty
  // block is substituted so the chat turn proceeds. The extra
  // defense-in-depth catch here mirrors `gatherMemoriesForUser`'s
  // own internal try/catches — belt-and-braces because a bug in
  // the gather itself (not just a prisma failure inside it) must
  // not deny the operator their turn.
  const [ctx, tenantContext, memoryBlocks] = await Promise.all([
    buildToolCtx(me),
    buildContext(me),
    gatherMemoriesForUser(me).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[chat] memory recall gather failed; continuing without memories", err);
      return [] as Awaited<ReturnType<typeof gatherMemoriesForUser>>;
    }),
  ]);
  const locale = readAdminLocale();
  // Empty string when there are no memories to inject (zero teams,
  // all recalls failed, or nothing saved yet). The system-prompt
  // builder treats empty / undefined as "skip the memory section
  // entirely" — no dangling heading wastes tokens.
  const memoryContext = renderMemoryContext(memoryBlocks);
  const systemParts = buildSystemPrompt({
    locale,
    tenantContext: tenantContext.text,
    nowLocal: tenantContext.grounding.nowLocal,
    tz: tenantContext.grounding.tz,
    todayKey: tenantContext.grounding.todayKey,
    memoryContext,
  });
  // Two system blocks: static (role / protocol rules) is the
  // cacheable prefix, dynamic (tenant context + local date) is the
  // per-turn tail. The `cacheBreakpoint` marker on the static block
  // tells the runtime "everything up to AND INCLUDING this block is
  // the cache key; everything after is fresh input". The dynamic
  // block carries no marker, so it isn't part of the cached prefix.
  // Providers that don't support prompt caching ignore the flag.
  const systemBlocks: InternalSystemBlock[] = [
    { type: "text", text: systemParts.static, cacheBreakpoint: true },
    { type: "text", text: systemParts.dynamic },
  ];

  // Build the tools array for the runtime. We expose every
  // read/write tool — destructive ones too, since the model is
  // allowed to PROPOSE them; the dispatch layer intercepts before
  // any destructive execution.
  //
  // Tool order is stable (governed by the registry's registration
  // order in `src/lib/ai/tools/index.ts`). Marking the LAST tool
  // with `cacheBreakpoint` caches the full tools block as a
  // standalone prefix on Anthropic (server-side order there is
  // `tools → system → messages`, so this prefix is tools-only; the
  // larger tools + static-system prefix is cached by the breakpoint
  // on the static system block itself, above). If the tool list
  // grows or reorders, both caches invalidate — expected, and
  // correct. Providers without caching ignore the flag.
  const registered = listTools();
  const tools: InternalTool[] = registered.map((t, idx) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Record<string, unknown>,
    cacheBreakpoint: idx === registered.length - 1,
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
  const liveMessages: InternalMessage[] = [
    ...priorMessages,
    { role: "user", content: message },
  ];

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

        // Workspace state goes out BEFORE the first model turn so
        // the client can paint the dashboard skeleton while the
        // first text delta is still a network hop away. A brand-new
        // session gets `{ widgets: [], skipped: 0 }` and the client
        // treats that as "clear any stale board state and start
        // fresh" — the emit is authoritative, empty is a valid
        // value, not an omission.
        //
        // `prisma` is injected via the dep interface the widgets
        // module expects; the narrow `PrismaLike` shape matches
        // `prisma.chatWidget.{findMany,upsert,deleteMany,findUnique}`
        // from @prisma/client's generated types by structural
        // compat. The `as never` is a typed-pass-through the TS
        // compiler needs because the generated Prisma argument
        // types carry many optional fields (`select`, `include`,
        // `distinct`) that `PrismaLike` deliberately leaves out.
        const workspace = createWorkspaceEmitter(
          { prismaLike: prisma as never },
          sessionId!,
          send,
        );
        const snapshotSummary = await tryRefreshSummaryForSnapshot(
          { prismaLike: prisma as never },
          { campaignScope: ctx.campaignScope },
        );
        if (snapshotSummary.kind === "invalid") {
          console.warn(
            `[chat] workspace rollup produced invalid props; dropped`,
            { sessionId },
          );
        } else if (snapshotSummary.kind === "error") {
          console.warn(
            `[chat] workspace rollup refresh failed`,
            snapshotSummary.error,
          );
        }
        await workspace.snapshot();
        if (snapshotSummary.kind === "produced") {
          send("widget_upsert", snapshotSummary.widget);
        }

        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter += 1) {
          // One round-trip to the AI runtime. We stream the response
          // so text deltas reach the operator immediately; tool_use
          // blocks are accumulated until the stream closes, then
          // dispatched in order.
          //
          // `runtime.stream(...)` is provider-agnostic: whether the
          // backend is Anthropic (with prompt caching + beta headers)
          // or OpenRouter (with OpenAI-compatible tool_calls),
          // translation lives inside the runtime module and this
          // route consumes a normalized event sequence.
          const apiStream = runtime.stream({
            model: MODEL,
            maxTokens: MAX_TOKENS,
            system: systemBlocks,
            tools,
            messages: liveMessages,
          });

          // Accumulators for the turn. Indexed by content-block
          // index because the runtime event sequence interleaves
          // deltas across blocks.
          const blockText = new Map<number, string>();
          const blockToolUse = new Map<
            number,
            { id: string; name: string; partialJson: string }
          >();
          let stopReason: StopReason = null;

          for await (const ev of apiStream) {
            if (ev.type === "tool_use_start") {
              blockToolUse.set(ev.index, {
                id: ev.id,
                name: ev.name,
                partialJson: "",
              });
              continue;
            }
            if (ev.type === "text_delta") {
              const cur = blockText.get(ev.index) ?? "";
              blockText.set(ev.index, cur + ev.text);
              send("text", { delta: ev.text });
              continue;
            }
            if (ev.type === "tool_input_delta") {
              const cur = blockToolUse.get(ev.index);
              if (cur) cur.partialJson += ev.partialJson;
              continue;
            }
            if (ev.type === "stop") {
              stopReason = ev.reason;
              continue;
            }
          }

          // Reconstruct the assistant turn's blocks in index order.
          const indices = Array.from(
            new Set([...blockText.keys(), ...blockToolUse.keys()]),
          ).sort((a, b) => a - b);
          const orderedBlocks: InternalAssistantContent = [];
          const textPieces: string[] = [];
          const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
          for (const idx of indices) {
            if (blockText.has(idx)) {
              const text = blockText.get(idx) ?? "";
              orderedBlocks.push({ type: "text", text });
              if (text) textPieces.push(text);
              continue;
            }
            const tu = blockToolUse.get(idx);
            if (tu) {
              let parsed: Record<string, unknown> = {};
              if (tu.partialJson.length > 0) {
                try {
                  const raw = JSON.parse(tu.partialJson);
                  if (raw && typeof raw === "object") {
                    parsed = raw as Record<string, unknown>;
                  }
                } catch {
                  parsed = {};
                }
              }
              orderedBlocks.push({
                type: "tool_use",
                id: tu.id,
                name: tu.name,
                input: parsed,
              });
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
          await touchChatSession(prisma, sessionId);

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
          const toolResults: InternalToolResultBlock[] = [];
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
                // Push 11 — server-side validate-per-kind. Directives
                // written to the DB or streamed to the client must
                // match the renderer's expected shape for their kind.
                // A null return here means the handler produced
                // something malformed (missing required field, wrong
                // type, unknown kind) — we drop the directive on the
                // floor so nothing bad persists or renders. The
                // assistant's text still carries the answer; we just
                // lose the card. The server log tells the operator /
                // maintainer the tool is misbehaving. See
                // `src/lib/ai/directive-validate.ts` and
                // `tests/unit/directive-validate.test.ts`.
                const validated = validateDirective(r.directive);
                if (validated) {
                  directiveForStorage = validated;
                } else {
                  console.warn(
                    `[chat] invalid directive from tool ${call.name}; dropped`,
                    { kind:
                      (r.directive && typeof r.directive === "object" &&
                        "kind" in r.directive)
                        ? (r.directive as { kind: unknown }).kind
                        : null },
                  );
                }
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
                // Carried through to InternalToolResultBlock.is_error
                // on next-turn replay (src/lib/ai/transcript.ts).
                // Without this, destructive short-circuits
                // (`needs_confirmation`) and handler throws would
                // replay as successful tool_results.
                isError,
              },
              select: { id: true },
            });
            await touchChatSession(prisma, sessionId);

            if (result.ok) {
              // Directive emit + widget upsert + summary-rollup
              // refresh + final `tool:ok` frame. The per-success
              // wiring is extracted to `handle-tool-success.ts` so
              // the frame-order contract (directive → widget →
              // summary → tool:ok) and the drop-and-log posture on
              // invalid widgets / rollup failures are pinned at the
              // route-seam level in
              // `tests/unit/chat-route-tool-success.test.ts`. The
              // route's job here is only to pass the already-narrowed
              // dispatch result and the persisted row id.
              await handleToolSuccess(
                {
                  upsertWidget: (input) => workspace.upsert(input),
                  refreshSummary: (toolName) =>
                    tryRefreshSummaryForChatTool(
                      { prismaLike: prisma as never },
                      { sessionId, campaignScope: ctx.campaignScope },
                      toolName,
                    ),
                  send,
                },
                {
                  toolName: call.name,
                  toolRowId: toolRow.id,
                  sessionId,
                  widget: result.result.widget ?? null,
                  directive: directiveForStorage,
                },
              );
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
          // iteration. We use the LIVE provider ids here so the
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
