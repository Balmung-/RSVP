import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listSessionsHandler,
  type ListSessionsDeps,
  type ListSessionsRow,
  type ListSessionsResult,
} from "../../src/app/api/chat/sessions/handler";

// P4-A — route-level tests for GET /api/chat/sessions. They pin
// each branch of the list decision tree:
//
//   - 401 unauthorized                   -> no session cookie
//   - 200 + empty array                  -> user has no sessions
//   - 200 + sorted list                  -> caller's Prisma query
//                                            returns updatedAt-desc;
//                                            handler forwards order
//                                            without re-sorting
//   - ownership scoping                  -> handler NEVER takes
//                                            userId from query/body;
//                                            always from
//                                            getCurrentUser
//   - limit parse / clamp                -> ?limit=50 honored,
//                                            ?limit=9999 capped to
//                                            MAX_LIMIT, ?limit=abc
//                                            falls back to default
//   - preview derivation                 -> first user message
//                                            truncated; null when
//                                            absent/empty/non-string
//
// The handler is pure (no Next, no Prisma import) — every side
// effect lives in `deps`. Tests drive it with plain stubs.

// ---- Fixtures -----------------------------------------------------

const USER_ID = "user-1";

function row(overrides: Partial<ListSessionsRow> = {}): ListSessionsRow {
  return {
    id: "sess-1",
    title: "First ask",
    createdAt: new Date("2026-04-18T09:00:00Z"),
    updatedAt: new Date("2026-04-20T12:00:00Z"),
    _count: { messages: 3 },
    messages: [{ content: "What's the status of Summer Gala?" }],
    ...overrides,
  };
}

function makeDeps(
  overrides: {
    user?: { id: string } | null;
    rows?: ListSessionsRow[];
    onFind?: (args: { userId: string; limit: number }) => void;
  } = {},
): {
  deps: ListSessionsDeps;
  findCalls: Array<{ userId: string; limit: number }>;
} {
  const findCalls: Array<{ userId: string; limit: number }> = [];
  const user =
    overrides.user === undefined ? { id: USER_ID } : overrides.user;
  const rows = overrides.rows ?? [];

  const deps: ListSessionsDeps = {
    getCurrentUser: async () => user,
    findSessions: async (args) => {
      findCalls.push(args);
      overrides.onFind?.(args);
      return rows;
    },
  };
  return { deps, findCalls };
}

function getReq(url = "https://app.example.gov/api/chat/sessions"): Request {
  return new Request(url, { method: "GET" });
}

function bodyOf(r: ListSessionsResult): Record<string, unknown> {
  return r.body;
}

// ---- Tests --------------------------------------------------------

// 1. Auth gate ------------------------------------------------------

test("401 when no user — does not query DB", async () => {
  const { deps, findCalls } = makeDeps({ user: null });
  const r = await listSessionsHandler(getReq(), deps);
  assert.equal(r.kind, "error");
  if (r.kind !== "error") return;
  assert.equal(r.status, 401);
  assert.equal(bodyOf(r).error, "unauthorized");
  // Critically: no DB query for an unauthenticated probe.
  assert.deepEqual(findCalls, []);
});

// 2. Empty result ---------------------------------------------------

test("200 + empty sessions array when user has no rows", async () => {
  const { deps } = makeDeps({ rows: [] });
  const r = await listSessionsHandler(getReq(), deps);
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  assert.deepEqual(r.body.sessions, []);
});

// 3. Populated list + sort preservation -----------------------------

test("200 + rows forwarded in order returned by findSessions (no re-sort)", async () => {
  // The Prisma query pins `orderBy: { updatedAt: "desc" }`. The
  // handler must NOT re-sort — if Prisma returns them desc, the UI
  // sees them desc. This test passes rows in an arbitrary order
  // and asserts the handler preserves it.
  const rows: ListSessionsRow[] = [
    row({ id: "a", updatedAt: new Date("2026-04-20T12:00:00Z") }),
    row({ id: "b", updatedAt: new Date("2026-04-19T08:00:00Z") }),
    row({ id: "c", updatedAt: new Date("2026-04-18T15:00:00Z") }),
  ];
  const { deps } = makeDeps({ rows });
  const r = await listSessionsHandler(getReq(), deps);
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  const ids = r.body.sessions.map((s) => s.id);
  assert.deepEqual(ids, ["a", "b", "c"]);
});

test("200 + every row includes id, title, createdAt, updatedAt, messageCount, preview", async () => {
  const rows: ListSessionsRow[] = [row()];
  const { deps } = makeDeps({ rows });
  const r = await listSessionsHandler(getReq(), deps);
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  const s = r.body.sessions[0]!;
  assert.equal(s.id, "sess-1");
  assert.equal(s.title, "First ask");
  assert.equal(s.createdAt, "2026-04-18T09:00:00.000Z");
  assert.equal(s.updatedAt, "2026-04-20T12:00:00.000Z");
  assert.equal(s.messageCount, 3);
  assert.equal(s.preview, "What's the status of Summer Gala?");
});

test("200 + null title is forwarded as null (picker falls back to preview)", async () => {
  // Sessions created before the title-derivation feature, or rows
  // where the operator cleared the title, have null. The handler
  // must not invent a string — the client is responsible for the
  // fallback UI.
  const { deps } = makeDeps({ rows: [row({ title: null })] });
  const r = await listSessionsHandler(getReq(), deps);
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  assert.equal(r.body.sessions[0]!.title, null);
});

// 4. Ownership scoping ---------------------------------------------

test("ownership: findSessions is called with the authenticated user's id — not a query param", async () => {
  // A hand-crafted client could put ?userId=<target> in the URL
  // trying to browse another user. The handler must IGNORE any
  // such query input and pass getCurrentUser().id to findSessions.
  const { deps, findCalls } = makeDeps({
    user: { id: "alice" },
    rows: [],
  });
  await listSessionsHandler(
    getReq("https://app.example.gov/api/chat/sessions?userId=mallory"),
    deps,
  );
  assert.equal(findCalls.length, 1);
  assert.equal(findCalls[0]!.userId, "alice");
});

// 5. Limit parse + clamp -------------------------------------------

test("limit: default (no query param) is passed through to findSessions", async () => {
  const { deps, findCalls } = makeDeps({ rows: [] });
  await listSessionsHandler(getReq(), deps);
  assert.equal(findCalls.length, 1);
  // Default is 25 — exact value is pinned in handler.ts. If that
  // constant moves, we want this test to flag the change so the
  // picker's UX expectations stay aligned.
  assert.equal(findCalls[0]!.limit, 25);
});

test("limit: valid ?limit=10 is forwarded as 10", async () => {
  const { deps, findCalls } = makeDeps({ rows: [] });
  await listSessionsHandler(
    getReq("https://app.example.gov/api/chat/sessions?limit=10"),
    deps,
  );
  assert.equal(findCalls[0]!.limit, 10);
});

test("limit: ?limit=9999 is clamped to MAX_LIMIT (100)", async () => {
  // DB protection — a hand-crafted client can't blow up the payload
  // size by shipping a huge limit.
  const { deps, findCalls } = makeDeps({ rows: [] });
  await listSessionsHandler(
    getReq("https://app.example.gov/api/chat/sessions?limit=9999"),
    deps,
  );
  assert.equal(findCalls[0]!.limit, 100);
});

test("limit: non-numeric ?limit=abc falls back to default (not 400)", async () => {
  // We don't reject the whole request on a malformed limit — the
  // natural recovery is "show the default number of rows".
  const { deps, findCalls } = makeDeps({ rows: [] });
  const r = await listSessionsHandler(
    getReq("https://app.example.gov/api/chat/sessions?limit=abc"),
    deps,
  );
  assert.equal(r.kind, "ok");
  assert.equal(findCalls[0]!.limit, 25);
});

test("limit: ?limit=0 and ?limit=-5 fall back to default", async () => {
  // Zero and negative are both nonsense — fallback keeps the list
  // usable. An attacker can't force an empty response via limit=0
  // (which would otherwise be a trivial way to make the picker
  // look broken).
  const { deps, findCalls } = makeDeps({ rows: [] });
  await listSessionsHandler(
    getReq("https://app.example.gov/api/chat/sessions?limit=0"),
    deps,
  );
  assert.equal(findCalls[0]!.limit, 25);
  await listSessionsHandler(
    getReq("https://app.example.gov/api/chat/sessions?limit=-5"),
    deps,
  );
  assert.equal(findCalls[1]!.limit, 25);
});

// 6. Preview derivation --------------------------------------------

test("preview: short first message is returned verbatim", async () => {
  const { deps } = makeDeps({
    rows: [row({ messages: [{ content: "hello" }] })],
  });
  const r = await listSessionsHandler(getReq(), deps);
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  assert.equal(r.body.sessions[0]!.preview, "hello");
});

test("preview: long first message is truncated with a U+2026 ellipsis", async () => {
  // PREVIEW_CHARS is 80 (pinned in handler.ts). A 200-char message
  // must come back ≤80 chars and end in "…".
  const long = "x".repeat(200);
  const { deps } = makeDeps({
    rows: [row({ messages: [{ content: long }] })],
  });
  const r = await listSessionsHandler(getReq(), deps);
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  const preview = r.body.sessions[0]!.preview!;
  assert.equal(preview.length, 80);
  assert.ok(preview.endsWith("…"), `preview must end in U+2026, got ${preview}`);
});

test("preview: whitespace-only content returns null", async () => {
  // A malformed first message (just spaces/newlines) shouldn't
  // render as a blank row.
  const { deps } = makeDeps({
    rows: [row({ messages: [{ content: "   \n\t " }] })],
  });
  const r = await listSessionsHandler(getReq(), deps);
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  assert.equal(r.body.sessions[0]!.preview, null);
});

test("preview: empty messages array returns null preview", async () => {
  // A session-create-without-message edge case. The list handler
  // should still surface the session — just without a preview.
  const { deps } = makeDeps({ rows: [row({ messages: [] })] });
  const r = await listSessionsHandler(getReq(), deps);
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  assert.equal(r.body.sessions[0]!.preview, null);
});

test("preview: missing messages field returns null preview (defensive)", async () => {
  // If the Prisma include is ever missed (typo in route.ts, or a
  // new Prisma version changes behavior), the handler must degrade
  // gracefully — not crash on undefined.messages[0].
  const { deps } = makeDeps({
    rows: [{ ...row(), messages: undefined }],
  });
  const r = await listSessionsHandler(getReq(), deps);
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  assert.equal(r.body.sessions[0]!.preview, null);
});

test("preview: non-string content is rejected as null (defensive)", async () => {
  // `content` is typed as `string | null` by Prisma. This belt-and-
  // braces check guards against a schema migration that loosens
  // the type without a corresponding handler update.
  const { deps } = makeDeps({
    rows: [
      {
        ...row(),
        messages: [{ content: null as unknown as string }],
      },
    ],
  });
  const r = await listSessionsHandler(getReq(), deps);
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  assert.equal(r.body.sessions[0]!.preview, null);
});
