import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage, ChatSession } from "@prisma/client";

import {
  hydrateSessionHandler,
  type HydrateDeps,
  type HydrateResult,
  type HydrateResultOk,
  type HydrateUser,
} from "../../src/app/api/chat/session/[id]/handler";
import type { PrismaLike, WidgetRow } from "../../src/lib/ai/widgets";

// Route-level tests for GET /api/chat/session/[id]. The handler is
// pure — auth + ownership + transcript-UI rebuild + widget snapshot
// are all wired through injected deps so we can pin every branch
// without an RSC runtime or a real Prisma:
//
//   - 401 unauthorized         -> no user
//   - 404 not_found (missing)  -> findSession returns null
//   - 404 not_found (empty id) -> empty path param (defence-in-depth)
//   - 200 ok (fresh session)   -> empty turns + empty widgets
//   - 200 ok (transcript rows) -> turns rebuilt via rebuildUiTurns,
//                                 widgets rebuilt via listWidgets,
//                                 both with correct content + order
//   - 200 ok (row cap)         -> sessions with >500 rows keep the
//                                 newest 500, drop oldest (newest-at-
//                                 bottom UX)
//   - 401 short-circuits       -> no DB calls on unauthenticated probe
//   - 404 short-circuits       -> no transcript / widget read when
//                                 ownership check fails (info-leak
//                                 defence: "doesn't exist" and "not
//                                 yours" must look identical externally)
//   - widget drift skip        -> broken widget rows counted in
//                                 `skipped`, NOT returned in `widgets`
//   - transcript contains a directive -> a directive block is emitted
//                                 with messageId = tool row id

// ---- helpers ----

const NOW = new Date("2026-04-19T10:00:00Z");

const USER: HydrateUser = { id: "user-1" };

// A minimum fully-valid campaign_list item — every field the
// per-kind validator (`directive-validate.ts`) and the widget prop
// validator require. Used when a test needs a persisted directive
// that survives the read-path validator.
const VALID_CAMPAIGN_ITEM = {
  id: "c1",
  name: "Royal Dinner",
  status: "scheduled",
  event_at: null,
  venue: null,
  team_id: null,
  stats: { total: 0, responded: 0, headcount: 0 },
};

function makeSession(id: string): Pick<
  ChatSession,
  "id" | "createdAt" | "updatedAt"
> {
  return {
    id,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

// Minimal ChatMessage shape the handler projects into UiTranscriptRow.
type MsgRow = Pick<
  ChatMessage,
  | "id"
  | "role"
  | "content"
  | "toolName"
  | "renderDirective"
  | "isError"
  | "createdAt"
>;

function userMsg(id: string, content: string, atMs = 0): MsgRow {
  return {
    id,
    role: "user",
    content,
    toolName: null,
    renderDirective: null,
    isError: false,
    createdAt: new Date(NOW.getTime() + atMs),
  };
}

function asstMsg(id: string, content: string, atMs = 0): MsgRow {
  return {
    id,
    role: "assistant",
    content,
    toolName: null,
    renderDirective: null,
    isError: false,
    createdAt: new Date(NOW.getTime() + atMs),
  };
}

function toolMsg(
  id: string,
  name: string,
  opts: {
    content?: string;
    isError?: boolean;
    renderDirective?: string | null;
    atMs?: number;
  } = {},
): MsgRow {
  return {
    id,
    role: "tool",
    content: opts.content ?? "",
    toolName: name,
    renderDirective: opts.renderDirective ?? null,
    isError: opts.isError ?? false,
    createdAt: new Date(NOW.getTime() + (opts.atMs ?? 0)),
  };
}

// In-memory PrismaLike that models the (sessionId, widgetKey) unique
// constraint. Lifted in spirit from widget-helpers.test.ts but
// slimmed to only the findMany path the hydrate handler touches
// (listWidgets reads; it never upserts or deletes).
function makeStubPrisma(initialRows: WidgetRow[] = []): {
  prismaLike: PrismaLike;
  rows: WidgetRow[];
} {
  const rows = [...initialRows];
  const prismaLike: PrismaLike = {
    chatWidget: {
      async findMany(args) {
        const filtered = rows.filter((r) => r.sessionId === args.where.sessionId);
        // listWidgets orders by slot asc, order asc, updatedAt asc.
        return [...filtered].sort((a, b) => {
          for (const entry of args.orderBy) {
            const [key, dir] = Object.entries(entry)[0] as [
              keyof WidgetRow,
              "asc" | "desc",
            ];
            const av = a[key];
            const bv = b[key];
            if (av === bv) continue;
            const cmp =
              (av as unknown as number) < (bv as unknown as number) ? -1 : 1;
            return dir === "asc" ? cmp : -cmp;
          }
          return 0;
        });
      },
      async upsert() {
        throw new Error("upsert should not be called by hydrate handler");
      },
      async deleteMany() {
        throw new Error("deleteMany should not be called by hydrate handler");
      },
      async findUnique() {
        throw new Error("findUnique should not be called by hydrate handler");
      },
    },
  };
  return { prismaLike, rows };
}

// Capture-style deps so tests can assert dep usage AND short-circuits.
// Every dep pushes its inputs onto a trace array — a 401 test then
// asserts the trace stays empty past the auth check.
function makeDeps(overrides: {
  user?: HydrateUser | null;
  session?: Pick<ChatSession, "id" | "createdAt" | "updatedAt"> | null;
  messages?: MsgRow[];
  widgets?: WidgetRow[];
} = {}) {
  const findSessionCalls: Array<{ userId: string; sessionId: string }> = [];
  const findMessagesCalls: string[] = [];
  const buildSummaryCalls: number[] = [];
  const { prismaLike } = makeStubPrisma(overrides.widgets ?? []);

  const user = overrides.user === undefined ? USER : overrides.user;
  const session =
    overrides.session === undefined ? makeSession("s-1") : overrides.session;
  const messages = overrides.messages ?? [];

  const deps: HydrateDeps = {
    getCurrentUser: async () => user,
    findSession: async (userId, sessionId) => {
      findSessionCalls.push({ userId, sessionId });
      return session;
    },
    findMessages: async (sessionId) => {
      findMessagesCalls.push(sessionId);
      return messages;
    },
    prismaLike,
    buildSummaryWidget: async () => {
      buildSummaryCalls.push(1);
      return null;
    },
  };

  return { deps, findSessionCalls, findMessagesCalls, buildSummaryCalls };
}

function assertOk(r: HydrateResult): HydrateResultOk {
  assert.equal(r.kind, "ok", `expected ok, got ${r.kind}`);
  if (r.kind !== "ok") throw new Error("unreachable");
  return r;
}

function widgetRow(
  overrides: Partial<WidgetRow> & {
    sessionId: string;
    widgetKey: string;
    kind: string;
    slot: string;
    props: string;
  },
): WidgetRow {
  return {
    id: overrides.id ?? `w-${overrides.widgetKey}`,
    sessionId: overrides.sessionId,
    widgetKey: overrides.widgetKey,
    kind: overrides.kind,
    slot: overrides.slot,
    props: overrides.props,
    order: overrides.order ?? 0,
    sourceMessageId: overrides.sourceMessageId ?? null,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

// ---- auth / ownership ----

test("401 when no user session — no DB calls", async () => {
  // Unauthenticated probe must short-circuit before findSession or
  // findMessages — a leaky "does this session id exist?" probe would
  // let an attacker enumerate session ids across tenants.
  const { deps, findSessionCalls, findMessagesCalls, buildSummaryCalls } = makeDeps({
    user: null,
  });
  const r = await hydrateSessionHandler("s-1", deps);
  assert.equal(r.kind, "error");
  if (r.kind !== "error") throw new Error("unreachable");
  assert.equal(r.status, 401);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.error, "unauthorized");
  assert.equal(findSessionCalls.length, 0);
  assert.equal(findMessagesCalls.length, 0);
  assert.equal(buildSummaryCalls.length, 0);
});

test("404 when session id is empty string — no DB calls", async () => {
  // Next routes with a dynamic `[id]` should never hand us an empty
  // string, but a hand-crafted request could still land here. Match
  // the not-found response for the ownership-probe defence.
  const { deps, findSessionCalls, findMessagesCalls, buildSummaryCalls } = makeDeps();
  const r = await hydrateSessionHandler("", deps);
  assert.equal(r.kind, "error");
  if (r.kind !== "error") throw new Error("unreachable");
  assert.equal(r.status, 404);
  assert.equal(r.body.error, "not_found");
  // Short-circuits before getCurrentUser so no trace of the probe
  // touches the DB either.
  assert.equal(findSessionCalls.length, 0);
  assert.equal(findMessagesCalls.length, 0);
  assert.equal(buildSummaryCalls.length, 0);
});

test("404 when findSession returns null — no transcript / widget read", async () => {
  // The ownership check collapses "doesn't exist", "archived", and
  // "belongs to another user" into one 404 so an attacker can't
  // probe ids. findMessages MUST NOT run after the 404.
  const { deps, findSessionCalls, findMessagesCalls, buildSummaryCalls } = makeDeps({
    session: null,
  });
  const r = await hydrateSessionHandler("s-foreign", deps);
  assert.equal(r.kind, "error");
  if (r.kind !== "error") throw new Error("unreachable");
  assert.equal(r.status, 404);
  assert.equal(r.body.error, "not_found");
  // findSession ran (once) with the right userId + sessionId.
  assert.equal(findSessionCalls.length, 1);
  assert.equal(findSessionCalls[0].userId, USER.id);
  assert.equal(findSessionCalls[0].sessionId, "s-foreign");
  // findMessages did NOT run — the ownership check gated it.
  assert.equal(findMessagesCalls.length, 0);
  assert.equal(buildSummaryCalls.length, 0);
});

// ---- happy path: empty session ----

test("200 for a fresh session returns empty turns and empty widgets", async () => {
  const { deps, buildSummaryCalls } = makeDeps();
  const r = await hydrateSessionHandler("s-1", deps);
  const ok = assertOk(r);
  assert.equal(ok.body.session.id, "s-1");
  assert.equal(typeof ok.body.session.createdAt, "string");
  assert.equal(typeof ok.body.session.updatedAt, "string");
  assert.deepEqual(ok.body.turns, []);
  assert.deepEqual(ok.body.widgets, []);
  assert.equal(ok.body.skipped, 0);
  assert.equal(buildSummaryCalls.length, 1);
});

// ---- happy path: populated session ----

test("200 rebuilds turns from transcript rows (user -> assistant+tool+directive)", async () => {
  const { deps } = makeDeps({
    messages: [
      userMsg("u1", "show active campaigns", 0),
      asstMsg("a1", "Looking up:", 100),
      toolMsg("t1", "list_campaigns", {
        atMs: 200,
        renderDirective: JSON.stringify({
          kind: "campaign_list",
          // A fully-shaped item — the read-path validator in
          // transcript-ui drops known-kind rows whose item shape is
          // invalid, so this test would silently lose coverage of
          // the happy-path directive emission if the item skipped
          // any required field.
          props: { items: [VALID_CAMPAIGN_ITEM] },
        }),
      }),
    ],
  });
  const r = await hydrateSessionHandler("s-1", deps);
  const ok = assertOk(r);
  assert.equal(ok.body.turns.length, 2);
  assert.equal(ok.body.turns[0].kind, "user");
  const asst = ok.body.turns[1];
  assert.equal(asst.kind, "assistant");
  if (asst.kind !== "assistant") throw new Error("unreachable");
  // text + pill + directive
  assert.equal(asst.blocks.length, 3);
  assert.equal(asst.blocks[0].type, "text");
  assert.equal(asst.blocks[1].type, "tool");
  assert.equal(asst.blocks[2].type, "directive");
  if (asst.blocks[2].type === "directive") {
    // messageId must be the TOOL row id — that's the anchor
    // ConfirmSend POST uses, same as the live SSE path.
    assert.equal(asst.blocks[2].payload.messageId, "t1");
    assert.equal(asst.blocks[2].payload.kind, "campaign_list");
  }
  // Hydrated turns never claim to be streaming.
  assert.equal(asst.streaming, false);
});

test("200 drops a hydrated directive whose per-kind props are shape-invalid", async () => {
  // End-to-end read-path trust-boundary assertion. A persisted
  // directive with a valid envelope but malformed per-kind props
  // (missing required item fields) must NOT reach the response —
  // DirectiveRenderer casts props into concrete prop types, so a
  // drifted row would crash the renderer after a reload.
  //
  // The tool pill survives (operator still sees that a tool ran);
  // only the directive block is dropped.
  const { deps } = makeDeps({
    messages: [
      asstMsg("a1", "", 0),
      toolMsg("t1", "list_campaigns", {
        atMs: 10,
        renderDirective: JSON.stringify({
          kind: "campaign_list",
          // `items[0]` is missing `status`, `event_at`, `venue`,
          // `team_id`, and `stats.*` — envelope passes, per-kind
          // validator rejects.
          props: { items: [{ id: "c1", name: "Royal Dinner" }] },
        }),
      }),
    ],
  });
  const r = await hydrateSessionHandler("s-1", deps);
  const ok = assertOk(r);
  assert.equal(ok.body.turns.length, 1);
  const asst = ok.body.turns[0];
  if (asst.kind !== "assistant") throw new Error("unreachable");
  // Just the pill — directive dropped.
  assert.equal(asst.blocks.length, 1);
  assert.equal(asst.blocks[0].type, "tool");
});

test("200 surfaces persisted widgets via listWidgets", async () => {
  // Empty-items props is the smallest VALID campaign_list shape — the
  // item validator has a ton of required fields (id/name/status/
  // event_at/venue/team_id/stats.*), and we're testing the hydrate
  // wiring here, not the per-kind prop validator (that has its own
  // widget-validate.test.ts).
  const widget = widgetRow({
    sessionId: "s-1",
    widgetKey: "campaign_list:active",
    kind: "campaign_list",
    slot: "primary",
    props: JSON.stringify({ items: [] }),
    order: 0,
  });
  const { deps } = makeDeps({ widgets: [widget] });
  const r = await hydrateSessionHandler("s-1", deps);
  const ok = assertOk(r);
  assert.equal(ok.body.widgets.length, 1);
  assert.equal(ok.body.widgets[0].widgetKey, "campaign_list:active");
  assert.equal(ok.body.widgets[0].slot, "primary");
  assert.deepEqual(ok.body.widgets[0].props, { items: [] });
  assert.equal(ok.body.skipped, 0);
});

test("200 overlays a freshly built summary widget onto the hydrated widget list", async () => {
  const staleSummary = widgetRow({
    sessionId: "s-1",
    widgetKey: "workspace.summary",
    kind: "workspace_rollup",
    slot: "summary",
    props: JSON.stringify({
      campaigns: { draft: 0, active: 0, closed: 0, archived: 0, total: 0 },
      invitees: { total: 0 },
      responses: { total: 0, attending: 0, declined: 0, recent_24h: 0 },
      invitations: {
        sent_24h: 0,
        sent_email_24h: 0,
        sent_sms_24h: 0,
        sent_whatsapp_24h: 0,
      },
      generated_at: "2026-04-01T00:00:00.000Z",
    }),
  });
  const { deps } = makeDeps({ widgets: [staleSummary] });
  deps.buildSummaryWidget = async () => ({
    widgetKey: "workspace.summary",
    kind: "workspace_rollup",
    slot: "summary",
    props: {
      campaigns: { draft: 1, active: 2, closed: 3, archived: 4, total: 10 },
      invitees: { total: 20 },
      responses: { total: 5, attending: 3, declined: 2, recent_24h: 1 },
      invitations: {
        sent_24h: 7,
        sent_email_24h: 3,
        sent_sms_24h: 2,
        sent_whatsapp_24h: 2,
      },
      generated_at: "2026-04-19T10:00:00.000Z",
    },
    order: 0,
    sourceMessageId: null,
    createdAt: "2026-04-19T10:00:00.000Z",
    updatedAt: "2026-04-19T10:00:00.000Z",
  });
  const r = await hydrateSessionHandler("s-1", deps);
  const ok = assertOk(r);
  assert.equal(ok.body.widgets.length, 1);
  assert.equal(ok.body.widgets[0].widgetKey, "workspace.summary");
  assert.equal(
    (ok.body.widgets[0].props as { campaigns: { total: number } }).campaigns.total,
    10,
  );
});

test("200 refreshes live widgets before applying the summary overlay", async () => {
  const stalePrimary = widgetRow({
    sessionId: "s-1",
    widgetKey: "campaigns.list",
    kind: "campaign_list",
    slot: "primary",
    props: JSON.stringify({ items: [] }),
  });
  const { deps } = makeDeps({ widgets: [stalePrimary] });
  deps.refreshWidgets = async (widgets) =>
    widgets.map((widget) =>
      widget.widgetKey === "campaigns.list"
        ? {
            ...widget,
            props: {
              items: [
                {
                  id: "c-live",
                  name: "Live Campaign",
                  status: "active",
                  event_at: null,
                  venue: null,
                  team_id: null,
                  stats: { total: 12, responded: 5, headcount: 18 },
                },
              ],
            },
          }
        : widget,
    );
  deps.buildSummaryWidget = async () => ({
    widgetKey: "workspace.summary",
    kind: "workspace_rollup",
    slot: "summary",
    props: {
      campaigns: { draft: 0, active: 1, closed: 0, archived: 0, total: 1 },
      invitees: { total: 12 },
      responses: { total: 5, attending: 4, declined: 1, recent_24h: 1 },
      invitations: {
        sent_24h: 3,
        sent_email_24h: 1,
        sent_sms_24h: 1,
        sent_whatsapp_24h: 1,
      },
      generated_at: "2026-04-19T10:00:00.000Z",
    },
    order: 0,
    sourceMessageId: null,
    createdAt: "2026-04-19T10:00:00.000Z",
    updatedAt: "2026-04-19T10:00:00.000Z",
  });

  const r = await hydrateSessionHandler("s-1", deps);
  const ok = assertOk(r);
  assert.equal(ok.body.widgets.length, 2);
  assert.equal(ok.body.widgets[0].widgetKey, "workspace.summary");
  assert.equal(ok.body.widgets[1].widgetKey, "campaigns.list");
  const items = ok.body.widgets[1].props.items as Array<{ id: string }>;
  assert.equal(items[0].id, "c-live");
});

test("200 counts drifted widget rows in `skipped`, drops them from `widgets`", async () => {
  // A broken row (bad JSON in `props`) must not blank the dashboard —
  // listWidgets returns it in `skipped` and suppresses it from the
  // array. Same read-path fail-closed behavior as the live snapshot.
  const goodWidget = widgetRow({
    sessionId: "s-1",
    widgetKey: "good",
    kind: "campaign_list",
    slot: "primary",
    props: JSON.stringify({ items: [] }),
  });
  const brokenWidget = widgetRow({
    sessionId: "s-1",
    widgetKey: "broken",
    kind: "campaign_list",
    slot: "primary",
    props: "{not-valid-json",
  });
  const { deps } = makeDeps({ widgets: [goodWidget, brokenWidget] });
  const r = await hydrateSessionHandler("s-1", deps);
  const ok = assertOk(r);
  assert.equal(ok.body.widgets.length, 1);
  assert.equal(ok.body.widgets[0].widgetKey, "good");
  assert.equal(ok.body.skipped, 1);
});

test("200 only returns widgets scoped to the requested session", async () => {
  // Defence-in-depth: even though the ownership check gates the
  // read, prove the widget query is sessionId-scoped so a leak in
  // the ownership check can't spray another session's widgets into
  // the response.
  const mine = widgetRow({
    sessionId: "s-mine",
    widgetKey: "mine",
    kind: "campaign_list",
    slot: "primary",
    props: JSON.stringify({ items: [] }),
  });
  const theirs = widgetRow({
    sessionId: "s-theirs",
    widgetKey: "theirs",
    kind: "campaign_list",
    slot: "primary",
    props: JSON.stringify({ items: [] }),
  });
  const { deps } = makeDeps({
    session: makeSession("s-mine"),
    widgets: [mine, theirs],
  });
  const r = await hydrateSessionHandler("s-mine", deps);
  const ok = assertOk(r);
  assert.equal(ok.body.widgets.length, 1);
  assert.equal(ok.body.widgets[0].widgetKey, "mine");
});

// ---- row cap ----

test("200 trims transcript to HYDRATION_ROW_CAP keeping the newest rows", async () => {
  // Pathological long session: 600 rows. Cap is 500 — we should keep
  // rows[100..600] (the last 500). The transform won't be asked to
  // pair orphan tools at the cut boundary; we intentionally shape
  // the data so the cut lands between two user messages.
  const rows: MsgRow[] = [];
  for (let i = 0; i < 600; i += 1) {
    rows.push(userMsg(`u-${i}`, `msg ${i}`, i));
  }
  const { deps } = makeDeps({ messages: rows });
  const r = await hydrateSessionHandler("s-1", deps);
  const ok = assertOk(r);
  assert.equal(ok.body.turns.length, 500);
  // The FIRST turn after the cap should be the 100th original (we
  // dropped 0..99).
  assert.equal(ok.body.turns[0].id, "u-100");
  assert.equal(ok.body.turns[499].id, "u-599");
});

// ---- direct-call assertion: widget-scoped session id ----

test("findSession receives the (userId, sessionId) pair the handler was called with", async () => {
  const { deps, findSessionCalls } = makeDeps({
    session: makeSession("s-42"),
  });
  await hydrateSessionHandler("s-42", deps);
  assert.equal(findSessionCalls.length, 1);
  assert.equal(findSessionCalls[0].userId, USER.id);
  assert.equal(findSessionCalls[0].sessionId, "s-42");
});
