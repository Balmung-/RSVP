import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
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
  const result = await hydrateSessionHandler(params.id, {
    getCurrentUser,
    findSession: (userId, sessionId) =>
      prisma.chatSession.findFirst({
        where: { id: sessionId, userId, archivedAt: null },
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
  });

  if (result.kind === "error") {
    return NextResponse.json(result.body, { status: result.status });
  }
  return NextResponse.json(result.body, { status: 200 });
}
