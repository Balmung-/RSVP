import { test } from "node:test";
import assert from "node:assert/strict";

import {
  focusWidget,
  listWidgets,
  upsertWidget,
  type PrismaLike,
  type WidgetRow,
} from "../../src/lib/ai/widgets";
import {
  CAMPAIGNS_LIST_WIDGET_KEY,
  campaignDetailWidgetKey,
  confirmSendWidgetKey,
} from "../../src/lib/ai/widgetKeys";

// W6 — server-side pipeline integration test: tool result ->
// upsertWidget -> stored row -> listWidgets (hydrate read) ->
// validated workspace snapshot. This is the residual W3/W4 carry-
// forward GPT asked W6 to close before hardening wraps up.
//
// What this pins that the per-layer tests don't:
//
// 1. The WRITE side (`upsertWidget`) and READ side (`listWidgets`)
//    agree on the same DB row shape — props JSON-stringify on write,
//    JSON.parse + validateWidgetProps on read, no drift. Layer tests
//    cover each call in isolation; this one round-trips.
//
// 2. Stable-keying is observable end-to-end: a second call to the
//    same tool with different props updates the SAME row (same
//    `(sessionId, widgetKey)` identity), and listWidgets reads back
//    the updated props, not the original. That's the W4 "living
//    dashboard" contract.
//
// 3. Cross-module widgetKey contract: the confirm route's outcome
//    writer uses `confirmSendWidgetKey(id)` to find the exact row
//    propose_send wrote under the same helper. Round-trip here
//    verifies the writer and the reader land on the same row, not
//    just on bytewise-equal strings.
//
// 4. Read-side trust boundary: a manually-drifted row (kind mismatch
//    or malformed props) seeded directly into the in-memory store
//    is skipped by listWidgets rather than leaking to the renderer.
//    This pins the fail-closed-on-read behaviour the widget module
//    promises.
//
// Not in scope (deferred): jsdom client harness, live SSE-replay at
// the route level, `prefers-reduced-motion`. Those are a separate
// push.

// ---- in-memory PrismaLike stub ----
//
// Minimal copy of the harness in widget-helpers.test.ts — a standalone
// stub keeps this test self-contained and lets it drift independently
// from the per-layer fixtures. Models the `(sessionId, widgetKey)`
// composite-unique constraint exactly, so upsert-on-existing updates
// in place the same way Prisma does.

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

// Shape-valid props for each kind, matching validateCampaignList /
// validateCampaignCard / validateConfirmSend. The tool handlers
// ultimately return these shapes; we don't invoke the full handler
// because `list_campaigns.ts` and friends import the real prisma
// singleton — for a pipeline-shape test, the tool's envelope is
// what the route's wrapper actually reads.
const validCampaignListProps = {
  items: [
    {
      id: "camp_1",
      name: "Spring Gala",
      status: "draft",
      event_at: null,
      venue: null,
      team_id: null,
      stats: { total: 0, responded: 0, headcount: 0 },
    },
  ],
  filters: { status: ["draft"], upcoming_only: false, limit: 50 },
};
const validCampaignDetailProps = {
  id: "camp_1",
  name: "Spring Gala",
  description: null,
  status: "draft",
  event_at: null,
  venue: null,
  locale: "en",
  team_id: null,
  created_at: "2026-04-19T00:00:00.000Z",
  updated_at: "2026-04-19T00:00:00.000Z",
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

// ---- pipeline: static-keyed tool -> upsert -> hydrate ----

test("pipeline: list_campaigns emits -> persisted -> hydrate recovers with validated props", async () => {
  const { prismaLike, state } = makeStubPrisma();
  const sessionId = "s-1";

  // Simulate the `list_campaigns` tool's return shape — the route
  // wrapper at /api/chat/route.ts:566 calls workspace.upsert with
  // exactly these four fields pulled off `result.result.widget`.
  const emitted = {
    widgetKey: CAMPAIGNS_LIST_WIDGET_KEY,
    kind: "campaign_list" as const,
    slot: "primary" as const,
    props: validCampaignListProps,
  };

  const written = await upsertWidget(
    { prismaLike },
    { sessionId, ...emitted, sourceMessageId: "msg-1" },
  );
  assert.ok(written, "upsertWidget must accept a handler's valid envelope");
  assert.equal(written!.widgetKey, CAMPAIGNS_LIST_WIDGET_KEY);
  assert.equal(written!.kind, "campaign_list");
  assert.equal(state.rows.length, 1, "exactly one row in the DB");
  // Props serialized to JSON on the row...
  assert.equal(typeof state.rows[0]!.props, "string");
  // ...but the returned Widget has them re-parsed.
  assert.deepEqual(written!.props, validCampaignListProps);

  // Hydrate path: same function the /api/chat/session/[id] handler
  // calls on reload. Validated row comes back in the snapshot.
  const snap = await listWidgets({ prismaLike }, sessionId);
  assert.equal(snap.widgets.length, 1);
  assert.equal(snap.skipped, 0);
  assert.equal(snap.widgets[0]!.widgetKey, CAMPAIGNS_LIST_WIDGET_KEY);
  assert.deepEqual(snap.widgets[0]!.props, validCampaignListProps);
});

test("pipeline: re-invoking the same static-keyed tool UPDATES in place (W4 contract)", async () => {
  const { prismaLike, state } = makeStubPrisma();
  const sessionId = "s-1";

  // First pass: empty-filter list.
  await upsertWidget(
    { prismaLike },
    {
      sessionId,
      widgetKey: CAMPAIGNS_LIST_WIDGET_KEY,
      kind: "campaign_list",
      slot: "primary",
      props: validCampaignListProps,
    },
  );
  assert.equal(state.rows.length, 1);

  // Second pass with a different filter selection — same tool,
  // same widgetKey (static), different props. This is the exact
  // shape "refine the filter" would emit at runtime.
  const refinedProps = {
    ...validCampaignListProps,
    filters: { status: ["active"], upcoming_only: true, limit: 25 },
  };
  await upsertWidget(
    { prismaLike },
    {
      sessionId,
      widgetKey: CAMPAIGNS_LIST_WIDGET_KEY,
      kind: "campaign_list",
      slot: "primary",
      props: refinedProps,
    },
  );

  // Pipeline invariant: same key + same session = one row. The W4
  // "living dashboard" contract breaks if this grows to 2.
  assert.equal(state.rows.length, 1, "must update in place, not append");
  const snap = await listWidgets({ prismaLike }, sessionId);
  assert.equal(snap.widgets.length, 1);
  assert.deepEqual(
    (snap.widgets[0]!.props as { filters: unknown }).filters,
    { status: ["active"], upcoming_only: true, limit: 25 },
    "hydrate must return the REFRESHED props, not the original",
  );
});

// ---- pipeline: entity-keyed tool honours singleton-per-slot ----

test("pipeline: campaign_detail for distinct ids evicts the prior card (primary is singleton-per-slot)", async () => {
  const { prismaLike, state } = makeStubPrisma();
  const sessionId = "s-1";

  // Two different campaigns under the campaign_detail tool. The
  // widgetKey formula is `campaign.<id>`, so each call produces a
  // distinct key. Pre-P8 both cards persisted (one row per id).
  //
  // P8 shifts the invariant: campaign_card lives in the `primary`
  // slot, which is `singleton-per-slot`. Opening campaign B after
  // campaign A EVICTS the A card — the "hero" view is a single-
  // subject surface, not a growing stack. Re-opening A later simply
  // evicts B and the operator is back to A.
  //
  // This test pins the new behaviour end-to-end: the key formula
  // still produces distinct strings per id (widget-keys.test.ts
  // proves that at unit level) AND the pipeline genuinely swaps
  // rather than accumulates.
  for (const id of ["camp_A", "camp_B"]) {
    await upsertWidget(
      { prismaLike },
      {
        sessionId,
        widgetKey: campaignDetailWidgetKey(id),
        kind: "campaign_card",
        slot: "primary",
        props: { ...validCampaignDetailProps, id, name: `Event ${id}` },
      },
    );
  }

  // Only the latest campaign card survives.
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0]!.widgetKey, "campaign.camp_B");
  const snap = await listWidgets({ prismaLike }, sessionId);
  assert.equal(snap.widgets.length, 1);
  assert.equal(snap.widgets[0]!.widgetKey, "campaign.camp_B");
});

// ---- pipeline: cross-module widgetKey contract ----

test("pipeline: confirm_send writer and confirm-route reader land on the SAME row", async () => {
  // This is the invariant W5's outcome marker relies on. propose_send
  // writes under `confirmSendWidgetKey(id)`; the confirm route
  // (mark_confirm_send_outcome) looks up the row to stamp using the
  // same helper. Using the SAME helper from both sides is what this
  // test pins — if the route ever inlined a local literal, the
  // writer's row would still exist but the reader would miss it and
  // W5's persisted-state contract would silently regress.
  const { prismaLike } = makeStubPrisma();
  const sessionId = "s-1";
  const campaignId = "camp_cross";
  const validConfirmSendProps = {
    campaign_id: campaignId,
    name: "Fundraiser",
    status: "draft",
    venue: null,
    event_at: null,
    locale: "en",
    channel: "email" as const,
    only_unsent: true,
    invitee_total: 10,
    ready_messages: 10,
    by_channel: {
      email: {
        ready: 10,
        skipped_already_sent: 0,
        skipped_unsubscribed: 0,
        no_contact: 0,
      },
      sms: {
        ready: 0,
        skipped_already_sent: 0,
        skipped_unsubscribed: 0,
        no_contact: 0,
      },
    },
    template_preview: {
      subject_email: "Hi",
      email_body: "Body",
      sms_body: null,
    },
    blockers: [],
    state: "ready" as const,
  };

  // WRITER (propose_send emitting the confirm_send widget envelope):
  await upsertWidget(
    { prismaLike },
    {
      sessionId,
      widgetKey: confirmSendWidgetKey(campaignId),
      kind: "confirm_send",
      slot: "action",
      props: validConfirmSendProps,
    },
  );

  // READER (the /api/chat/confirm/[messageId] outcome writer uses
  // focusWidget with the same helper to locate the row before a
  // read-merge-upsert). If the two sides ever diverge on the key
  // formula, this lookup returns null and the outcome stamp silently
  // drops.
  const found = await focusWidget(
    { prismaLike },
    sessionId,
    confirmSendWidgetKey(campaignId),
  );
  assert.ok(found, "writer and reader must converge on the same row");
  assert.equal(found!.widgetKey, `confirm.send.${campaignId}`);
  assert.equal(found!.kind, "confirm_send");
  // Round-trip: props land back as the re-parsed shape, ready for
  // the outcome merge to spread onto.
  assert.deepEqual(
    (found!.props as { state: string }).state,
    "ready",
  );
});

// ---- read-side trust boundary: drifted rows never reach the renderer

test("pipeline: listWidgets skips a row whose persisted props are shape-invalid", async () => {
  // Plant a row DIRECTLY into the stub's storage that would NEVER have
  // passed validateWidget on write — the kind says campaign_list but
  // the props are missing `items`. Simulates a pre-Push-11 historic
  // row, a schema-drift migration, or a manual DB tamper. The read
  // path's rowToWidget + validateWidgetProps must drop it.
  const { prismaLike, state } = makeStubPrisma();
  const sessionId = "s-1";

  // First, plant a VALID row through the normal upsert so we know
  // there IS something to find in the happy snapshot.
  await upsertWidget(
    { prismaLike },
    {
      sessionId,
      widgetKey: CAMPAIGNS_LIST_WIDGET_KEY,
      kind: "campaign_list",
      slot: "primary",
      props: validCampaignListProps,
    },
  );

  // Plant the drifted row bypassing the validator.
  const drifted: WidgetRow = {
    id: "w-drifted",
    sessionId,
    widgetKey: "drifted.list",
    kind: "campaign_list",
    slot: "primary",
    // Props JSON parses fine but the per-kind validator rejects it.
    props: JSON.stringify({ not_items: "oops" }),
    order: 0,
    sourceMessageId: null,
    createdAt: new Date(state.nowMs),
    updatedAt: new Date(state.nowMs),
  };
  state.rows.push(drifted);

  const snap = await listWidgets({ prismaLike }, sessionId);
  // The drifted row is SKIPPED, not returned.
  assert.equal(snap.widgets.length, 1);
  assert.equal(snap.widgets[0]!.widgetKey, CAMPAIGNS_LIST_WIDGET_KEY);
  assert.equal(snap.skipped, 1, "read path must count the drift-skip");
});
