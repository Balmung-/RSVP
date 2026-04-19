"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
} from "react";
import clsx from "clsx";
import { DirectiveRenderer } from "./DirectiveRenderer";
import type { AssistantTurn, Phase, Turn } from "./types";
import type { FormatContext } from "./directives/CampaignList";

// The left rail: transcript + composer. Display-only; all state and
// the actual send / SSE plumbing sits in ChatWorkspace, which hands
// us `turns`, the current `input` value + setter, and an `onSend`
// callback.
//
// Two behaviors live here because they're specifically UI concerns:
//   1. Auto-pin to bottom when `turns` grows. The rail is a scrolling
//      column; without this nudge, a new token delta pushes unread
//      text below the fold on long transcripts.
//   2. Enter-to-send, Shift+Enter for newline. Standard chat UX; the
//      composer is keyboard-first.
//
// Everything else (POST, session id, SSE parsing, workspace events)
// belongs to ChatWorkspace so the rail stays reusable if we ever
// need a chat-only view.

export function ChatRail({
  turns,
  fmt,
  input,
  setInput,
  phase,
  topError,
  onSend,
}: {
  turns: Turn[];
  fmt: FormatContext;
  input: string;
  setInput: (v: string) => void;
  phase: Phase;
  topError: string | null;
  onSend: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns]);

  const canSend = phase === "idle" && input.trim().length > 0;

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (canSend) onSend();
      }
    },
    [canSend, onSend],
  );

  const placeholder = useMemo(
    () =>
      fmt.locale === "ar"
        ? "اسأل أو اكتب أمرًا…"
        : "Ask about campaigns, contacts, activity…",
    [fmt.locale],
  );

  return (
    <div className="flex flex-col h-full min-w-0 border-e border-ink-100 bg-white">
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto px-4 py-6 space-y-6"
      >
        {turns.length === 0 && phase !== "hydrating" && (
          <div className="text-sm text-slate-500 text-center pt-12">
            {fmt.locale === "ar"
              ? "ابدأ محادثة — يمكنني عرض الحملات، وجهات الاتصال، والنشاط."
              : "Start a conversation — I can surface campaigns, contacts, activity."}
          </div>
        )}
        {phase === "hydrating" && turns.length === 0 && (
          <div className="text-sm text-slate-400 text-center pt-12">
            {fmt.locale === "ar" ? "جاري التحميل…" : "Loading…"}
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
            disabled={phase === "streaming" || phase === "hydrating"}
            className="flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:bg-slate-50"
          />
          <button
            type="button"
            onClick={onSend}
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
            // In W2 directives still render inline inside assistant
            // bubbles — the current tool set emits directives, not
            // widgets. W3 migrates tool-by-tool; each migrated kind
            // will stop appearing here and start rendering in the
            // dashboard. We deliberately keep BOTH paths alive
            // through the migration so the bridge doesn't tear.
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
  block: {
    type: "tool";
    name: string;
    status: "running" | "ok" | "error";
    error?: string;
  };
}) {
  const base =
    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium";
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
        <span
          className={clsx("inline-block w-1.5 h-1.5 rounded-full", dot)}
        />
        {block.name}
        {block.status === "error" && block.error ? ` — ${block.error}` : ""}
      </span>
    </div>
  );
}
