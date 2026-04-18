"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import clsx from "clsx";
import { DirectiveRenderer, type AnyDirective } from "./DirectiveRenderer";
import type { FormatContext } from "./directives/CampaignList";

// The chat panel — the operator's conversational entry point. Streams
// POST /api/chat via Server-Sent Events and composes a living list
// of turns, interleaving assistant text with tool-status pills and
// typed render directives (campaign lists, etc).
//
// Design notes, roughly in priority order:
//
// 1. **Append-only turns.** Once a turn lands in state we never
//    mutate its historical blocks — only the IN-PROGRESS assistant
//    turn gets mutated, and that's the last entry in the array.
//    This makes React reconciliation cheap and means an in-flight
//    re-render can't accidentally eat the user's prior exchange.
//
// 2. **Block-level interleaving.** A single assistant turn can mix
//    `"Let me check..."` → tool call → directive → `"Here's what I
//    found."` — mirrors the SSE stream's natural order. We keep
//    those as separate blocks inside the turn so the visual flow
//    matches the model's reasoning.
//
// 3. **No external SSE dep.** The parser is a couple of dozen
//    lines below. The SSE spec is simple enough that pulling in a
//    lib for it would cost more than it saves.
//
// 4. **Session id is authoritative from the server.** We do NOT
//    send a sessionId on the first message — the server creates
//    one and sends it back on an `event: session` frame. After
//    that we pin it for the rest of the conversation.
//
// 5. **Formatting is prop-threaded, not contextual.** `fmt`
//    (locale + calendar + tz) is passed down from the server
//    page. Directives render dates in the operator's admin
//    settings so "20 Apr 2026, 19:30" agrees with what they see
//    elsewhere in the admin UI.

type UserTurn = { kind: "user"; id: string; text: string };
type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; status: "running" | "ok" | "error"; error?: string }
  | { type: "directive"; payload: AnyDirective };
type AssistantTurn = {
  kind: "assistant";
  id: string;
  blocks: AssistantBlock[];
  streaming: boolean;
  error?: string;
};
type Turn = UserTurn | AssistantTurn;

// Top-level mode shown to the user. `streaming` covers the entire
// window from POST open to `event: done`, including tool-use loops.
type Phase = "idle" | "streaming";

// How we identify a turn internally. Doesn't need to match the DB
// id — purely for React key stability.
function newId(): string {
  return `t_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

export function ChatPanel({ fmt }: { fmt: FormatContext }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [topError, setTopError] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Pin to the bottom whenever turns grow. Lightweight — the
  // container is a flex column with scroll; we just nudge it.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns]);

  // Close the stream if the user navigates away mid-turn. We don't
  // persist client state — the server already has the transcript.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const canSend = phase === "idle" && input.trim().length > 0;

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || phase !== "idle") return;

    // Optimistic append: user bubble + empty assistant shell.
    const userId = newId();
    const asstId = newId();
    setTurns((prev) => [
      ...prev,
      { kind: "user", id: userId, text },
      { kind: "assistant", id: asstId, blocks: [], streaming: true },
    ]);
    setInput("");
    setPhase("streaming");
    setTopError(null);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: text,
          sessionId: sessionIdRef.current,
        }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        // Pre-stream error — parse as JSON, surface a top-line
        // notice, and mark the assistant turn as failed.
        let message = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) message = body.error;
        } catch {
          // non-JSON body, keep the HTTP code
        }
        setTopError(message);
        setTurns((prev) =>
          prev.map((t) =>
            t.kind === "assistant" && t.id === asstId
              ? { ...t, streaming: false, error: message }
              : t,
          ),
        );
        setPhase("idle");
        return;
      }

      if (!res.body) {
        setTopError("no_stream_body");
        setPhase("idle");
        return;
      }

      await consumeSse(res.body, (ev) => {
        handleEvent(ev, asstId, sessionIdRef, setTurns);
      });
      // Belt-and-braces: if the stream ended without emitting a
      // terminal `done` frame (e.g. the server closed after an
      // `event: error`, or a proxy dropped the connection without
      // delivering the final bytes), make sure the in-progress
      // assistant turn isn't stuck in `streaming=true` — the
      // animated cursor would otherwise pulse forever on a dead
      // turn. Safe no-op when `done` was already handled: we
      // only flip rows that are still streaming.
      setTurns((prev) =>
        prev.map((t) =>
          t.kind === "assistant" && t.id === asstId && t.streaming
            ? { ...t, streaming: false }
            : t,
        ),
      );
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      const msg = err instanceof Error ? err.message : "stream_error";
      setTopError(msg);
      setTurns((prev) =>
        prev.map((t) =>
          t.kind === "assistant" && t.id === asstId
            ? { ...t, streaming: false, error: msg }
            : t,
        ),
      );
    } finally {
      setPhase("idle");
      abortRef.current = null;
    }
  }, [input, phase]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends; Shift+Enter inserts a newline. Standard chat UX.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (canSend) void send();
      }
    },
    [canSend, send],
  );

  const placeholder = useMemo(
    () =>
      fmt.locale === "ar"
        ? "اسأل أو اكتب أمرًا…"
        : "Ask about campaigns, contacts, activity…",
    [fmt.locale],
  );

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] max-w-3xl mx-auto w-full">
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto px-4 py-6 space-y-6"
      >
        {turns.length === 0 && (
          <div className="text-sm text-slate-500 text-center pt-12">
            {fmt.locale === "ar"
              ? "ابدأ محادثة — يمكنني عرض الحملات، وجهات الاتصال، والنشاط."
              : "Start a conversation — I can surface campaigns, contacts, activity."}
          </div>
        )}

        {turns.map((t) =>
          t.kind === "user" ? (
            <UserBubble key={t.id} text={t.text} />
          ) : (
            <AssistantBubble key={t.id} turn={t} fmt={fmt} />
          ),
        )}
      </div>

      {topError && (
        <div className="px-4 pb-2">
          <div className="rounded-md border border-rose-200 bg-rose-50 text-rose-800 text-sm px-3 py-2">
            {topError}
          </div>
        </div>
      )}

      <div className="border-t border-slate-200 bg-white px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder={placeholder}
            disabled={phase === "streaming"}
            className="flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:bg-slate-50"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!canSend}
            className={clsx(
              "rounded-md px-3 py-2 text-sm font-medium",
              canSend
                ? "bg-slate-900 text-white hover:bg-slate-800"
                : "bg-slate-200 text-slate-400 cursor-not-allowed",
            )}
          >
            {phase === "streaming"
              ? fmt.locale === "ar"
                ? "جاري…"
                : "Working…"
              : fmt.locale === "ar"
                ? "إرسال"
                : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- turn bubbles ---------------------------------------------------

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-lg bg-slate-900 text-white text-sm px-3 py-2 whitespace-pre-wrap">
        {text}
      </div>
    </div>
  );
}

function AssistantBubble({
  turn,
  fmt,
}: {
  turn: AssistantTurn;
  fmt: FormatContext;
}) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[95%] w-full space-y-2">
        {turn.blocks.map((b, i) => {
          if (b.type === "text") {
            return (
              <div
                key={i}
                className="text-sm text-slate-900 whitespace-pre-wrap leading-relaxed"
              >
                {b.text}
                {turn.streaming && i === turn.blocks.length - 1 && (
                  <span className="inline-block w-1.5 h-4 bg-slate-400 align-middle ms-1 animate-pulse" />
                )}
              </div>
            );
          }
          if (b.type === "tool") {
            return <ToolStatusPill key={i} block={b} />;
          }
          if (b.type === "directive") {
            return (
              <DirectiveRenderer key={i} directive={b.payload} fmt={fmt} />
            );
          }
          return null;
        })}
        {turn.blocks.length === 0 && turn.streaming && (
          <div className="text-sm text-slate-400">…</div>
        )}
        {turn.error && (
          <div className="text-xs text-rose-700 bg-rose-50 rounded px-2 py-1">
            {turn.error}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolStatusPill({
  block,
}: {
  block: { type: "tool"; name: string; status: "running" | "ok" | "error"; error?: string };
}) {
  const base = "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium";
  const tone =
    block.status === "running"
      ? "bg-slate-100 text-slate-600"
      : block.status === "ok"
        ? "bg-emerald-50 text-emerald-700"
        : "bg-rose-50 text-rose-700";
  const dot =
    block.status === "running"
      ? "bg-slate-400 animate-pulse"
      : block.status === "ok"
        ? "bg-emerald-500"
        : "bg-rose-500";
  return (
    <div>
      <span className={clsx(base, tone)}>
        <span className={clsx("inline-block w-1.5 h-1.5 rounded-full", dot)} />
        {block.name}
        {block.status === "error" && block.error ? ` — ${block.error}` : ""}
      </span>
    </div>
  );
}

// --- SSE plumbing ---------------------------------------------------

type SseEvent = { event: string; data: string };

// Minimal SSE parser. Splits the byte stream on blank-line delimiters
// (`\n\n` or `\r\n\r\n` per spec), then picks out `event:` and
// `data:` fields. Ignores comments and retry hints — we don't need
// them here. Multi-line data frames are joined with `\n` as the
// spec dictates. Yields one event at a time to the callback.
async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (ev: SseEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Split on blank-line delimiters. Keep the last (incomplete)
    // chunk in the buffer; emit every complete frame.
    let idx: number;
    // Normalize CRLF to LF so the split logic below stays terse.
    buffer = buffer.replace(/\r\n/g, "\n");
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const parsed = parseFrame(frame);
      if (parsed) onEvent(parsed);
    }
  }
  // Flush a trailing frame (some servers omit the final \n\n).
  const tail = buffer.trim();
  if (tail.length > 0) {
    const parsed = parseFrame(tail);
    if (parsed) onEvent(parsed);
  }
}

function parseFrame(frame: string): SseEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    // Per spec, a single leading space after the colon is stripped.
    const raw = line.slice(colon + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
    // Ignore `id:` / `retry:` — not used here.
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

// --- event dispatch -------------------------------------------------

// Decodes JSON data payloads defensively; a malformed frame gets
// dropped rather than crashing the UI. We only expect the frame
// shapes our own /api/chat emits, so "impossible" cases default
// to no-op.
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function handleEvent(
  ev: SseEvent,
  assistantId: string,
  sessionIdRef: React.MutableRefObject<string | null>,
  setTurns: React.Dispatch<React.SetStateAction<Turn[]>>,
): void {
  const data = parseJson(ev.data);

  if (ev.event === "session") {
    const obj = data as { id?: string } | null;
    if (obj && typeof obj.id === "string") {
      sessionIdRef.current = obj.id;
    }
    return;
  }

  if (ev.event === "text") {
    const obj = data as { delta?: string } | null;
    if (!obj || typeof obj.delta !== "string") return;
    const delta: string = obj.delta;
    setTurns((prev) =>
      prev.map((t) => {
        if (t.kind !== "assistant" || t.id !== assistantId) return t;
        const blocks = [...t.blocks];
        const last = blocks[blocks.length - 1];
        if (last && last.type === "text") {
          blocks[blocks.length - 1] = { ...last, text: last.text + delta };
        } else {
          blocks.push({ type: "text", text: delta });
        }
        return { ...t, blocks };
      }),
    );
    return;
  }

  if (ev.event === "tool") {
    const obj = data as
      | { name?: string; status?: "running" | "ok" | "error"; error?: string }
      | null;
    if (!obj || typeof obj.name !== "string" || !obj.status) return;
    // Narrow once into locals so closures below don't re-widen.
    const toolName: string = obj.name;
    const toolStatus: "running" | "ok" | "error" = obj.status;
    const toolError: string | undefined = obj.error;
    setTurns((prev) =>
      prev.map((t) => {
        if (t.kind !== "assistant" || t.id !== assistantId) return t;
        const blocks = [...t.blocks];
        // Collapse running → ok/error on the same tool if the most
        // recent tool block is a running one for this name.
        const lastIdx = blocks.length - 1;
        const last = blocks[lastIdx];
        if (
          last &&
          last.type === "tool" &&
          last.name === toolName &&
          last.status === "running" &&
          toolStatus !== "running"
        ) {
          blocks[lastIdx] = {
            type: "tool",
            name: toolName,
            status: toolStatus,
            error: toolError,
          };
        } else {
          blocks.push({
            type: "tool",
            name: toolName,
            status: toolStatus,
            error: toolError,
          });
        }
        return { ...t, blocks };
      }),
    );
    return;
  }

  if (ev.event === "directive") {
    if (!data || typeof data !== "object") return;
    const d = data as { kind?: string; props?: Record<string, unknown> };
    if (typeof d.kind !== "string" || !d.props) return;
    const kind: string = d.kind;
    const props: Record<string, unknown> = d.props;
    setTurns((prev) =>
      prev.map((t) => {
        if (t.kind !== "assistant" || t.id !== assistantId) return t;
        return {
          ...t,
          blocks: [
            ...t.blocks,
            { type: "directive", payload: { kind, props } },
          ],
        };
      }),
    );
    return;
  }

  if (ev.event === "error") {
    const obj = data as { message?: string } | null;
    const message =
      obj && typeof obj.message === "string" ? obj.message : "stream_error";
    // `error` is terminal from the server's perspective — the route
    // closes the stream straight after. We also flip `streaming` off
    // here so the animated cursor stops even if a `done` frame
    // never arrives (the outer fallback in `send()` catches that
    // case too, but doing it here means the UI updates mid-stream
    // the instant the error lands, not after the socket drains).
    setTurns((prev) =>
      prev.map((t) =>
        t.kind === "assistant" && t.id === assistantId
          ? { ...t, streaming: false, error: message }
          : t,
      ),
    );
    return;
  }

  if (ev.event === "done") {
    setTurns((prev) =>
      prev.map((t) =>
        t.kind === "assistant" && t.id === assistantId
          ? { ...t, streaming: false }
          : t,
      ),
    );
    return;
  }
}
