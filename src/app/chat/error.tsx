"use client";

import { useEffect, useMemo, useState } from "react";
import {
  deriveChatFatalNotice,
  parseChatHealth,
  type ChatHealthSnapshot,
} from "@/components/chat/chat-health";

export default function ChatError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [health, setHealth] = useState<ChatHealthSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void refreshHealth(setHealth, setLoading);
  }, []);

  const notice = useMemo(
    () =>
      deriveChatFatalNotice({
        locale: "en",
        health,
        fallbackMessage: error.message,
      }),
    [error.message, health],
  );

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <div className="rounded-2xl border border-rose-200 bg-white shadow-sm">
        <div className="border-b border-rose-100 px-6 py-4">
          <h1 className="text-lg font-semibold text-rose-900">{notice.title}</h1>
          <p className="mt-1 text-sm leading-relaxed text-rose-700">{notice.detail}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 px-6 py-4">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            Retry chat
          </button>
          {notice.allowRefreshStatus && (
            <button
              type="button"
              onClick={() => void refreshHealth(setHealth, setLoading)}
              disabled={loading}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:text-slate-400"
            >
              {loading ? "Checking status…" : "Check backend status"}
            </button>
          )}
          {health && (
            <div className="ms-auto text-xs text-slate-500">
              DB: {health.db} · AI: {health.ai.name} ({health.ai.configured ? "ready" : "not ready"})
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

async function refreshHealth(
  setHealth: (value: ChatHealthSnapshot | null) => void,
  setLoading: (value: boolean) => void,
) {
  setLoading(true);
  try {
    const res = await fetch("/api/health", {
      method: "GET",
      credentials: "same-origin",
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    setHealth(parseChatHealth(body));
  } finally {
    setLoading(false);
  }
}
