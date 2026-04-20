import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createWorkspaceEmitter,
  focusWidget,
  listWidgets,
  removeWidget,
  rowToWidget,
  upsertWidget,
  type PrismaLike,
  type WidgetRow,
} from "../../src/lib/ai/widgets";

// Unit tests for the widget persistence helpers + workspace emitter.
//
// The helpers take an injected `PrismaLike` so we can stub the four
// `chatWidget` methods they actually touch
// (`findMany`/`upsert`/`deleteMany`/`findUnique`) with an in-memory
// Map. No real Prisma, no DB, no side effects — matches the pattern
// the OAuth route-level tests already use.
//
// The emitter tests confirm the "emit only on effect" rule GPT's W1
// spec asks for:
//   - `upsert` emits widget_upsert on successful write, nothing on
//     validation failure.
//   - `remove` emits widget_remove only when a row actually went away.
//   - `focus` emits widget_focus only when the target widget exists.
//   - `snapshot` emits workspace_snapshot even on empty (authoritative
//     "clear state" signal).

// ---- in-memory PrismaLike stub ----
//
// Models the unique constraint `@@unique([sessionId, widgetKey])`
// exactly — upsert keys on (sessionId, widgetKey) so re-writing the
// same key updates in place. The few production edge cases this
// doesn't simulate (transactional atomicity, FK cascade) don't
// matter for the assertions we make here.
type StubState = { rows: WidgetRow[]; nowMs: number };

function makeStubPrisma(): { prismaLike: PrismaLike; state: StubState } {
  const state: StubState = { rows: [], nowMs: 1_700_000_000_000 };
  const tick = () => new Date((state.nowMs += 1));

  const prismaLike: PrismaLike = {
    chatWidget: {
      async findMany(args) {
        let rows = state.rows.filter((r) => r.sessionId === args.where.sessionId);
        // Mirror the orderBy the helper passes in — slot asc, order
        // asc, updatedAt asc. Stable sort so ties are deterministic.
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
            const cmp = (av as unknown as number) < (bv as unknown as number)
              ? -1
              : 1;
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

// Valid minimum-shape props per kind — reused across tests so a
// prop-shape tweak in widget-validate surfaces here immediately.
const validCampaignListProps = { items: [] };
const validContactTableProps = { items: [], total: 0 };

// ---- upsertWidget ----

test("upsertWidget: inserts a new widget", async () => {
  const { prismaLike, state } = makeStubPrisma();
  const widget = await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "campaign_list:active",
      kind: "campaign_list",
      slot: "primary",
      props: validCampaignListProps,
    },
  );
  assert.ok(widget);
  assert.equal(widget?.widgetKey, "campaign_list:active");
  assert.equal(widget?.kind, "campaign_list");
  assert.equal(widget?.slot, "primary");
  assert.equal(state.rows.length, 1);
  // `props` round-trips through JSON.stringify on write and
  // JSON.parse on read — ensure the returned object is the parsed
  // shape, not the stored string.
  assert.deepEqual(widget?.props, validCampaignListProps);
});

test("upsertWidget: updates in place on same (sessionId, widgetKey)", async () => {
  const { prismaLike, state } = makeStubPrisma();
  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "stable-key",
      kind: "campaign_list",
      slot: "primary",
      props: validCampaignListProps,
    },
  );
  const updated = await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "stable-key",
      // Kind may CHANGE across upserts within the same policy slot
      // — the stable identity is (sessionId, widgetKey), not
      // (sessionId, widgetKey, kind). P8 locks each kind to its
      // SLOT_POLICY slot, so the new kind must pick a partner slot
      // consistent with the policy (here `contact_table` -> primary,
      // same as the previous campaign_list's slot). A cross-slot
      // change on the same widgetKey is rejected by the validator
      // AFTER the policy check rather than silently migrating slot.
      kind: "contact_table",
      slot: "primary",
      props: validContactTableProps,
    },
  );
  // One row, not two — GPT's "no duplicate card spam" rule.
  assert.equal(state.rows.length, 1);
  assert.equal(updated?.kind, "contact_table");
  assert.equal(updated?.slot, "primary");
});

test("upsertWidget: different widgetKeys coexist in the same session's coexist-per-key slot", async () => {
  // Pre-P8 this test confirmed that two different widgetKeys
  // coexist in the same session regardless of slot. P8's
  // singleton-per-slot rule now forbids that for primary / secondary
  // / summary (see composition-eviction.test.ts for the eviction
  // behaviour). The cross-key coexistence invariant is still true
  // but ONLY for coexist-per-key slots — today, `action`. Two
  // confirm cards with different widgetKeys both persist side-by-
  // side.
  const { prismaLike, state } = makeStubPrisma();
  const validConfirmDraftProps = {
    id: "c-1",
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
  assert.equal(state.rows.length, 2);
});

test("upsertWidget: same widgetKey across different sessions does NOT collide", async () => {
  const { prismaLike, state } = makeStubPrisma();
  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "shared",
      kind: "campaign_list",
      slot: "primary",
      props: validCampaignListProps,
    },
  );
  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-2",
      widgetKey: "shared",
      kind: "campaign_list",
      slot: "primary",
      props: validCampaignListProps,
    },
  );
  assert.equal(state.rows.length, 2);
});

test("upsertWidget: returns null on invalid input (validator failure)", async () => {
  const { prismaLike, state } = makeStubPrisma();
  const widget = await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "x",
      kind: "unknown_kind",
      slot: "primary",
      props: {},
    },
  );
  assert.equal(widget, null);
  // Crucially, no row was written — validation happens BEFORE the
  // Prisma call.
  assert.equal(state.rows.length, 0);
});

test("upsertWidget: returns null when sessionId is empty", async () => {
  const { prismaLike, state } = makeStubPrisma();
  const widget = await upsertWidget(
    { prismaLike },
    {
      sessionId: "",
      widgetKey: "x",
      kind: "campaign_list",
      slot: "primary",
      props: validCampaignListProps,
    },
  );
  assert.equal(widget, null);
  assert.equal(state.rows.length, 0);
});

test("upsertWidget: defaults order to 0 and sourceMessageId to null", async () => {
  const { prismaLike, state } = makeStubPrisma();
  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "x",
      kind: "campaign_list",
      slot: "primary",
      props: validCampaignListProps,
    },
  );
  const row = state.rows[0];
  assert.equal(row.order, 0);
  assert.equal(row.sourceMessageId, null);
});

// ---- listWidgets ----

test("listWidgets: returns [] for a session with no widgets", async () => {
  const { prismaLike } = makeStubPrisma();
  const result = await listWidgets({ prismaLike }, "s-1");
  assert.deepEqual(result.widgets, []);
  assert.equal(result.skipped, 0);
});

test("listWidgets: orders by slot then order", async () => {
  const { prismaLike } = makeStubPrisma();
  // Pre-P8 this test put two campaign_list widgets in `primary` to
  // prove within-slot `order` ordering. Under P8 the primary slot is
  // singleton-per-slot (a second widgetKey would evict the first),
  // so within-slot ordering has to be exercised in a coexist-per-key
  // slot — `action` — instead. We keep the original test intent:
  //   - Cross-slot ordering: `action` < `secondary` (alphabetic slot
  //     asc precedes).
  //   - Within-slot ordering: two `action` confirm_drafts with
  //     distinct `order` values come out `order 0` first.
  // Minimal valid confirm_draft props — the validator requires the
  // full envelope even when the test only cares about widgetKey/slot
  // ordering. `state: "done"` is the only state the validator accepts
  // for this kind (drafts are terminal-on-creation).
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
  const activityProps = { items: [] };
  // Insert in a jumbled order to prove sort is by slot/order, not
  // by insertion order.
  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "b-secondary",
      kind: "activity_stream",
      slot: "secondary",
      props: activityProps,
      order: 0,
    },
  );
  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "a-action-1",
      kind: "confirm_draft",
      slot: "action",
      props: validConfirmDraftProps,
      order: 1,
    },
  );
  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "a-action-0",
      kind: "confirm_draft",
      slot: "action",
      props: validConfirmDraftProps,
      order: 0,
    },
  );
  const result = await listWidgets({ prismaLike }, "s-1");
  assert.deepEqual(
    result.widgets.map((w) => w.widgetKey),
    // action, primary, secondary, summary is the alphabetic slot
    // order; within action, order 0 precedes order 1.
    ["a-action-0", "a-action-1", "b-secondary"],
  );
});

test("listWidgets: skips rows with unparseable props JSON", async () => {
  const { prismaLike, state } = makeStubPrisma();
  // Seed a valid row and a corrupt one directly — bypasses
  // upsertWidget's validator so we can stage exactly what drift
  // looks like in the wild.
  state.rows.push({
    id: "w-1",
    sessionId: "s-1",
    widgetKey: "good",
    kind: "campaign_list",
    slot: "primary",
    props: JSON.stringify(validCampaignListProps),
    order: 0,
    sourceMessageId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  state.rows.push({
    id: "w-2",
    sessionId: "s-1",
    widgetKey: "broken",
    kind: "campaign_list",
    slot: "primary",
    // Not JSON — a truncated write from a prior bug.
    props: "{malformed",
    order: 1,
    sourceMessageId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const result = await listWidgets({ prismaLike }, "s-1");
  assert.equal(result.widgets.length, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.widgets[0].widgetKey, "good");
});

test("listWidgets: skips rows with unknown kind (schema drift)", async () => {
  const { prismaLike, state } = makeStubPrisma();
  state.rows.push({
    id: "w-1",
    sessionId: "s-1",
    widgetKey: "stale",
    // A kind that WAS valid when written but isn't in the current
    // registry. The read path drops it rather than blank-paint.
    kind: "old_widget_kind",
    slot: "primary",
    props: JSON.stringify({}),
    order: 0,
    sourceMessageId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const result = await listWidgets({ prismaLike }, "s-1");
  assert.equal(result.widgets.length, 0);
  assert.equal(result.skipped, 1);
});

test("listWidgets: skips rows with unknown slot", async () => {
  const { prismaLike, state } = makeStubPrisma();
  state.rows.push({
    id: "w-1",
    sessionId: "s-1",
    widgetKey: "bad-slot",
    kind: "campaign_list",
    slot: "sidebar", // not in WIDGET_SLOTS
    props: JSON.stringify(validCampaignListProps),
    order: 0,
    sourceMessageId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const result = await listWidgets({ prismaLike }, "s-1");
  assert.equal(result.widgets.length, 0);
  assert.equal(result.skipped, 1);
});

// ---- removeWidget ----

test("removeWidget: returns removed=true when a row was deleted", async () => {
  const { prismaLike, state } = makeStubPrisma();
  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "x",
      kind: "campaign_list",
      slot: "primary",
      props: validCampaignListProps,
    },
  );
  const result = await removeWidget({ prismaLike }, "s-1", "x");
  assert.equal(result.removed, true);
  assert.equal(state.rows.length, 0);
});

test("removeWidget: is idempotent (removed=false on repeat)", async () => {
  const { prismaLike } = makeStubPrisma();
  const first = await removeWidget({ prismaLike }, "s-1", "nonexistent");
  assert.equal(first.removed, false);
  // No throw, safe to call again — matches Prisma deleteMany.
  const second = await removeWidget({ prismaLike }, "s-1", "nonexistent");
  assert.equal(second.removed, false);
});

test("removeWidget: rejects empty sessionId / widgetKey with removed=false", async () => {
  const { prismaLike } = makeStubPrisma();
  assert.equal((await removeWidget({ prismaLike }, "", "x")).removed, false);
  assert.equal((await removeWidget({ prismaLike }, "s-1", "")).removed, false);
});

// ---- focusWidget ----

test("focusWidget: returns the widget when it exists", async () => {
  const { prismaLike } = makeStubPrisma();
  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "x",
      kind: "campaign_list",
      slot: "primary",
      props: validCampaignListProps,
    },
  );
  const widget = await focusWidget({ prismaLike }, "s-1", "x");
  assert.ok(widget);
  assert.equal(widget?.widgetKey, "x");
});

test("focusWidget: returns null for a missing widget", async () => {
  const { prismaLike } = makeStubPrisma();
  assert.equal(await focusWidget({ prismaLike }, "s-1", "ghost"), null);
});

// ---- rowToWidget (read-path smoke) ----

test("rowToWidget: returns null on JSON parse failure", () => {
  const out = rowToWidget({
    id: "w-1",
    sessionId: "s-1",
    widgetKey: "x",
    kind: "campaign_list",
    slot: "primary",
    props: "{not json",
    order: 0,
    sourceMessageId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  assert.equal(out, null);
});

test("rowToWidget: serialises dates as ISO strings", () => {
  const createdAt = new Date("2026-04-19T10:00:00Z");
  const updatedAt = new Date("2026-04-19T10:05:00Z");
  const out = rowToWidget({
    id: "w-1",
    sessionId: "s-1",
    widgetKey: "x",
    kind: "campaign_list",
    slot: "primary",
    props: JSON.stringify(validCampaignListProps),
    order: 0,
    sourceMessageId: null,
    createdAt,
    updatedAt,
  });
  assert.ok(out);
  assert.equal(out?.createdAt, "2026-04-19T10:00:00.000Z");
  assert.equal(out?.updatedAt, "2026-04-19T10:05:00.000Z");
});

test("rowToWidget: pre-P13-E workspace_rollup blob hydrates with zero-filled per-channel counters", () => {
  // Real-world regression: a session that was created before the
  // P13-E widening has a persisted `workspace_rollup` row whose
  // `invitations` only carries `sent_24h`. Without the compat path
  // in rowToWidget, strict validation rejects the row and the
  // summary widget silently disappears from the dashboard for
  // every read-only session open until the operator happens to
  // mutate something (which triggers a real refresh). Zero-fill
  // preserves the widget; the next write-path event rewrites the
  // row with real per-channel counts.
  const preP13ERollupProps = {
    campaigns: { draft: 1, active: 2, closed: 0, archived: 0, total: 3 },
    invitees: { total: 50 },
    responses: { total: 20, attending: 15, declined: 5, recent_24h: 2 },
    invitations: { sent_24h: 7 }, // only the aggregate, no per-channel split
    generated_at: "2026-04-18T12:00:00.000Z",
  };
  const out = rowToWidget({
    id: "w-rollup-old",
    sessionId: "s-1",
    widgetKey: "workspace.summary",
    kind: "workspace_rollup",
    slot: "summary",
    props: JSON.stringify(preP13ERollupProps),
    order: 0,
    sourceMessageId: null,
    createdAt: new Date("2026-04-18T12:00:00Z"),
    updatedAt: new Date("2026-04-18T12:00:00Z"),
  });
  assert.ok(out, "pre-P13-E rollup row must hydrate under the compat path");
  const p = out!.props as {
    invitations: {
      sent_24h: number;
      sent_email_24h: number;
      sent_sms_24h: number;
      sent_whatsapp_24h: number;
    };
  };
  // Aggregate passes through unchanged.
  assert.equal(p.invitations.sent_24h, 7);
  // Per-channel fields were missing and zero-filled.
  assert.equal(p.invitations.sent_email_24h, 0);
  assert.equal(p.invitations.sent_sms_24h, 0);
  assert.equal(p.invitations.sent_whatsapp_24h, 0);
});

test("rowToWidget: post-P13-E workspace_rollup blob round-trips without mutation", () => {
  // Pin the negative half: when the persisted row already has the
  // new shape, the compat normalizer is a no-op. Anything else
  // would mean a subtle drift — e.g. the normalizer accidentally
  // overwriting real per-channel counts with zeros.
  const postP13ERollupProps = {
    campaigns: { draft: 1, active: 2, closed: 0, archived: 0, total: 3 },
    invitees: { total: 50 },
    responses: { total: 20, attending: 15, declined: 5, recent_24h: 2 },
    invitations: {
      sent_24h: 7,
      sent_email_24h: 3,
      sent_sms_24h: 2,
      sent_whatsapp_24h: 2,
    },
    generated_at: "2026-04-19T12:00:00.000Z",
  };
  const out = rowToWidget({
    id: "w-rollup-new",
    sessionId: "s-1",
    widgetKey: "workspace.summary",
    kind: "workspace_rollup",
    slot: "summary",
    props: JSON.stringify(postP13ERollupProps),
    order: 0,
    sourceMessageId: null,
    createdAt: new Date("2026-04-19T12:00:00Z"),
    updatedAt: new Date("2026-04-19T12:00:00Z"),
  });
  assert.ok(out);
  assert.deepEqual(out!.props, postP13ERollupProps);
});

test("rowToWidget: genuinely malformed workspace_rollup (missing aggregate) still rejects", () => {
  // The compat normalizer only fills the three per-channel fields.
  // A row whose `invitations` is missing the aggregate `sent_24h`
  // is actually corrupt (the compute helper writes it on every
  // refresh), not cross-version, so strict validation must still
  // drop it.
  const trulyBadRollup = {
    campaigns: { draft: 0, active: 0, closed: 0, archived: 0, total: 0 },
    invitees: { total: 0 },
    responses: { total: 0, attending: 0, declined: 0, recent_24h: 0 },
    invitations: {}, // no sent_24h — genuinely malformed
    generated_at: "2026-04-19T12:00:00.000Z",
  };
  const out = rowToWidget({
    id: "w-rollup-bad",
    sessionId: "s-1",
    widgetKey: "workspace.summary",
    kind: "workspace_rollup",
    slot: "summary",
    props: JSON.stringify(trulyBadRollup),
    order: 0,
    sourceMessageId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  assert.equal(out, null);
});

// ---- createWorkspaceEmitter ----

type SseEvent = { event: string; data: unknown };

function captureSends(): { events: SseEvent[]; send: (e: string, d: unknown) => void } {
  const events: SseEvent[] = [];
  const send = (event: string, data: unknown) => {
    events.push({ event, data });
  };
  return { events, send };
}

test("emitter.snapshot: emits workspace_snapshot even when empty", async () => {
  const { prismaLike } = makeStubPrisma();
  const { events, send } = captureSends();
  const emitter = createWorkspaceEmitter({ prismaLike }, "s-1", send);
  await emitter.snapshot();
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "workspace_snapshot");
  const payload = events[0].data as { widgets: unknown[]; skipped: number };
  assert.deepEqual(payload.widgets, []);
  assert.equal(payload.skipped, 0);
});

test("emitter.snapshot: ships the current widget list with skipped count", async () => {
  const { prismaLike, state } = makeStubPrisma();
  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "x",
      kind: "campaign_list",
      slot: "primary",
      props: validCampaignListProps,
    },
  );
  // Add one corrupt row directly so skipped>0 on read.
  state.rows.push({
    id: "w-junk",
    sessionId: "s-1",
    widgetKey: "broken",
    kind: "campaign_list",
    slot: "primary",
    props: "{not json",
    order: 1,
    sourceMessageId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const { events, send } = captureSends();
  const emitter = createWorkspaceEmitter({ prismaLike }, "s-1", send);
  await emitter.snapshot();
  const payload = events[0].data as {
    widgets: Array<{ widgetKey: string }>;
    skipped: number;
  };
  assert.equal(payload.widgets.length, 1);
  assert.equal(payload.widgets[0].widgetKey, "x");
  assert.equal(payload.skipped, 1);
});

test("emitter.upsert: emits widget_upsert then widget_focus on successful write (W4)", async () => {
  // W4 couples upsert with focus: every successful write is
  // immediately followed by a `widget_focus` frame so the client can
  // scroll the refreshed widget into view. Order matters — the
  // client applies upsert first (so the target exists in state)
  // before the focus handler dispatches scroll/highlight.
  const { prismaLike } = makeStubPrisma();
  const { events, send } = captureSends();
  const emitter = createWorkspaceEmitter({ prismaLike }, "s-1", send);
  const widget = await emitter.upsert({
    widgetKey: "x",
    kind: "campaign_list",
    slot: "primary",
    props: validCampaignListProps,
  });
  assert.ok(widget);
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "widget_upsert");
  const upsertPayload = events[0].data as { widgetKey: string; kind: string };
  assert.equal(upsertPayload.widgetKey, "x");
  assert.equal(upsertPayload.kind, "campaign_list");
  assert.equal(events[1].event, "widget_focus");
  assert.deepEqual(events[1].data, { widgetKey: "x" });
});

test("emitter.upsert: does NOT emit either frame on validation failure", async () => {
  const { prismaLike } = makeStubPrisma();
  const { events, send } = captureSends();
  const emitter = createWorkspaceEmitter({ prismaLike }, "s-1", send);
  const result = await emitter.upsert({
    widgetKey: "x",
    kind: "unknown_kind",
    slot: "primary",
    props: {},
  });
  assert.equal(result, null);
  // No upsert frame, no focus frame — the client never hears about
  // a write that didn't happen.
  assert.equal(events.length, 0);
});

test("emitter.upsert: re-upserting the same widgetKey re-fires focus each time (W4)", async () => {
  // The client uses the stream of `widget_focus` frames as the
  // authoritative "operator just touched this widget" signal. If the
  // same key is upserted twice, the dashboard should pull attention
  // to it BOTH times — not just the first.
  const { prismaLike } = makeStubPrisma();
  const { events, send } = captureSends();
  const emitter = createWorkspaceEmitter({ prismaLike }, "s-1", send);
  await emitter.upsert({
    widgetKey: "stable",
    kind: "campaign_list",
    slot: "primary",
    props: validCampaignListProps,
  });
  await emitter.upsert({
    widgetKey: "stable",
    kind: "campaign_list",
    slot: "primary",
    props: validCampaignListProps,
  });
  // 2 upserts × (upsert + focus) = 4 frames, in strict order.
  assert.equal(events.length, 4);
  assert.equal(events[0].event, "widget_upsert");
  assert.equal(events[1].event, "widget_focus");
  assert.equal(events[2].event, "widget_upsert");
  assert.equal(events[3].event, "widget_focus");
});

test("emitter.remove: emits widget_remove only when a row went away", async () => {
  const { prismaLike } = makeStubPrisma();
  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "x",
      kind: "campaign_list",
      slot: "primary",
      props: validCampaignListProps,
    },
  );
  const { events, send } = captureSends();
  const emitter = createWorkspaceEmitter({ prismaLike }, "s-1", send);

  // First remove hits a row -> emit.
  const first = await emitter.remove("x");
  assert.equal(first.removed, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "widget_remove");
  assert.deepEqual(events[0].data, { widgetKey: "x" });

  // Second remove is a no-op -> NO emit. Keeps the stream honest
  // under retries.
  const second = await emitter.remove("x");
  assert.equal(second.removed, false);
  assert.equal(events.length, 1);
});

test("emitter.focus: emits widget_focus only when target exists", async () => {
  const { prismaLike } = makeStubPrisma();
  await upsertWidget(
    { prismaLike },
    {
      sessionId: "s-1",
      widgetKey: "x",
      kind: "campaign_list",
      slot: "primary",
      props: validCampaignListProps,
    },
  );
  const { events, send } = captureSends();
  const emitter = createWorkspaceEmitter({ prismaLike }, "s-1", send);

  // Hit on existing -> emit by key only (not full widget payload).
  const hit = await emitter.focus("x");
  assert.ok(hit);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "widget_focus");
  assert.deepEqual(events[0].data, { widgetKey: "x" });

  // Miss on ghost -> no emit.
  const miss = await emitter.focus("ghost");
  assert.equal(miss, null);
  assert.equal(events.length, 1);
});
