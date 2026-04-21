"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import clsx from "clsx";
import { DirectiveRenderer } from "./DirectiveRenderer";
import type { AssistantTurn, Phase, Turn } from "./types";
import type { FormatContext } from "./directives/CampaignList";
import {
  appendReference,
  formatFileReference,
  uploadErrorMessage,
  type UploadResponse,
} from "./uploadReference";
import {
  deriveChatSystemNotice,
  type ChatHealthSnapshot,
} from "./chat-health";
import { SEED_PROMPT_EVENT, isSeedPromptEvent } from "./seedComposerPrompt";
import { Icon } from "@/components/Icon";

// The left rail: transcript + composer. Display-only; all state and
// the actual send / SSE plumbing sits in ChatWorkspace, which hands
// us `turns`, the current `input` value + setter, and an `onSend`
// callback.
//
// Behaviors that live here because they're specifically UI concerns:
//   1. Auto-pin to bottom when `turns` grows.
//   2. Enter-to-send, Shift+Enter for newline.
//   3. Upload affordance (P5-followup) — POSTs the picked file to
//      /api/uploads and appends a short reference token to the
//      composer. Extraction happens server-side; the token is just a
//      human-visible anchor so the operator can refer to the file
//      in prose. Local state only: upload errors and in-flight
//      status never leak into the session's `topError`.
//
// Everything else (session POST, SSE parsing, workspace events)
// belongs to ChatWorkspace so the rail stays reusable if we ever
// need a chat-only view.

export function ChatRail({
  turns,
  fmt,
  input,
  setInput,
  phase,
  topError,
  health,
  healthLoading,
  onRefreshHealth,
  onSend,
  header,
}: {
  turns: Turn[];
  fmt: FormatContext;
  input: string;
  setInput: (v: string) => void;
  phase: Phase;
  topError: string | null;
  health: ChatHealthSnapshot | null;
  healthLoading: boolean;
  onRefreshHealth: () => void;
  onSend: () => void;
  // P4-B — optional slot rendered above the transcript. ChatWorkspace
  // mounts the SessionPicker here; passing ReactNode keeps this rail
  // ignorant of the picker's props (sessions list, currentTitle, etc.)
  // and reusable in a chat-only view where sessions don't exist.
  header?: ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns]);

  // P8-B — when a workspace chip seeds a prompt, focus the
  // textarea so the operator can hit Enter immediately without a
  // manual click. ChatWorkspace updates the input text via its own
  // sibling listener on the same event; this one handles focus.
  //
  // `setTimeout(..., 0)` defers the focus() call until after React
  // has applied the `setInput(prompt)` state update, so the caret
  // lands at the end of the seeded text rather than before it.
  // Without the defer, a fast click could focus an empty textarea
  // a tick before the text arrives, which is visually janky.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e: Event) => {
      if (!isSeedPromptEvent(e)) return;
      const el = textareaRef.current;
      if (!el) return;
      window.setTimeout(() => {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }, 0);
    };
    window.addEventListener(SEED_PROMPT_EVENT, handler);
    return () => window.removeEventListener(SEED_PROMPT_EVENT, handler);
  }, []);

  const canSend = phase === "idle" && input.trim().length > 0;
  const canUpload = phase === "idle" && !uploading;

  const handleFilePick = useCallback(
    async (file: File) => {
      setUploading(true);
      setUploadError(null);
      try {
        const form = new FormData();
        form.append("file", file);
        form.append("kind", "doc");
        const res = await fetch("/api/uploads", {
          method: "POST",
          body: form,
          credentials: "same-origin",
        });
        const body = (await res.json()) as UploadResponse;
        if (!res.ok || !body.ok) {
          const message =
            !body.ok && typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
          setUploadError(message);
          return;
        }
        const ref = formatFileReference(body.filename, body.ingest);
        setInput(appendReference(input, ref));
      } catch (err) {
        setUploadError(uploadErrorMessage(err));
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [input, setInput],
  );

  const triggerFilePicker = useCallback(() => {
    if (!canUpload) return;
    fileInputRef.current?.click();
  }, [canUpload]);

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

  const systemNotice = useMemo(
    () =>
      deriveChatSystemNotice({
        locale: fmt.locale,
        topError,
        health,
      }),
    [fmt.locale, health, topError],
  );

  return (
    <div className="flex flex-col h-full min-w-0 border-e border-ink-100 bg-white">
      {header && (
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
          {header}
        </div>
      )}
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

      {systemNotice && (
        <div className="px-4 pb-2">
          <div
            className={clsx(
              "rounded-md border text-sm px-3 py-2",
              systemNotice.tone === "danger"
                ? "border-rose-200 bg-rose-50 text-rose-900"
                : "border-amber-200 bg-amber-50 text-amber-900",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium">{systemNotice.title}</div>
                <div
                  className={clsx(
                    "mt-0.5 text-xs leading-relaxed",
                    systemNotice.tone === "danger"
                      ? "text-rose-700"
                      : "text-amber-800",
                  )}
                >
                  {systemNotice.detail}
                </div>
              </div>
              {systemNotice.allowRefreshStatus && (
                <button
                  type="button"
                  onClick={onRefreshHealth}
                  disabled={healthLoading}
                  className={clsx(
                    "shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium",
                    systemNotice.tone === "danger"
                      ? "border-rose-300 text-rose-800 hover:bg-rose-100 disabled:text-rose-400"
                      : "border-amber-300 text-amber-900 hover:bg-amber-100 disabled:text-amber-500",
                  )}
                >
                  {healthLoading
                    ? fmt.locale === "ar"
                      ? "جارٍ الفحص…"
                      : "Checking…"
                    : fmt.locale === "ar"
                      ? "تحقق الآن"
                      : "Check now"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {uploadError && (
        <div className="px-4 pb-2">
          <div className="rounded-md border border-amber-200 bg-amber-50 text-amber-800 text-sm px-3 py-2 flex items-center justify-between gap-2">
            <span>
              {fmt.locale === "ar" ? "تعذّر الرفع" : "Upload failed"} — {uploadError}
            </span>
            <button
              type="button"
              onClick={() => setUploadError(null)}
              className="text-amber-700 hover:text-amber-900"
              aria-label={fmt.locale === "ar" ? "إغلاق" : "Dismiss"}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>
      )}

      <div className="border-t border-slate-200 bg-white px-4 py-3">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFilePick(file);
          }}
        />
        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={triggerFilePicker}
            disabled={!canUpload}
            title={fmt.locale === "ar" ? "رفع ملف" : "Upload file"}
            aria-label={fmt.locale === "ar" ? "رفع ملف" : "Upload file"}
            className={clsx(
              "rounded-md px-2 py-2",
              canUpload
                ? "text-slate-600 hover:bg-slate-100"
                : "text-slate-300 cursor-not-allowed",
            )}
          >
            <Icon name={uploading ? "spinner" : "upload"} size={18} className={uploading ? "animate-spin" : undefined} />
          </button>
          <textarea
            ref={textareaRef}
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
