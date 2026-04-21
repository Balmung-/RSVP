// Session-activity touchpoint. Called after any child-row write
// that should count as "activity in this session" so the session
// picker / resume-last / GET /api/chat/sessions ordering key
// (ChatSession.updatedAt DESC) stays honest.
//
// The problem this fixes:
//
//   `ChatSession.updatedAt` has Prisma's `@updatedAt` attribute,
//   which sets it to NOW() on any `prisma.chatSession.update(...)`
//   call — but NOT on child-row writes. Writing a new `ChatMessage`
//   row, upserting a widget, or claiming a confirm row are all
//   UPDATES/INSERTS on child tables; none of them tick the parent
//   session's `updatedAt`.
//
//   Before this fix, the picker kept sorting old sessions ahead of
//   recently-active ones because the parent row's timestamp stayed
//   frozen at creation time. Resume-last could reopen the wrong
//   session for the same reason.
//
// Design choices:
//
//   - `updatedAt: new Date()` is set EXPLICITLY in `data` rather
//     than relying on Prisma's `@updatedAt` auto-stamp of the
//     update itself. Both would work (Prisma touches the column
//     on any update regardless of whether `data` names it), but
//     explicit-set self-documents the intent at the callsite:
//     someone reading this helper doesn't need to remember what
//     `@updatedAt` does at an empty-data update.
//   - `select: { id: true }` keeps the round-trip narrow — we
//     don't need the full row back, and `update` requires a
//     returning shape.
//   - Errors are SWALLOWED and logged. A stale `updatedAt` is a
//     UX hint, not a correctness invariant: failing the request
//     because the recency-bump hit a constraint is strictly worse
//     than eating the warning. The write that preceded this call
//     (message row, widget, etc.) is already durable at this
//     point.
//   - The function takes a narrow structural `SessionActivityPrisma`
//     shape rather than the full Prisma client so unit tests can
//     stub it without standing up the DB.

export type SessionActivityPrisma = {
  chatSession: {
    update: (args: {
      where: { id: string };
      data: { updatedAt: Date };
      select: { id: true };
    }) => Promise<{ id: string }>;
  };
};

export async function touchChatSession(
  prismaLike: SessionActivityPrisma,
  sessionId: string,
): Promise<void> {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    // Defensive: the route should never hand us an empty id, but
    // if it does (e.g. a cold code path that passed a null-coerced
    // value) we don't want Prisma's where-matches-nothing to
    // quietly fail with a P2025. Short-circuit.
    return;
  }
  try {
    await prismaLike.chatSession.update({
      where: { id: sessionId },
      data: { updatedAt: new Date() },
      select: { id: true },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[chat] touchChatSession failed", {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
