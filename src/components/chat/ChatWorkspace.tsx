"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatRail } from "./ChatRail";
import { WorkspaceDashboard } from "./WorkspaceDashboard";
import type { ClientWidget, FocusRequest, Phase, Turn } from "./types";
import type { FormatContext } from "./directives/CampaignList";
import {
  reduceFocusRequest,
  reduceTurns,
  reduceWidgets,
} from "./workspaceReducer";

// The split-workspace orchestrator for /chat (W2).
//
// Role in the component tree:
//   page.tsx (RSC) -> Shell -> ChatWorkspace -> { ChatRail | WorkspaceDashboard }
//
// Responsibilities (everything that isn't pure presentation):
//   1. Own `sessionId` in STATE (not a ref) so the URL stays in
//      sync with the reactive value. The URL is updated via
//      history.replaceState, not router.push — we don't want a
//      navigation event for what is effectively a local state
//      change.
//   2. Own `turns` and `widgets`. Turns are appended / updated
//      block-by-block from SSE deltas; widgets are replaced
//      wholesale on `workspace_snapshot` and patched on
//      `widget_upsert` / `widget_remove`.
//   3. Mount-time hydration: if the URL carries `?session={id}`,
//      fetch GET /api/chat/session/{id} and populate state before
//      the first composer input. A 404 silently falls back to
//      "fresh session" (URL cleared, everything empty).
//   4. Send: POST /api/chat, parse SSE, dispatch every event kind
//      onto the right reducer. All workspace events land here
//      (snapshot/upsert/remove/focus) — the rail never sees them.
//
// Design principles kept from the pre-W2 ChatPanel:
//   - Append-only turns. The last assistant turn is the only one
//     mutated as tokens stream; older turns are frozen.
//   - Server is authoritative for session id. We don't invent one
//     on the client; the server emits `event: session` on the first
//     message of a fresh conversation and we pin that.
//   - No external SSE dep. Tiny parser at the bottom of the file.

export function ChatWorkspace({ fmt }: { fmt: FormatContext }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [widgets, setWidgets] = useState<ClientWidget[]>([]);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [topError, setTopError] = useState<string | null>(null);
  const [sessionId, setSessionIdState] = useState<string | null>(null);
  // W4: pending focus request from the latest `widget_focus` frame.
  // The seq counter below bumps every time so React's effect in
  // WorkspaceDashboard fires even when the same widgetKey is focused
  // twice in a row (refining a filter twice should re-focus twice).
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);

  // Latest sessionId for use inside async SSE callbacks. Keeping a
  // mirror ref avoids the closure-over-state stale-value trap when
  // the send() callback kicks off a fetch that outlives a re-render.
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Single setter that keeps state, ref, and URL in sync. The URL
  // update is optional — some callers (initial hydrate fetch,
  // 404-fallback reset) don't need to rewrite history.
  const setSessionId = useCallback(
    (next: string | null, opts: { updateUrl?: boolean } = {}) => {
      setSessionIdState(next);
      sessionIdRef.current = next;
      if (opts.updateUrl !== false && typeof window !== "undefined") {
        const url = new URL(window.location.href);
        if (next) {
          url.searchParams.set("session", next);
        } else {
          url.searchParams.delete("session");
        }
        // replaceState (not pushState) so the browser back button
        // doesn't step through every session change. A /chat page
        // with sessions is still ONE page from the nav's perspective.
        window.history.replaceState(null, "", url.toString());
      }
    },
    [],
  );

  // ---- mount hydration --------------------------------------------

  useEffect(() => {
    // Cancel any in-flight stream if the page unmounts. Same
    // defensive cleanup as the pre-W2 ChatPanel.
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    // Read `?session=` once on mount. We deliberately don't use
    // `useSearchParams` here — that hook tracks ongoing changes
    // and would re-fire when WE update the URL via replaceState
    // (causing a re-hydrate loop). One-shot read is what we want.
    if (typeof window === "undefined") return;
    const initial = new URLSearchParams(window.location.search).get(
      "session",
    );
    if (!initial) return;
    void hydrateSession(initial);
    // ESLint would want hydrateSession in the dep array; stable
    // closure over primitives only, so the miss is harmless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hydrateSession = useCallback(
    async (id: string) => {
      setPhase("hydrating");
      setTopError(null);
      try {
        const res = await fetch(`/api/chat/session/${encodeURIComponent(id)}`, {
          method: "GET",
          credentials: "same-origin",
        });
        if (res.status === 404) {
          // Stale / foreign / archived session id in the URL.
          // Silent reset — no error banner — so a user who
          // bookmarked a dead link just gets a fresh /chat.
          setSessionId(null);
          setTurns([]);
          setWidgets([]);
          return;
        }
        if (!res.ok) {
          let message = `HTTP ${res.status}`;
          try {
            const body = (await res.json()) as { error?: string };
            if (body?.error) message = body.error;
          } catch {
            /* keep HTTP code */
          }
          setTopError(message);
          return;
        }
        const data = (await res.json()) as {
          session: { id: string };
          turns: Turn[];
          widgets: ClientWidget[];
        };
        // Hydrated turns carry `streaming: false` by construction
        // (the server transform pins it), so they won't flicker
        // a pulsing cursor on arrival.
        setTurns(data.turns);
        setWidgets(data.widgets);
        setSessionId(data.session.id, { updateUrl: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "hydrate_error";
        setTopError(msg);
      } finally {
        setPhase("idle");
      }
    },
    [setSessionId],
  );

  // ---- send -------------------------------------------------------

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || phase !== "idle") return;

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
        let message = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) message = body.error;
        } catch {
          /* keep code */
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
        handleEvent(ev, {
          assistantId: asstId,
          setSessionId,
          setTurns,
          setWidgets,
          setFocusRequest,
        });
      });
      // Belt-and-braces: if the stream ended without `done`, clear
      // the streaming flag so the pulsing cursor stops.
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
  }, [input, phase, setSessionId]);

  return (
    <div
      // Height budget: viewport minus header (h-14) minus compact
      // title block (pt-6 pb-2 ~ 3rem) minus a small breathing
      // margin. The grid collapses to a single column below `md`
      // with the dashboard stacked ABOVE the rail — operators on
      // mobile need the composer pinned to the bottom, and a
      // dashboard-below-composer layout would hide new widgets
      // behind the on-screen keyboard.
      className="grid h-[calc(100vh-7rem)] grid-rows-[auto_1fr] gap-0 md:grid-rows-1 md:grid-cols-[minmax(360px,420px)_1fr]"
    >
      <div className="md:order-1 order-2 min-h-0">
        <ChatRail
          turns={turns}
          fmt={fmt}
          input={input}
          setInput={setInput}
          phase={phase}
          topError={topError}
          onSend={() => void send()}
        />
      </div>
      <div className="md:order-2 order-1 min-h-0 bg-ink-50">
        <WorkspaceDashboard
          widgets={widgets}
          fmt={fmt}
          phase={phase}
          focusRequest={focusRequest}
        />
      </div>
    </div>
  );
}

// ---- helpers --------------------------------------------------------

function newId(): string {
  return `t_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

// ---- SSE plumbing --------------------------------------------------
//
// Minimal SSE parser + event dispatcher. Duplicated from the pre-W2
// ChatPanel but extended to cover the W1 workspace frames
// (`workspace_snapshot`, `widget_upsert`, `widget_remove`,
// `widget_focus`). Keeping the dispatcher a single function
// (rather than registering per-event handlers) keeps the turn /
// widget reducers side-by-side for easy reasoning.

type SseEvent = { event: string; data: string };

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
    let idx: number;
    buffer = buffer.replace(/\r\n/g, "\n");
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const parsed = parseFrame(frame);
      if (parsed) onEvent(parsed);
    }
  }
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
    const raw = line.slice(colon + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

type EventDeps = {
  assistantId: string;
  setSessionId: (id: string | null, opts?: { updateUrl?: boolean }) => void;
  setTurns: React.Dispatch<React.SetStateAction<Turn[]>>;
  setWidgets: React.Dispatch<React.SetStateAction<ClientWidget[]>>;
  setFocusRequest: React.Dispatch<React.SetStateAction<FocusRequest | null>>;
};

// W6 — the three `reduce*` functions live in ./workspaceReducer.ts as
// pure state-transition helpers so they can be unit-tested without a
// React harness. Every non-session SSE event touches exactly one of
// {turns, widgets, focusRequest}, so funnelling each event through all
// three reducers (each a no-op for events they don't recognise) is
// cheaper than dispatching — React bails out of the unchanged-slice
// re-renders when the reducer returns the same reference.
//
// `session` stays special-cased here because it has a URL side effect
// (history.replaceState) the pure reducers deliberately don't own.
function handleEvent(ev: SseEvent, deps: EventDeps): void {
  const { assistantId, setSessionId, setTurns, setWidgets, setFocusRequest } =
    deps;

  if (ev.event === "session") {
    let obj: { id?: string } | null = null;
    try {
      obj = JSON.parse(ev.data) as { id?: string } | null;
    } catch {
      obj = null;
    }
    if (obj && typeof obj.id === "string") {
      // Updating the URL here — this is the moment the server
      // first tells us the session id, either on a fresh create or
      // on a known-session POST.
      setSessionId(obj.id);
    }
    return;
  }

  setTurns((prev) => reduceTurns(prev, ev, { assistantId }));
  setWidgets((prev) => reduceWidgets(prev, ev));
  setFocusRequest((prev) => reduceFocusRequest(prev, ev));
}
