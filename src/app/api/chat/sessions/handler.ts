import type { ChatSession } from "@prisma/client";

// Pure handler for GET /api/chat/sessions.
//
// Returns the caller's recent, non-archived chat sessions in
// updatedAt-desc order so the workspace picker can surface the most
// recently-touched thread first. Every decision — auth, cap, the
// tiny "first-line preview" derivation — lives here so tests can
// drive it without a Next runtime or a real Prisma.
//
// The returned payload is intentionally thin:
//   - id, title?, createdAt, updatedAt  — identity + sort keys
//   - messageCount                      — badge
//   - preview?                          — first user message
//                                         truncated for the row
// No transcript, no widgets. The picker opens a session by flipping
// the URL's `?session=` param, which triggers the existing
// hydrate-on-mount path in ChatWorkspace — the list endpoint never
// has to ship turn content.
//
// Why we separately cap at both `limit` (default 25) and a hard
// MAX_LIMIT (100):
//   - Default 25 keeps the picker dropdown visually tight for the
//     common case — an operator who returns to /chat expects "my
//     recent sessions", not a scrollable wall.
//   - The hard cap protects the DB from a hand-crafted client
//     shipping `?limit=10000`. A session index per user is cheap but
//     the payload per row includes up to PREVIEW_CHARS of first-
//     message text, which multiplies.
//
// Ownership/privacy: the `where: { userId }` scope is mandatory and
// lives in the dep. The handler never takes a userId from the
// request body/query — always from `getCurrentUser()` — so an
// authenticated user cannot browse another user's picker by
// sending their id.

// ---- Tunables -----------------------------------------------------

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

// Max preview length for the "first user message" snippet. Long
// enough to read a typical first ask at a glance, short enough to
// fit in a single menu row without eating the dropdown's width.
const PREVIEW_CHARS = 80;

// ---- Types --------------------------------------------------------

export type ListSessionsUser = { id: string };

// The row shape the picker consumes. `title` may be null while a
// session's title hasn't been derived yet (e.g. mid-first-turn race
// between session create and title backfill); the client shows the
// preview or a generic fallback in that case.
export type SessionListItem = {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string | null;
};

export type ListSessionsResultOk = {
  kind: "ok";
  body: { sessions: SessionListItem[] };
};

export type ListSessionsResultError = {
  kind: "error";
  status: 401 | 400;
  body: { ok: false; error: string };
};

export type ListSessionsResult =
  | ListSessionsResultOk
  | ListSessionsResultError;

// The rows returned by `findSessions` carry enough to build the row
// shape without a second query. `firstUserMessage` is optional on
// purpose — a session with zero messages (the server creates the row
// before persisting the first user turn; a crash between could leave
// this empty) still renders, just with a null preview.
export type ListSessionsRow = Pick<
  ChatSession,
  "id" | "title" | "createdAt" | "updatedAt"
> & {
  _count: { messages: number };
  messages?: Array<{ content: string | null }>;
};

export interface ListSessionsDeps {
  getCurrentUser: () => Promise<ListSessionsUser | null>;
  // Caller injects the Prisma query. Must:
  //   - filter by userId AND archivedAt IS NULL
  //   - order by updatedAt DESC
  //   - take `limit` rows (handler passes the validated limit)
  //   - include _count.messages and the FIRST user message's
  //     content for preview (shape pinned in the route.ts wrapper
  //     so the real Prisma call stays colocated with the schema)
  findSessions: (args: {
    userId: string;
    limit: number;
  }) => Promise<ListSessionsRow[]>;
}

// ---- Helpers ------------------------------------------------------

// Parse `?limit=` if present; clamp to [1, MAX_LIMIT] so neither 0
// nor a user-supplied ceiling breaks the query. Invalid (non-numeric
// or negative) falls back to DEFAULT_LIMIT — we don't 400 on a
// malformed limit because the natural recovery is "show a reasonable
// default", not "reject the whole request".
function parseLimit(req: Request): number {
  const url = new URL(req.url);
  const raw = url.searchParams.get("limit");
  if (raw === null) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function derivePreview(row: ListSessionsRow): string | null {
  // Prefer the first user message's content. The caller's Prisma
  // query pins the ordering (createdAt asc, role='user', take 1) so
  // this is O(1) per row and doesn't re-sort on the handler side.
  const first = row.messages?.[0]?.content;
  if (typeof first !== "string") return null;
  const trimmed = first.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= PREVIEW_CHARS) return trimmed;
  // Ellipsis via U+2026 (…) — renders crisper than ASCII "..." at
  // small sizes and is consistently 1 char for width budgets.
  return `${trimmed.slice(0, PREVIEW_CHARS - 1)}…`;
}

// ---- Handler ------------------------------------------------------

export async function listSessionsHandler(
  req: Request,
  deps: ListSessionsDeps,
): Promise<ListSessionsResult> {
  const me = await deps.getCurrentUser();
  if (!me) {
    return {
      kind: "error",
      status: 401,
      body: { ok: false, error: "unauthorized" },
    };
  }

  const limit = parseLimit(req);

  const rows = await deps.findSessions({ userId: me.id, limit });

  const sessions: SessionListItem[] = rows.map((row) => ({
    id: row.id,
    title: row.title ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    messageCount: row._count.messages,
    preview: derivePreview(row),
  }));

  return {
    kind: "ok",
    body: { sessions },
  };
}
