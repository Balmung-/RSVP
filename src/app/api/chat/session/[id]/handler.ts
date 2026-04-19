// Pure session-hydration handler for GET /api/chat/session/[id].
//
// Split out of route.ts so the decision logic (auth, ownership,
// transform, widget read) sits under unit tests without touching
// Next's RSC runtime or a real Prisma. The route file is a thin
// wrapper that injects the real deps and translates the structured
// result into a NextResponse.
//
// Contract:
//   - 401 if unauthenticated
//   - 404 if the session id doesn't exist, is archived, or belongs
//     to another user (we deliberately DO NOT distinguish
//     "not-found" from "not-yours" so an attacker can't probe ids)
//   - 200 otherwise, with `{session, turns, widgets, skipped}`
//
// `turns` is the same block-level shape the live stream builds up
// in ChatPanel; the client can set state to it without any further
// transformation. `widgets` is the same `Widget[]` shape
// `workspace_snapshot` emits. `skipped` counts widget rows that
// failed read-side revalidation.

import type { ChatMessage, ChatSession } from "@prisma/client";
import { rebuildUiTurns, type UiTurn, type UiTranscriptRow } from "@/lib/ai/transcript-ui";
import type { PrismaLike, Widget } from "@/lib/ai/widgets";
import { listWidgets } from "@/lib/ai/widgets";

// Cap on transcript rows loaded for hydration. A pathological
// session with thousands of rows would choke both the API response
// and the client render; cap at 500 rows = ~125 assistant turns
// which covers a full week of heavy use. Older rows stay in the DB
// and are still fed to the model via `/api/chat`'s own HISTORY_TAIL
// bound.
const HYDRATION_ROW_CAP = 500;

export type HydrateUser = { id: string };

export type HydrateResultOk = {
  kind: "ok";
  body: {
    session: { id: string; createdAt: string; updatedAt: string };
    turns: UiTurn[];
    widgets: Widget[];
    skipped: number;
  };
};

export type HydrateResultError = {
  kind: "error";
  status: 401 | 404;
  body: { ok: false; error: string };
};

export type HydrateResult = HydrateResultOk | HydrateResultError;

export type HydrateDeps = {
  getCurrentUser: () => Promise<HydrateUser | null>;
  findSession: (
    userId: string,
    sessionId: string,
  ) => Promise<Pick<ChatSession, "id" | "createdAt" | "updatedAt"> | null>;
  findMessages: (
    sessionId: string,
  ) => Promise<
    Array<
      Pick<
        ChatMessage,
        | "id"
        | "role"
        | "content"
        | "toolName"
        | "renderDirective"
        | "isError"
        | "createdAt"
      >
    >
  >;
  // The widgets helper we already ship — we reuse `listWidgets` here
  // rather than a second SELECT, so drift-skip and prop revalidation
  // stay in one place.
  prismaLike: PrismaLike;
};

export async function hydrateSessionHandler(
  sessionId: string,
  deps: HydrateDeps,
): Promise<HydrateResult> {
  if (!sessionId || typeof sessionId !== "string") {
    // An empty path param shouldn't reach us (Next routes `/`-only
    // traffic to page files, not dynamic routes), but a hand-crafted
    // request could still land here — treat as "not found" to match
    // the ownership-probe defence.
    return { kind: "error", status: 404, body: { ok: false, error: "not_found" } };
  }

  const me = await deps.getCurrentUser();
  if (!me) {
    return {
      kind: "error",
      status: 401,
      body: { ok: false, error: "unauthorized" },
    };
  }

  const session = await deps.findSession(me.id, sessionId);
  if (!session) {
    return {
      kind: "error",
      status: 404,
      body: { ok: false, error: "not_found" },
    };
  }

  // Fetch the transcript rows and widgets in parallel. Both queries
  // are tenant-scoped by the prior ownership check so neither can
  // leak across users.
  const [rawRows, widgetResult] = await Promise.all([
    deps.findMessages(session.id),
    listWidgets({ prismaLike: deps.prismaLike }, session.id),
  ]);

  // Trim to HYDRATION_ROW_CAP by keeping the MOST-RECENT rows. The
  // client displays newest-at-bottom, so dropping the oldest is the
  // right UX — the operator sees the last N turns, not the first N.
  const rows =
    rawRows.length > HYDRATION_ROW_CAP
      ? rawRows.slice(rawRows.length - HYDRATION_ROW_CAP)
      : rawRows;

  const transcriptRows: UiTranscriptRow[] = rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    toolName: r.toolName,
    renderDirective: r.renderDirective,
    isError: r.isError,
  }));

  const turns = rebuildUiTurns(transcriptRows);

  return {
    kind: "ok",
    body: {
      session: {
        id: session.id,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
      },
      turns,
      widgets: widgetResult.widgets,
      skipped: widgetResult.skipped,
    },
  };
}
