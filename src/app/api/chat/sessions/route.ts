import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { listSessionsHandler } from "./handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Thin wrapper around the pure `listSessionsHandler`. All decision
// logic (auth, limit parse/clamp, preview derivation) lives in
// handler.ts where it's covered by unit tests without an RSC runtime
// or real Prisma. This file's only job:
//   1. Inject the real deps (getCurrentUser, the Prisma query).
//   2. Translate the returned `ListSessionsResult` into NextResponse.
//
// The Prisma query's shape is pinned HERE (not in the handler) so
// the schema coupling (where/orderBy/select/include) stays next to
// the generated types. The handler consumes the narrow row shape
// the query returns, nothing more.

export async function GET(req: Request) {
  const result = await listSessionsHandler(req, {
    getCurrentUser,
    findSessions: ({ userId, limit }) =>
      prisma.chatSession.findMany({
        where: { userId, archivedAt: null },
        orderBy: { updatedAt: "desc" },
        take: limit,
        select: {
          id: true,
          title: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { messages: true } },
          // First user message for the row's preview. Ordered by
          // createdAt so we get the ORIGINAL ask, not whatever the
          // operator typed most recently. `take: 1` keeps the
          // payload small; the handler only reads `content`.
          messages: {
            where: { role: "user" },
            orderBy: { createdAt: "asc" },
            take: 1,
            select: { content: true },
          },
        },
      }),
  });

  if (result.kind === "error") {
    return NextResponse.json(result.body, { status: result.status });
  }
  return NextResponse.json(result.body, { status: 200 });
}
