import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { rateLimit } from "@/lib/ratelimit";
import { prisma } from "@/lib/db";
import { removeWidget } from "@/lib/ai/widgets";
import { dismissHandler } from "./handler";

// Thin wrapper around the pure `dismissHandler`. All decision logic
// — auth gate, rate limit, body parse, ownership-fenced widget
// lookup, terminal-state gate, removal — lives in handler.ts where
// it's covered by unit tests without an RSC runtime or real Prisma.
//
// This file's only job:
//   1. Inject the real deps (getCurrentUser, rateLimit bound to the
//      shared chat bucket, prisma.chatWidget.findFirst with the
//      session-owned join, removeWidget from widgets.ts).
//   2. Translate the returned `DismissResult` into a NextResponse.
//
// Keep this wrapper trivial. Any new "why" comment belongs in
// handler.ts so the tests and the production path share the same
// narrative.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const { status, body } = await dismissHandler(req, {
    getCurrentUser,
    // Share the chat bucket. A dismiss is cheap compared to a
    // chat turn, but it STILL consumes a token so a tab that
    // spams dismiss can't drown out the user's next message. Same
    // capacity + refill the confirm route uses (see
    // src/app/api/chat/confirm/[messageId]/route.ts).
    checkRateLimit: (userId) =>
      rateLimit(`chat:${userId}`, { capacity: 8, refillPerSec: 0.3 }),
    // Ownership is enforced in the `where` clause: join on
    // `session.userId` so a foreign row is indistinguishable from
    // a missing row. The explicit `select` pins the row shape to
    // what `rowToWidget` in widgets.ts expects — picking columns
    // by name so a future ChatWidget migration that adds a
    // column can't accidentally leak it here.
    findWidgetForUser: ({ sessionId, widgetKey, userId }) =>
      prisma.chatWidget.findFirst({
        where: {
          sessionId,
          widgetKey,
          session: { userId },
        },
        select: {
          id: true,
          sessionId: true,
          widgetKey: true,
          kind: true,
          slot: true,
          props: true,
          order: true,
          sourceMessageId: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    removeWidget: (sessionId, widgetKey) =>
      removeWidget({ prismaLike: prisma }, sessionId, widgetKey),
  });

  return NextResponse.json(body, { status });
}
