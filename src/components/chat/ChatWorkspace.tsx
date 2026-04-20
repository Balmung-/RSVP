"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatRail } from "./ChatRail";
import { WorkspaceDashboard } from "./WorkspaceDashboard";
import { SessionPicker } from "./SessionPicker";
import { selectResumeSessionId } from "./resumeLast";
import type { ClientWidget, FocusRequest, Phase, Turn } from "./types";
import type { FormatContext } from "./directives/CampaignList";
import type { SessionListItem } from "@/app/api/chat/sessions/handler";
import { deriveSessionTitle } from "@/lib/ai/session-title";
import {
  reduceFocusRequest,
  reduceTurns,
  reduceWidgets,
} from "./workspaceReducer";
import {
  SEED_PROMPT_EVENT,
  isSeedPromptEvent,
} from "./seedComposerPrompt";

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
  // P4-B — the picker's session list. Populated on mount and
  // refreshed when a fresh session id appears (after the first send
  // on a new workspace). A failed fetch leaves this empty; the
  // picker degrades to "no recent workspaces" rather than blocking
  // the operator's ability to start a new thread.
  const [sessions, setSessions] = useState<SessionListItem[]>([]);

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

  // P8-B — the dashboard's "seed next action" chips dispatch a
  // CustomEvent on `window`; this listener funnels the event's
  // `prompt` into the composer's input state. Overwrite (not
  // append) so the operator sees exactly what the chip seeded.
  // If they had a partial draft, clicking a chip is an explicit
  // opt-in — the same behavior the rest of the industry's
  // suggested-prompt chips follow (ChatGPT, Linear, etc).
  //
  // The listener is in ChatWorkspace (not ChatRail) because this
  // is where the `input` state lives. ChatRail runs its own tiny
  // sibling effect to focus the textarea so the operator can hit
  // Enter immediately without a manual click.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e: Event) => {
      if (!isSeedPromptEvent(e)) return;
      setInput(e.detail.prompt);
    };
    window.addEventListener(SEED_PROMPT_EVENT, handler);
    return () => window.removeEventListener(SEED_PROMPT_EVENT, handler);
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

  // P4-B — fetch the picker's session list. Called on mount and
  // again after a first send on a fresh workspace produces a new
  // server-assigned id (see the sessionId watch below). Swallows
  // errors on purpose: a failed fetch leaves the picker empty,
  // which is an acceptable degraded state — the operator can still
  // compose in the current workspace.
  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/sessions", {
        credentials: "same-origin",
      });
      if (!res.ok) return;
      const body = (await res.json()) as { sessions?: SessionListItem[] };
      if (Array.isArray(body.sessions)) setSessions(body.sessions);
    } catch {
      /* silent — picker stays empty, not a blocker */
    }
  }, []);

  // Initial fetch. Runs in parallel with the URL-hydrate effect
  // above — both are independent and we don't need to sequence
  // them. The resume-last effect below waits for both signals.
  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  // P4-B — resume-last. If the operator landed on /chat with NO
  // `?session=` in the URL, pick the newest session from the list
  // and hydrate it. Runs at most once (`mountResumedRef`) so a
  // subsequent fetch (e.g. after creating a new session) doesn't
  // re-yank the workspace back to the newest row.
  //
  // Gate: only if sessionId is still null AND turns are empty. If
  // the operator already started typing or clicked a picker item
  // before the list arrived, we don't want to blow their work
  // away by hydrating over it.
  const mountResumedRef = useRef(false);
  useEffect(() => {
    if (mountResumedRef.current) return;
    if (typeof window === "undefined") return;
    const hasUrlSession = new URLSearchParams(window.location.search).get(
      "session",
    );
    if (hasUrlSession) {
      // URL-based hydrate is already in flight from the other
      // mount effect — don't double-hydrate.
      mountResumedRef.current = true;
      return;
    }
    if (sessions.length === 0) return; // wait for list, or nothing to resume
    if (sessionId !== null) {
      // Operator already picked something (or a race against the
      // refresh) — stand down.
      mountResumedRef.current = true;
      return;
    }
    if (turns.length > 0) {
      mountResumedRef.current = true;
      return;
    }
    const resumeId = selectResumeSessionId(sessions);
    mountResumedRef.current = true;
    if (resumeId) void hydrateSession(resumeId);
  }, [sessions, sessionId, turns.length, hydrateSession]);

  // When a fresh session id appears (from the server's `event:
  // session` frame on the first send of a new workspace), the
  // picker's `sessions` list is stale — pull it again so the new
  // row shows up. Gate on "id not already in the list" so this
  // does NOT re-fetch on every hydrate of a known session.
  useEffect(() => {
    if (!sessionId) return;
    if (sessions.some((s) => s.id === sessionId)) return;
    void refreshSessions();
  }, [sessionId, sessions, refreshSessions]);

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

  // ---- dismiss ----------------------------------------------------
  //
  // W7 — operator-initiated removal of a terminal confirm widget
  // from the dashboard. The server is the source of truth: the
  // POST round-trips to /api/chat/dismiss which validates ownership
  // AND the terminal-state gate (kind + state) before deleting the
  // ChatWidget row. On a 200 we apply the same `widget_remove`
  // reducer the SSE path uses so local state converges without a
  // re-hydrate. Failure cases (non-200) leave the widget in place
  // and surface via topError — the most likely refusal here is
  // `not_found` (already dismissed from another tab), which the
  // operator can't fix by retrying, so we display a short message
  // and let the next snapshot reconcile.
  //
  // Why not optimistic-remove-then-POST: a failed POST would need
  // to re-INSERT the widget into state, and the hydration order
  // inside a slot depends on `order + updatedAt`. Racing against
  // a concurrent workspace_snapshot would leave the slot flicker-
  // sorted. Waiting for the 200 is cheap (single DB row delete)
  // and keeps the visible state consistent with persistence.
  const handleDismissWidget = useCallback(
    async (widgetKey: string) => {
      const currentSession = sessionIdRef.current;
      if (!currentSession) return;
      try {
        const res = await fetch("/api/chat/dismiss", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: currentSession, widgetKey }),
          credentials: "same-origin",
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
          return;
        }
        // Reuse the SSE path's reducer to keep one mutation shape.
        // The server already pruned the row; this just drops it
        // from the local array so React re-renders without it.
        setWidgets((prev) =>
          reduceWidgets(prev, {
            event: "widget_remove",
            data: JSON.stringify({ widgetKey }),
          }),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "dismiss_error";
        setTopError(msg);
      }
    },
    [],
  );

  // P4-B — picker callback. `null` = "New workspace": reset to the
  // fresh-session state (null id, empty turns + widgets, URL clear,
  // composer cleared). A non-null id = switch: hydrate the picked
  // session; no-op if it's the current one. We do NOT touch the
  // `sessions` list here — switching sessions doesn't change
  // picker contents.
  const handlePickSession = useCallback(
    (id: string | null) => {
      if (id === null) {
        abortRef.current?.abort();
        setSessionId(null);
        setTurns([]);
        setWidgets([]);
        setInput("");
        setTopError(null);
        setFocusRequest(null);
        return;
      }
      if (id === sessionIdRef.current) return;
      abortRef.current?.abort();
      void hydrateSession(id);
    },
    [hydrateSession, setSessionId],
  );

  // Current title for the picker trigger. Preference order:
  //   1. The server title from the session list (fresh after every
  //      refresh; matches what other tabs would show).
  //   2. A client-derived title from the first user turn, using the
  //      same `deriveSessionTitle` algo the server runs on create.
  //      This is the live-state fallback for the seconds between a
  //      fresh workspace's first send and the next `refreshSessions`.
  //   3. null — SessionPicker then shows its "new workspace" filler.
  const currentTitle = useMemo<string | null>(() => {
    if (sessionId) {
      const row = sessions.find((s) => s.id === sessionId);
      if (row?.title && row.title.length > 0) return row.title;
    }
    const firstUser = turns.find(
      (t): t is Extract<Turn, { kind: "user" }> => t.kind === "user",
    );
    if (firstUser) return deriveSessionTitle(firstUser.text);
    return null;
  }, [sessionId, sessions, turns]);

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
          header={
            <SessionPicker
              sessions={sessions}
              currentSessionId={sessionId}
              currentTitle={currentTitle}
              onPick={handlePickSession}
              fmt={fmt}
            />
          }
        />
      </div>
      <div className="md:order-2 order-1 min-h-0 bg-ink-50">
        <WorkspaceDashboard
          widgets={widgets}
          fmt={fmt}
          phase={phase}
          focusRequest={focusRequest}
          onDismissWidget={handleDismissWidget}
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
