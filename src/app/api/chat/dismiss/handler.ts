import type { User } from "@prisma/client";
import type { WidgetRow } from "@/lib/ai/widgets";
import { rowToWidget } from "@/lib/ai/widgets";
import { isTerminalConfirmWidget } from "@/lib/ai/widget-validate";

// Pure handler for POST /api/chat/dismiss.
//
// The accompanying route.ts exports a thin POST wrapper that injects
// real deps (getCurrentUser, rateLimit, prisma.chatWidget.findFirst
// with the session-owned join, removeWidget from widgets.ts) and
// forwards the returned `DismissResult` into NextResponse.json.
//
// This file is PURE: no Next.js imports, no Prisma import, no
// process.env reads. Every side-effect surface is injected via
// `deps`. Tests verify each branch — auth gate, rate limit, bad
// body, not-found (ownership-fenced), corrupt row, non-dismissable
// kind/state, success — with plain stubs, no RSC runtime and no
// real database.
//
// Why a dedicated dismiss endpoint (not "just delete the widget
// row"):
//   - The workspace widget table holds rows for SIX kinds. Five of
//     them are LIVE VIEWS — campaign lists, contact tables,
//     activity streams — that the operator shouldn't be able to
//     accidentally close. Only the two confirm kinds
//     (confirm_draft, confirm_send) are dismissable, and only when
//     they're in a terminal state. The gate here mirrors the
//     renderer-side gate (isTerminalConfirmWidget) so UI never
//     shows a ✕ the server will refuse.
//   - The dispatch POST has no open SSE channel on the response —
//     we call `removeWidget(...)` directly against the DB rather
//     than emitter.remove (which fires a widget_remove frame). The
//     client applies its own local `reduceWidgets({event: "widget_remove", ...})`
//     on a 200 response, which keeps the per-tab state consistent
//     without needing a live stream.
//   - Ownership is enforced by a session-join on the widget lookup
//     (`session: { userId: me.id }`). A row belonging to someone
//     else's session collapses to `not_found` — not `forbidden` —
//     so a probe can't differentiate "no such widget" from "not
//     yours". Same pattern the confirm route uses.
//
// Refusal vocabulary:
//   - 401 unauthorized        — no session cookie
//   - 429 rate_limited        — shared chat bucket burst exceeded
//   - 400 bad_body            — POST body missing / not JSON
//   - 400 bad_session_id      — body.sessionId missing / wrong type
//   - 400 bad_widget_key      — body.widgetKey missing / wrong type
//   - 404 not_found           — widget missing OR not owned by user
//   - 400 corrupt_row         — stored props failed re-validation
//   - 400 not_dismissable     — wrong kind or non-terminal state
//   - 200 {ok: true, removed} — removeWidget returned; `removed`
//                               reflects whether a row actually
//                               vanished (false on a race where a
//                               parallel dismiss won).

// ---- Types --------------------------------------------------------

export type DismissResult = {
  status: number;
  body: Record<string, unknown>;
};

export interface DismissDeps {
  getCurrentUser: () => Promise<User | null>;
  // Returns the rate-limit decision for this user's chat bucket.
  // The caller pins the bucket key and capacity; handler only
  // consumes `{ok, retryAfterMs}`. Shared with the confirm route
  // so a burst of confirm+dismiss interleaves against one budget.
  checkRateLimit: (userId: string) => {
    ok: boolean;
    retryAfterMs: number;
  };
  // Ownership-fenced widget lookup. The real wrapper joins on
  // `session.userId` so a widget from someone else's session is
  // indistinguishable from a missing row. Returns the narrow
  // `WidgetRow` shape so this handler can pass it straight into
  // `rowToWidget` without a second translation layer.
  findWidgetForUser: (args: {
    sessionId: string;
    widgetKey: string;
    userId: string;
  }) => Promise<WidgetRow | null>;
  // Idempotent delete — returns `{removed: false}` if a concurrent
  // dismiss already swept the row. Matches removeWidget's contract
  // in widgets.ts so the route can forward the flag unchanged.
  removeWidget: (
    sessionId: string,
    widgetKey: string,
  ) => Promise<{ removed: boolean }>;
}

// ---- Helpers ------------------------------------------------------

async function readBody(
  req: Request,
): Promise<{ sessionId: unknown; widgetKey: unknown } | null> {
  try {
    const raw = (await req.json()) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    return { sessionId: obj.sessionId, widgetKey: obj.widgetKey };
  } catch {
    return null;
  }
}

// ---- Handler ------------------------------------------------------

export async function dismissHandler(
  req: Request,
  deps: DismissDeps,
): Promise<DismissResult> {
  const me = await deps.getCurrentUser();
  if (!me) {
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }

  const rl = deps.checkRateLimit(me.id);
  if (!rl.ok) {
    return {
      status: 429,
      body: {
        ok: false,
        error: "rate_limited",
        retryAfterMs: rl.retryAfterMs,
      },
    };
  }

  const body = await readBody(req);
  if (!body) {
    return { status: 400, body: { ok: false, error: "bad_body" } };
  }
  if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
    return { status: 400, body: { ok: false, error: "bad_session_id" } };
  }
  if (typeof body.widgetKey !== "string" || body.widgetKey.length === 0) {
    return { status: 400, body: { ok: false, error: "bad_widget_key" } };
  }
  const sessionId: string = body.sessionId;
  const widgetKey: string = body.widgetKey;

  // Ownership check + existence check in one query. A row from
  // someone else's session is `not_found` — never `forbidden` — so
  // an attacker can't probe for valid (sessionId, widgetKey) pairs.
  const row = await deps.findWidgetForUser({
    sessionId,
    widgetKey,
    userId: me.id,
  });
  if (!row) {
    return { status: 404, body: { ok: false, error: "not_found" } };
  }

  // Re-validate the stored props. rowToWidget returns null on a
  // drifted blob — refuse rather than sweep a row we can't confirm
  // is actually a terminal confirm widget. Keeps the dismiss gate
  // honest even if a future migration lands a schema change
  // without a corresponding data rewrite.
  const widget = rowToWidget(row);
  if (!widget) {
    return { status: 400, body: { ok: false, error: "corrupt_row" } };
  }

  if (!isTerminalConfirmWidget(widget.kind, widget.props)) {
    return {
      status: 400,
      body: { ok: false, error: "not_dismissable" },
    };
  }

  const result = await deps.removeWidget(sessionId, widgetKey);
  return {
    status: 200,
    body: { ok: true, removed: result.removed },
  };
}
