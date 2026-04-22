import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { activeTenantIdOf, getCurrentUser } from "@/lib/auth";
import { buildToolCtx } from "@/lib/ai/ctx";
import { refreshLiveSnapshotWidgets } from "@/lib/ai/live-snapshot-widgets";
import { tryRefreshSummaryForSnapshot } from "@/lib/ai/workspace-summary";
import { hydrateSessionHandler } from "./handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Thin wrapper around the pure `hydrateSessionHandler`. All decision
// logic — auth, ownership, transcript + widget fetch, UI-turn
// rebuild — lives in handler.ts where it's covered by unit tests
// without an RSC runtime or real Prisma. This file's only job:
//   1. Extract the `[id]` path param.
//   2. Inject the real deps (getCurrentUser, ChatSession /
//      ChatMessage queries, the full `prisma` client for
//      `listWidgets`).
//   3. Translate the returned `HydrateResult` into NextResponse.

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const me = await getCurrentUser();
  const tenantId = activeTenantIdOf(me);
  if (me && !tenantId) {
    return NextResponse.json({ ok: false, error: "no_active_tenant" }, { status: 400 });
  }
  const result = await hydrateSessionHandler(params.id, {
    getCurrentUser: async () => me,
    findSession: (userId, sessionId) =>
      prisma.chatSession.findFirst({
        where: { id: sessionId, userId, tenantId: tenantId ?? undefined, archivedAt: null },
        select: { id: true, createdAt: true, updatedAt: true },
      }),
    findMessages: (sessionId) =>
      prisma.chatMessage.findMany({
        where: { sessionId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          role: true,
          content: true,
          toolName: true,
          renderDirective: true,
          isError: true,
          createdAt: true,
        },
      }),
    // Pass the full client; the handler's PrismaLike interface
    // structurally matches prisma.chatWidget.{findMany,upsert,...}.
    // `as never` dodges the optional-fields mismatch the generated
    // types carry (same pattern the chat route uses for the
    // workspace emitter).
    prismaLike: prisma as never,
    refreshWidgets: async (widgets) => {
      if (!me) return widgets;
      try {
        const ctx = await buildToolCtx(me);
        return await refreshLiveSnapshotWidgets(
          { prismaLike: prisma as never },
          {
            widgets,
            campaignScope: ctx.campaignScope,
            isAdmin: ctx.isAdmin,
          },
        );
      } catch (error) {
        console.warn(
          `[chat.session] live widget refresh failed`,
          error,
        );
        return widgets;
      }
    },
    buildSummaryWidget: async () => {
      if (!me) return null;
      const ctx = await buildToolCtx(me);
      const outcome = await tryRefreshSummaryForSnapshot(
        { prismaLike: prisma as never },
        { campaignScope: ctx.campaignScope },
      );
      if (outcome.kind === "produced") return outcome.widget;
      if (outcome.kind === "invalid") {
        console.warn(
          `[chat.session] workspace rollup produced invalid props; dropped`,
          { sessionId: params.id },
        );
      } else if (outcome.kind === "error") {
        console.warn(
          `[chat.session] workspace rollup refresh failed`,
          outcome.error,
        );
      }
      return null;
    },
  });

  if (result.kind === "error") {
    return NextResponse.json(result.body, { status: result.status });
  }
  return NextResponse.json(result.body, { status: 200 });
}
