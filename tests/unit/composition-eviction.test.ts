import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createWorkspaceEmitter,
  listWidgets,
  upsertWidget,
  type PrismaLike,
  type WidgetRow,
} from "../../src/lib/ai/widgets";

// P8 — slot composition & eviction tests.
//
// Pin the runtime behaviour of `SLOT_COMPOSITION` as it flows
// through `upsertWidget` and the `WorkspaceEmitter`. The policy
// tables in slotPolicy.ts are the declarative source of truth;
// these tests lock the code that READS that table:
//
//   - singleton-per-slot slots (summary/primary/secondary): a NEW
//     widgetKey in the slot EVICTS any prior widgets with a
//     different key. The SAME widgetKey updates in place (no
//     self-eviction).
//   - coexist-per-key slots (action): multiple widgetKeys live
//     side-by-side. No eviction on peer writes.
//   - Policy rejection: a kind+slot mismatch is rejected by the
//     validator BEFORE eviction would run — no sibling is wiped
//     when the would-be occupant never lands.
//   - SSE ordering: the emitter fires `widget_remove` frames for
//     every evicted sibling BEFORE `widget_upsert` + `widget_focus`
//     for the new widget, so the client reducer never sees a
//     transient two-cards-in-one-singleton-slot state.
//
// An in-memory PrismaLike stub mirrors the unique constraint on
// (sessionId, widgetKey) — same pattern widget-helpers.test.ts uses,
// duplicated here so this test file is self-contained and a future
// widget-helpers refactor can't accidentally regress the composition
// assertions through shared-fixture drift.

type StubState = { rows: WidgetRow[]; nowMs: number };

function makeStubPrisma(): { prismaLike: PrismaLike; state: StubState } {
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

// ---- valid props per kind (minimal) ----

const validCampaignListProps = { items: [] };
const validContactTableProps = { items: [], total: 0 };
const validActivityStreamProps = { items: [] };
const validFileDigestProps = {
  fileUploadId: "up_1",
  ingestId: "ing_1",
  filename: "test.txt",
  kind: "text_plain" as const,
  status: "extracted" as const,
  bytesExtracted: 5,
  preview: "hello",
  charCount: 5,
  lineCount: 1,
  extractedAt: "2026-04-19T10:00:00.000Z",
  extractionError: null,
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

// ---- singleton-per-slot: eviction on different widgetKey ----

test("upsertWidget: writing a NEW widgetKey in a singleton slot evicts the prior occupant", async () => {
  // The core P8 invariant: singleton-per-slot means exactly one
  // widgetKey can occupy the slot at any time. A second write with
  // a different widgetKey replaces the first via DB-level delete
  // (not an update) so the row is genuinely gone — a hydrate on
  // reload would see only the newest.
  const { prismaLike, state } = makeStubPrisma();

  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "campaigns.list",
      kind: "campaign_list",
      slot: "primary",
      props: validCampaignListProps,
    },
  );
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0]!.widgetKey, "campaigns.list");

  // Pivot to a campaign card — same slot (primary), different kind,
  // different widgetKey. The list widget MUST go.
  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "contacts.table",
      kind: "contact_table",
      slot: "primary",
      props: validContactTableProps,
    },
  );

  assert.equal(state.rows.length, 1, "only one primary widget remains");
  assert.equal(state.rows[0]!.widgetKey, "contacts.table");
  assert.equal(state.rows[0]!.kind, "contact_table");
});

test("upsertWidget: re-writing the SAME widgetKey in a singleton slot updates in place (no self-eviction)", async () => {
  // Self-eviction would mean "upsert of the same key removes itself
  // before writing back" — a subtle bug that would still end with
  // the correct terminal state but would churn the DB and emit a
  // spurious widget_remove SSE. This pins that same-key writes go
  // through the upsert path only.
  const { prismaLike, state } = makeStubPrisma();
  const evictedKeys: string[] = [];

  await upsertWidget(
    {
      prismaLike,
      onEvict: (k) => evictedKeys.push(k),
    },
    {
      sessionId: "s-1",
      widgetKey: "campaigns.list",
      kind: "campaign_list",
      slot: "primary",
      props: validCampaignListProps,
    },
  );
  await upsertWidget(
    {
      prismaLike,
      onEvict: (k) => evictedKeys.push(k),
    },
    {
      sessionId: "s-1",
      widgetKey: "campaigns.list",
      kind: "campaign_list",
      slot: "primary",
      props: { ...validCampaignListProps, items: [] },
    },
  );

  assert.equal(state.rows.length, 1);
  assert.equal(evictedKeys.length, 0, "same key must not self-evict");
});

test("upsertWidget: secondary-slot file_digest upsert evicts prior file_digest (same slot, different ingest)", async () => {
  // Secondary is also singleton-per-slot. A re-summarise of a
  // different file produces a new widgetKey (`file.digest.<ingestId>`
  // with a different ingestId) in the same secondary slot, and the
  // prior digest MUST go — matching the `workspace feel single
  // focused file at a time` UX intent the policy encodes.
  const { prismaLike, state } = makeStubPrisma();

  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "file.digest.ing-A",
      kind: "file_digest",
      slot: "secondary",
      props: validFileDigestProps,
    },
  );
  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "file.digest.ing-B",
      kind: "file_digest",
      slot: "secondary",
      props: { ...validFileDigestProps, ingestId: "ing_B" },
    },
  );

  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0]!.widgetKey, "file.digest.ing-B");
});

test("upsertWidget: evicting a primary occupant leaves secondary / action slots untouched", async () => {
  // Cross-slot isolation — evicting in primary must not touch a
  // resident of secondary or action. A broken eviction loop that
  // filtered by sessionId alone (not by slot) would wipe every
  // widget in the session on any write.
  const { prismaLike, state } = makeStubPrisma();

  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "campaigns.list",
      kind: "campaign_list",
      slot: "primary",
      props: validCampaignListProps,
    },
  );
  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "activity.stream",
      kind: "activity_stream",
      slot: "secondary",
      props: validActivityStreamProps,
    },
  );
  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "confirm.draft.c-1",
      kind: "confirm_draft",
      slot: "action",
      props: validConfirmDraftProps,
    },
  );

  // Now swap the primary occupant.
  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "contacts.table",
      kind: "contact_table",
      slot: "primary",
      props: validContactTableProps,
    },
  );

  // Primary was swapped (1 row, new occupant), secondary + action
  // both still present.
  const snap = await listWidgets({ prismaLike }, "s-1");
  const keys = snap.widgets.map((w) => w.widgetKey).sort();
  assert.deepEqual(
    keys,
    ["activity.stream", "confirm.draft.c-1", "contacts.table"],
  );
  assert.equal(state.rows.length, 3);
});

// ---- coexist-per-key: action slot keeps siblings alive ----

test("upsertWidget: action slot keeps multiple confirm cards coexisting (coexist-per-key)", async () => {
  // Operators routinely have a confirm_send queued alongside a
  // confirm_import — losing one because the other emitted would
  // throw away a ready authorization anchor. This test is the
  // regression guard for that UX.
  const { prismaLike, state } = makeStubPrisma();

  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "confirm.draft.c-1",
      kind: "confirm_draft",
      slot: "action",
      props: validConfirmDraftProps,
    },
  );
  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "confirm.draft.c-2",
      kind: "confirm_draft",
      slot: "action",
      props: { ...validConfirmDraftProps, id: "c-2" },
    },
  );
  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "confirm.draft.c-3",
      kind: "confirm_draft",
      slot: "action",
      props: { ...validConfirmDraftProps, id: "c-3" },
    },
  );

  assert.equal(state.rows.length, 3, "action slot must keep all three");
  const snap = await listWidgets({ prismaLike }, "s-1");
  const keys = snap.widgets.map((w) => w.widgetKey).sort();
  assert.deepEqual(
    keys,
    ["confirm.draft.c-1", "confirm.draft.c-2", "confirm.draft.c-3"],
  );
});

// ---- policy rejection short-circuits eviction ----

test("upsertWidget: kind+slot mismatch returns null and does NOT evict anyone", async () => {
  // If the validator rejects the new widget, NONE of the siblings
  // should be evicted — the slot has to stay intact for the next
  // legitimate write. A regression here would mean a buggy tool
  // call (emitting wrong slot) silently wipes the slot.
  const { prismaLike, state } = makeStubPrisma();

  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "campaigns.list",
      kind: "campaign_list",
      slot: "primary",
      props: validCampaignListProps,
    },
  );
  assert.equal(state.rows.length, 1);

  const evictedKeys: string[] = [];
  // campaign_list declared for slot "action" is a SLOT_POLICY
  // violation — validator returns null, upsert never runs.
  const out = await upsertWidget(
    {
      prismaLike,
      onEvict: (k) => evictedKeys.push(k),
    },
    {
      sessionId: "s-1",
      widgetKey: "new-one",
      kind: "campaign_list",
      slot: "action",
      props: validCampaignListProps,
    },
  );

  assert.equal(out, null);
  assert.equal(evictedKeys.length, 0, "no sibling evicted on validator fail");
  assert.equal(state.rows.length, 1, "original primary occupant survives");
  assert.equal(state.rows[0]!.widgetKey, "campaigns.list");
});

// ---- emitter-level SSE ordering ----

type SseEvent = { event: string; data: unknown };

function captureSends(): {
  events: SseEvent[];
  send: (e: string, d: unknown) => void;
} {
  const events: SseEvent[] = [];
  return {
    events,
    send: (event, data) => {
      events.push({ event, data });
    },
  };
}

test("emitter.upsert: fires widget_remove for each evicted sibling BEFORE widget_upsert/widget_focus", async () => {
  // SSE ordering matters to the client reducer: the remove has to
  // arrive and be applied (filter-out) before the upsert (append or
  // replace) and focus (scroll to). An out-of-order stream could
  // render both cards briefly in the same singleton slot, or even
  // leave the old card focused while the new card appears below.
  const { prismaLike } = makeStubPrisma();
  const { events, send } = captureSends();
  const emitter = createWorkspaceEmitter({ prismaLike }, "s-1", send);

  // Seed: one campaign_list in primary.
  await emitter.upsert({
    widgetKey: "campaigns.list",
    kind: "campaign_list",
    slot: "primary",
    props: validCampaignListProps,
  });
  // 2 frames from the seed (upsert + focus), nothing else.
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "widget_upsert");
  assert.equal(events[1].event, "widget_focus");

  // Now pivot to a contact_table — primary still, different key.
  // Expected frames from THIS call: widget_remove for the evicted
  // campaigns.list, then widget_upsert + widget_focus for the new.
  events.length = 0;
  await emitter.upsert({
    widgetKey: "contacts.table",
    kind: "contact_table",
    slot: "primary",
    props: validContactTableProps,
  });

  assert.equal(events.length, 3, "3 frames total: 1 remove + 1 upsert + 1 focus");
  assert.equal(events[0].event, "widget_remove");
  assert.deepEqual(events[0].data, { widgetKey: "campaigns.list" });
  assert.equal(events[1].event, "widget_upsert");
  const upsertPayload = events[1].data as { widgetKey: string };
  assert.equal(upsertPayload.widgetKey, "contacts.table");
  assert.equal(events[2].event, "widget_focus");
  assert.deepEqual(events[2].data, { widgetKey: "contacts.table" });
});

test("emitter.upsert: coexist-per-key action writes emit NO widget_remove for peers", async () => {
  // Inverse of the eviction test — action slot is coexist-per-key,
  // so a second confirm card MUST NOT trigger a widget_remove frame
  // for the first. The first card stays live on the client.
  const { prismaLike } = makeStubPrisma();
  const { events, send } = captureSends();
  const emitter = createWorkspaceEmitter({ prismaLike }, "s-1", send);

  await emitter.upsert({
    widgetKey: "confirm.draft.c-1",
    kind: "confirm_draft",
    slot: "action",
    props: validConfirmDraftProps,
  });
  events.length = 0;

  await emitter.upsert({
    widgetKey: "confirm.draft.c-2",
    kind: "confirm_draft",
    slot: "action",
    props: { ...validConfirmDraftProps, id: "c-2" },
  });

  // Only upsert + focus — NO widget_remove for the coexisting
  // first draft.
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "widget_upsert");
  assert.equal(events[1].event, "widget_focus");
});

test("emitter.upsert: evicting multiple unreachable legacy siblings emits one widget_remove per sibling", async () => {
  // Defence-in-depth for the "pre-P8 DB state" case: if the
  // session already has two widgets in the same singleton slot
  // (which SHOULD no longer be possible under P8 but CAN exist in
  // older stored sessions), a new write must evict ALL of them,
  // not just one, and emit a widget_remove SSE for each so the
  // client catches up.
  const { prismaLike, state } = makeStubPrisma();

  // Plant two pre-policy rows directly into storage — skipping the
  // validator entirely, simulating historic sessions written before
  // P8 landed.
  const now = new Date("2026-04-18T00:00:00.000Z");
  state.rows.push(
    {
      id: "w-legacy-1",
      sessionId: "s-1",
      widgetKey: "legacy-A",
      kind: "campaign_list",
      slot: "primary",
      props: JSON.stringify(validCampaignListProps),
      order: 0,
      sourceMessageId: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "w-legacy-2",
      sessionId: "s-1",
      widgetKey: "legacy-B",
      kind: "campaign_list",
      slot: "primary",
      props: JSON.stringify(validCampaignListProps),
      order: 1,
      sourceMessageId: null,
      createdAt: now,
      updatedAt: now,
    },
  );

  const { events, send } = captureSends();
  const emitter = createWorkspaceEmitter({ prismaLike }, "s-1", send);

  // New primary write — should evict BOTH legacy rows.
  await emitter.upsert({
    widgetKey: "contacts.table",
    kind: "contact_table",
    slot: "primary",
    props: validContactTableProps,
  });

  // Two evictions, then upsert + focus = 4 frames.
  assert.equal(events.length, 4);
  assert.equal(events[0].event, "widget_remove");
  assert.equal(events[1].event, "widget_remove");
  assert.equal(events[2].event, "widget_upsert");
  assert.equal(events[3].event, "widget_focus");

  // Both legacy keys are in the removed set (order among the two
  // removes is emission order; assert membership without ordering).
  const removedKeys = new Set<string>();
  for (const e of events) {
    if (e.event !== "widget_remove") continue;
    const d = e.data as { widgetKey: string };
    removedKeys.add(d.widgetKey);
  }
  assert.deepEqual(
    [...removedKeys].sort(),
    ["legacy-A", "legacy-B"],
  );

  // DB state post-eviction: exactly one row, the new occupant.
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0]!.widgetKey, "contacts.table");
});
