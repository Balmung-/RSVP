import type { ListSessionsRow } from "./handler";

// Prisma query builder for GET /api/chat/sessions.
//
// Extracted out of route.ts so the query shape — especially the
// _count relation filter that excludes tool rows — is unit-testable
// without a real DB. route.ts just wires `buildFindSessions(prisma)`
// into the handler's `findSessions` dep.
//
// Why a separate module (not inline in route.ts):
//
//   The picker's `messageCount` badge must reflect OPERATOR-VISIBLE
//   turns, not raw ChatMessage rows. One operator ask that triggers
//   four tool calls would otherwise appear as 7+ "messages"
//   (1 user + 4 tool + 2 assistant), which is wildly misleading —
//   the operator sees 2 bubbles in the rail (their question + the
//   summary), not 7. The role filter inside `_count.messages.where`
//   is load-bearing for that UX.
//
//   A pure unit test can stub the Prisma client and verify the
//   findMany call carries `_count.select.messages.where.role.in =
//   ["user", "assistant"]`, which is cheaper and tighter than
//   spinning up a real DB.

// Role values that count as operator-visible turns. The ChatMessage
// schema has three: "user", "assistant", "tool". Tool rows are an
// implementation detail of tool-use fan-out (one row per tool call)
// and MUST NOT inflate the picker badge. Include-list rather than
// exclude-list so a future new role ("system", etc.) doesn't
// silently start counting until we audit whether it should.
export const OPERATOR_VISIBLE_ROLES = ["user", "assistant"] as const;

// Narrow structural interface for the Prisma client — just the one
// `chatSession.findMany` surface we need, with args typed loosely
// enough to accept both the real Prisma client and a test stub. The
// test stub captures the args object for inspection; the real client
// ignores extra fields the way Prisma normally does.
export type FindSessionsArgs = {
  where: { userId: string; tenantId: string; archivedAt: null };
  orderBy: { updatedAt: "desc" };
  take: number;
  select: {
    id: true;
    title: true;
    createdAt: true;
    updatedAt: true;
    _count: {
      select: {
        messages: {
          where: { role: { in: readonly string[] } };
        };
      };
    };
    messages: {
      where: { role: "user" };
      orderBy: { createdAt: "asc" };
      take: 1;
      select: { content: true };
    };
  };
};

export type PrismaSessionFinder = {
  chatSession: {
    findMany: (args: FindSessionsArgs) => Promise<ListSessionsRow[]>;
  };
};

export function buildFindSessions(
  prismaLike: PrismaSessionFinder,
): (args: { userId: string; tenantId: string; limit: number }) => Promise<ListSessionsRow[]> {
  return ({ userId, tenantId, limit }) =>
    prismaLike.chatSession.findMany({
      where: { userId, tenantId, archivedAt: null },
      orderBy: { updatedAt: "desc" },
      take: limit,
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            // Operator-visible turns only — tool fan-out would
            // otherwise inflate the picker badge. See the
            // OPERATOR_VISIBLE_ROLES comment above for the full
            // rationale.
            messages: {
              where: { role: { in: OPERATOR_VISIBLE_ROLES } },
            },
          },
        },
        messages: {
          where: { role: "user" },
          orderBy: { createdAt: "asc" },
          take: 1,
          select: { content: true },
        },
      },
    });
}
