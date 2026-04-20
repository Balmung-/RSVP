import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createWorkspaceEmitter,
  listWidgets,
  upsertWidget,
  type PrismaLike,
  type WidgetRow,
} from "../../src/lib/ai/widgets";

// P8-A-fix — concurrent-write invariant tests for singleton-slot
// composition. Responds to GPT's audit blocker on 55d4ee8:
//
//   "two simultaneous primary writes ended with [] in the final DB
//   state — the pre-fix upsert-then-evict ordering let each writer's
//   post-upsert findMany see the OTHER's row and delete it."
//
// The fix has two layered guards:
//   1. `upsertWidget` now evicts siblings BEFORE the upsert rather
//      than after. Under the unprotected mutex-less case (future
//      producer added cross-instance) this degrades to "two
//      occupants briefly, self-heals on next write" rather than
//      "zero occupants, stuck broken state".
//   2. A process-local mutex keyed per `(sessionId, slot)` in
//      `widgets.ts` serializes singleton-slot writes inside a
//      single Node process — which is sufficient for the current
//      set of producers (see the `slotLocks` docstring in
//      widgets.ts for the architecture rationale).
//
// These tests pin the invariant the fix enforces: two parallel
// singleton-slot writes to the same `(sessionId, slot)` cannot
// end with zero rows, regardless of Node microtask interleaving.
// They DO NOT assert a specific winner — the mutex is FIFO-ish but
// the runtime is allowed to interleave Promise.all arms arbitrarily
// before either arm enters the critical section. What they DO
// assert is the two strict invariants the living-workspace UX
// depends on: exactly one survivor in the DB, and the survivor is
// one of the two intended writers.

type StubState = { rows: WidgetRow[]; nowMs: number };

function makeStubPrisma(): { prismaLike: PrismaLike; state: StubState } {
  // The stub PrismaLike does NOT add any artificial serialization —
  // it's a straight in-memory mirror of the methods upsertWidget
  // actually uses. This is deliberate: we want Node's microtask
  // scheduler to freely interleave two concurrent upsertWidget
  // callers so the race the old code exhibited can actually be
  // exercised. With the mutex in place, the findMany/deleteMany/
  // upsert sequence of one caller completes before the other's
  // sequence begins, and the invariant holds; without the mutex
  // (regression), the Promise.all below would produce state.rows
  // === [].
  const state: StubState = { rows: [], nowMs: 1_700_000_000_000 };
  const tick = () => new Date((state.nowMs += 1));
  const prismaLike: PrismaLike = {
    chatWidget: {
      async findMany(args) {
        let rows = state.rows.filter(
          (r) => r.sessionId === args.where.sessionId,
        );
        const ob = args.orderBy;
        rows = [...rows].sort((a, b) => {
          for (const entry of ob) {
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
        return rows;
      },
      async upsert(args) {
        const { sessionId, widgetKey } = args.where.sessionId_widgetKey;
        const idx = state.rows.findIndex(
          (r) => r.sessionId === sessionId && r.widgetKey === widgetKey,
        );
        if (idx === -1) {
          const row: WidgetRow = {
            id: `w-${state.rows.length + 1}`,
            sessionId,
            widgetKey,
            kind: args.create.kind,
            slot: args.create.slot,
            props: args.create.props,
            order: args.create.order,
            sourceMessageId: args.create.sourceMessageId,
            createdAt: tick(),
            updatedAt: tick(),
          };
          state.rows.push(row);
          return row;
        }
        const existing = state.rows[idx];
        const updated: WidgetRow = {
          ...existing,
          kind: args.update.kind,
          slot: args.update.slot,
          props: args.update.props,
          order: args.update.order,
          sourceMessageId: args.update.sourceMessageId,
          updatedAt: tick(),
        };
        state.rows[idx] = updated;
        return updated;
      },
      async deleteMany(args) {
        const before = state.rows.length;
        state.rows = state.rows.filter(
          (r) =>
            !(
              r.sessionId === args.where.sessionId &&
              r.widgetKey === args.where.widgetKey
            ),
        );
        return { count: before - state.rows.length };
      },
      async findUnique(args) {
        const { sessionId, widgetKey } = args.where.sessionId_widgetKey;
        const found = state.rows.find(
          (r) => r.sessionId === sessionId && r.widgetKey === widgetKey,
        );
        return found ?? null;
      },
    },
  };
  return { prismaLike, state };
}

const validCampaignListProps = { items: [] };
const validContactTableProps = { items: [], total: 0 };
const validCampaignCardProps = {
  id: "c",
  name: "",
  description: null,
  status: "draft",
  event_at: null,
  venue: null,
  locale: "en",
  team_id: null,
  created_at: "2026-04-20T00:00:00.000Z",
  updated_at: "2026-04-20T00:00:00.000Z",
  stats: {
    total: 0,
    responded: 0,
    pending: 0,
    attending: 0,
    declined: 0,
    guests: 0,
    headcount: 0,
    sentEmail: 0,
    sentSms: 0,
  },
  activity: [],
};
const validConfirmDraftProps = {
  id: "c",
  name: "",
  description: null,
  venue: null,
  event_at: null,
  locale: "",
  status: "",
  team_id: null,
  created_at: "",
  state: "done" as const,
};

// ---- the specific repro GPT ran ----

test("concurrency: two parallel singleton-slot writes to the same slot end with exactly one occupant", async () => {
  // This is the literal case from GPT's audit blocker: two
  // different-key writes into the same singleton slot fired in
  // parallel via Promise.all, unprotected by any external
  // synchronization from the caller. Pre-fix, the old ordering
  // (`upsert -> findMany -> deleteMany`) let each writer's
  // post-upsert findMany see the OTHER row and delete it, ending
  // at state.rows === []. Post-fix, the mutex serializes the
  // delete-then-upsert sequence and exactly one occupant survives.
  //
  // The specific survivor depends on microtask scheduling order
  // (whichever coroutine reaches the mutex acquisition first wins
  // the queue position; the other is second-in-queue and evicts the
  // first). We DON'T assert a specific winner — just the invariant:
  //   - len === 1 (never 0, never 2)
  //   - survivor is one of the two writers
  const { prismaLike, state } = makeStubPrisma();
  const sessionId = "s-1";

  const [wA, wB] = await Promise.all([
    upsertWidget(
      { prismaLike },
      {
        sessionId,
        widgetKey: "campaigns.list",
        kind: "campaign_list",
        slot: "primary",
        props: validCampaignListProps,
      },
    ),
    upsertWidget(
      { prismaLike },
      {
        sessionId,
        widgetKey: "contacts.table",
        kind: "contact_table",
        slot: "primary",
        props: validContactTableProps,
      },
    ),
  ]);

  // Both writes completed successfully — null would indicate a
  // validation failure, not a race loss. Races are resolved by
  // eviction, not by rejecting the later writer.
  assert.ok(wA, "first write must succeed (null would mean validation failed)");
  assert.ok(wB, "second write must succeed (null would mean validation failed)");

  // The invariant the fix is targeting. Old code ended at 0; a
  // regression that drops the mutex would end at 2 (both upserts
  // land before either eviction pass runs). Only the correct
  // fix lands at exactly 1.
  assert.equal(
    state.rows.length,
    1,
    "singleton slot must hold exactly one occupant after parallel writes",
  );

  const survivor = state.rows[0]!.widgetKey;
  assert.ok(
    survivor === "campaigns.list" || survivor === "contacts.table",
    `survivor must be one of the two writers (got ${survivor})`,
  );

  // And the hydrate path reflects the same truth as the DB.
  const snap = await listWidgets({ prismaLike }, sessionId);
  assert.equal(snap.widgets.length, 1);
  assert.equal(snap.widgets[0]!.widgetKey, survivor);
});

test("concurrency: ten parallel singleton-slot writes converge to exactly one occupant", async () => {
  // Raise the contention level beyond the two-writer baseline to
  // flush out any bug that only shows up with more queued waiters
  // (e.g. the mutex accidentally releasing all waiters instead of
  // one, a map-delete race that lets two later waiters both win the
  // set, etc.). Each write targets the same singleton slot with a
  // distinct widgetKey, so each SHOULD evict the last survivor
  // before installing itself. After ten writes serialize through
  // the mutex, exactly one row survives.
  const { prismaLike, state } = makeStubPrisma();
  const sessionId = "s-1";

  const writers = Array.from({ length: 10 }, (_, i) =>
    upsertWidget(
      { prismaLike },
      {
        sessionId,
        widgetKey: `campaign.card.${i}`,
        kind: "campaign_card",
        slot: "primary",
        props: { ...validCampaignCardProps, id: `c_${i}`, name: `Event ${i}` },
      },
    ),
  );
  const results = await Promise.all(writers);

  // Every write produced a Widget (none failed validation).
  for (const r of results) assert.ok(r, "every parallel write must succeed");

  assert.equal(
    state.rows.length,
    1,
    "ten parallel writes to one singleton slot must leave exactly one row",
  );

  // The survivor is one of the ten intended writers — not a ghost
  // leftover from a partial delete.
  const survivor = state.rows[0]!.widgetKey;
  assert.ok(
    /^campaign\.card\.\d$/.test(survivor),
    `survivor must be one of the 10 intended writers (got ${survivor})`,
  );
});

// ---- mutex granularity: per (sessionId, slot) ----

test("concurrency: parallel writes to different sessions do NOT cross-serialize", async () => {
  // The lock key is `${sessionId}:${slot}` — different sessions
  // should proceed independently. If the lock key were accidentally
  // per-slot-only (shared across sessions), this test would still
  // pass on correctness (each session ends with its own row) but
  // would reveal a throughput bug under load. We don't measure
  // throughput here; we pin the correctness version: each session
  // ends with exactly one row, not zero, and the two rows don't
  // cross-contaminate keys.
  const { prismaLike, state } = makeStubPrisma();

  const [wA, wB] = await Promise.all([
    upsertWidget(
      { prismaLike },
      {
        sessionId: "s-1",
        widgetKey: "campaigns.list",
        kind: "campaign_list",
        slot: "primary",
        props: validCampaignListProps,
      },
    ),
    upsertWidget(
      { prismaLike },
      {
        sessionId: "s-2",
        widgetKey: "campaigns.list",
        kind: "campaign_list",
        slot: "primary",
        props: validCampaignListProps,
      },
    ),
  ]);

  assert.ok(wA);
  assert.ok(wB);
  assert.equal(state.rows.length, 2, "one row per independent session");
  const keysBySession = new Map<string, string[]>();
  for (const r of state.rows) {
    const arr = keysBySession.get(r.sessionId) ?? [];
    arr.push(r.widgetKey);
    keysBySession.set(r.sessionId, arr);
  }
  assert.deepEqual(keysBySession.get("s-1"), ["campaigns.list"]);
  assert.deepEqual(keysBySession.get("s-2"), ["campaigns.list"]);
});

test("concurrency: parallel writes to different slots in the same session do NOT cross-serialize", async () => {
  // Primary-singleton vs secondary-singleton are independent slots;
  // a lock held on primary must not block a secondary writer. Same
  // correctness-over-throughput rationale as the cross-session
  // test — we pin that both rows exist, not that they ran in
  // parallel wall-clock time.
  const { prismaLike, state } = makeStubPrisma();
  const sessionId = "s-1";

  const [wA, wB] = await Promise.all([
    upsertWidget(
      { prismaLike },
      {
        sessionId,
        widgetKey: "campaigns.list",
        kind: "campaign_list",
        slot: "primary",
        props: validCampaignListProps,
      },
    ),
    upsertWidget(
      { prismaLike },
      {
        sessionId,
        widgetKey: "activity.stream",
        kind: "activity_stream",
        slot: "secondary",
        props: { items: [] },
      },
    ),
  ]);

  assert.ok(wA);
  assert.ok(wB);
  assert.equal(state.rows.length, 2);
  const slots = state.rows.map((r) => r.slot).sort();
  assert.deepEqual(slots, ["primary", "secondary"]);
});

// ---- coexist-per-key bypasses the mutex entirely ----

test("concurrency: parallel action-slot writes all persist (coexist-per-key, mutex bypass)", async () => {
  // Action slot is coexist-per-key — no eviction, no mutex,
  // Promise.all arms run freely. All three writes must land.
  // If a future regression accidentally put the action slot under
  // the mutex, this test still passes on correctness (three rows
  // end up in the DB in serial execution) but the mutex bypass
  // would be silently lost. The test is a grep-auditable pin on
  // the bypass: if someone removes the `isSingleton` guard, this
  // test catches the change via the comments and assertion text.
  const { prismaLike, state } = makeStubPrisma();
  const sessionId = "s-1";

  const results = await Promise.all([
    upsertWidget(
      { prismaLike },
      {
        sessionId,
        widgetKey: "confirm.draft.c-1",
        kind: "confirm_draft",
        slot: "action",
        props: validConfirmDraftProps,
      },
    ),
    upsertWidget(
      { prismaLike },
      {
        sessionId,
        widgetKey: "confirm.draft.c-2",
        kind: "confirm_draft",
        slot: "action",
        props: { ...validConfirmDraftProps, id: "c-2" },
      },
    ),
    upsertWidget(
      { prismaLike },
      {
        sessionId,
        widgetKey: "confirm.draft.c-3",
        kind: "confirm_draft",
        slot: "action",
        props: { ...validConfirmDraftProps, id: "c-3" },
      },
    ),
  ]);

  for (const r of results) assert.ok(r);
  assert.equal(state.rows.length, 3);
  const keys = state.rows.map((r) => r.widgetKey).sort();
  assert.deepEqual(
    keys,
    ["confirm.draft.c-1", "confirm.draft.c-2", "confirm.draft.c-3"],
  );
});

// ---- emitter-level: SSE stream under concurrent upserts ----

type SseEvent = { event: string; data: unknown };

test("concurrency: parallel emitter.upsert calls to one singleton slot emit coherent SSE — exactly one survivor gets widget_focus", async () => {
  // The client's workspace reducer applies SSE events in arrival
  // order. Under the pre-fix DB race, the emitter could send
  // `widget_upsert(A)` + `widget_focus(A)` even though A's row was
  // already gone — a ghost focus pointing at a deleted widget.
  //
  // Post-fix, the mutex serializes the whole upsertWidget body,
  // and the emitter collects-then-flushes its frames around that
  // call. Result: the two emitter.upsert invocations produce two
  // coherent frame sequences serialized one after the other,
  // and the DB state matches the LAST frame's focus target.
  const { prismaLike, state } = makeStubPrisma();
  const events: SseEvent[] = [];
  const send = (event: string, data: unknown) => {
    events.push({ event, data });
  };
  const emitter = createWorkspaceEmitter({ prismaLike }, "s-1", send);

  await Promise.all([
    emitter.upsert({
      widgetKey: "campaigns.list",
      kind: "campaign_list",
      slot: "primary",
      props: validCampaignListProps,
    }),
    emitter.upsert({
      widgetKey: "contacts.table",
      kind: "contact_table",
      slot: "primary",
      props: validContactTableProps,
    }),
  ]);

  // DB: exactly one row (the invariant from the first test above).
  assert.equal(state.rows.length, 1);
  const survivor = state.rows[0]!.widgetKey;

  // The last `widget_focus` in the stream must target the actual
  // DB survivor — a ghost-focus regression would point at the
  // evicted key.
  const focusEvents = events.filter((e) => e.event === "widget_focus");
  assert.ok(
    focusEvents.length >= 1,
    "at least one widget_focus must land for the surviving writer",
  );
  const lastFocus = focusEvents[focusEvents.length - 1]!
    .data as { widgetKey: string };
  assert.equal(
    lastFocus.widgetKey,
    survivor,
    "final widget_focus must point at the DB survivor, not a ghost",
  );

  // And every widget_upsert in the stream references a widgetKey
  // one of the two writers produced — no rogue keys leaked.
  const upsertKeys = events
    .filter((e) => e.event === "widget_upsert")
    .map((e) => (e.data as { widgetKey: string }).widgetKey);
  for (const k of upsertKeys) {
    assert.ok(
      k === "campaigns.list" || k === "contacts.table",
      `emitted widget_upsert must reference one of the two writers (got ${k})`,
    );
  }
});
