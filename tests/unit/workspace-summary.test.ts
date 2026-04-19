import { test } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";

import {
  validateWidget,
  validateWidgetProps,
} from "../../src/lib/ai/widget-validate";
import {
  computeWorkspaceRollup,
  refreshWorkspaceSummary,
  type WorkspaceSummaryPrismaLike,
} from "../../src/lib/ai/workspace-summary";
import { WORKSPACE_SUMMARY_WIDGET_KEY } from "../../src/lib/ai/widgetKeys";
import type { WidgetRow } from "../../src/lib/ai/widgets";

// W7 sub-slice 2 — the server-owned workspace rollup.
//
// Two trust boundaries and one integration pin live in this file:
//
//   (a) VALIDATOR gate: `validateWidgetProps("workspace_rollup", p)`
//       must accept the exact shape `computeWorkspaceRollup`
//       produces, and reject every malformed variant that could
//       surface from a drifted DB row or a future refactor.
//
//   (b) COMPUTE correctness: scope-aware counters. The
//       `campaignScope` fragment (possibly `{OR: [...]}` for a
//       non-admin) must flow through to every underlying count
//       without getting clobbered — the Push 2 scope-leak pattern is
//       the specific regression this covers.
//
//   (c) REFRESH integration: compute + upsertWidget together write a
//       row under the stable `workspace.summary` key, and a second
//       refresh UPSERTS in place (not append) so the summary slot
//       never grows a duplicate card across mutations.

// ---- capture-style prisma stub ----
//
// Records the `where` argument every count / groupBy receives so the
// scope-composition tests can assert the exact fragment was passed
// through. Each call returns a predetermined value from a script the
// test sets up — this is more readable than a full in-memory counter
// model, and it pins WHAT the caller asked for (the thing the test
// is actually about).

type CountCall = { table: string; where: unknown };

type RollupStub = {
  prismaLike: WorkspaceSummaryPrismaLike;
  state: {
    rows: WidgetRow[];
    nowMs: number;
    calls: CountCall[];
    campaignCount: number;
    statusGroups: Array<{ status: string; _count: { _all: number } }>;
    inviteeCount: number;
    responseTotal: number;
    attending: number;
    declined: number;
    recent24h: number;
    sent24h: number;
  };
};

function makeRollupStub(overrides?: Partial<RollupStub["state"]>): RollupStub {
  const state: RollupStub["state"] = {
    rows: [],
    nowMs: 1_700_000_000_000,
    calls: [],
    campaignCount: 0,
    statusGroups: [],
    inviteeCount: 0,
    responseTotal: 0,
    attending: 0,
    declined: 0,
    recent24h: 0,
    sent24h: 0,
    ...overrides,
  };
  const tick = () => new Date((state.nowMs += 1));

  const prismaLike: WorkspaceSummaryPrismaLike = {
    chatWidget: {
      async findMany(args) {
        return state.rows.filter(
          (r) => r.sessionId === args.where.sessionId,
        );
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
        const existing = state.rows[idx]!;
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
      async deleteMany() {
        return { count: 0 };
      },
      async findUnique(args) {
        const { sessionId, widgetKey } = args.where.sessionId_widgetKey;
        return (
          state.rows.find(
            (r) => r.sessionId === sessionId && r.widgetKey === widgetKey,
          ) ?? null
        );
      },
    },
    campaign: {
      async count(args) {
        state.calls.push({ table: "campaign.count", where: args.where });
        return state.campaignCount;
      },
      async groupBy(args) {
        state.calls.push({ table: "campaign.groupBy", where: args.where });
        return state.statusGroups;
      },
    },
    invitee: {
      async count(args) {
        state.calls.push({ table: "invitee.count", where: args.where });
        return state.inviteeCount;
      },
    },
    response: {
      async count(args) {
        state.calls.push({ table: "response.count", where: args.where });
        const w = args.where as Record<string, unknown>;
        if (w.attending === true) return state.attending;
        if (w.attending === false) return state.declined;
        if (w.respondedAt) return state.recent24h;
        return state.responseTotal;
      },
    },
    invitation: {
      async count(args) {
        state.calls.push({ table: "invitation.count", where: args.where });
        return state.sent24h;
      },
    },
  };

  return { prismaLike, state };
}

// ---- (a) validator ----

const validRollupProps = {
  campaigns: { draft: 2, active: 1, closed: 3, archived: 0, total: 6 },
  invitees: { total: 150 },
  responses: { total: 90, attending: 60, declined: 30, recent_24h: 10 },
  invitations: { sent_24h: 45 },
  generated_at: "2026-04-19T12:00:00.000Z",
};

test("validator: accepts the exact shape computeWorkspaceRollup produces", () => {
  assert.equal(
    validateWidgetProps("workspace_rollup", validRollupProps),
    true,
  );
});

test("validator: accepts through validateWidget envelope", () => {
  const result = validateWidget({
    widgetKey: WORKSPACE_SUMMARY_WIDGET_KEY,
    kind: "workspace_rollup",
    slot: "summary",
    props: validRollupProps,
  });
  assert.ok(result, "rollup envelope must round-trip through validateWidget");
  assert.equal(result!.kind, "workspace_rollup");
  assert.equal(result!.slot, "summary");
});

test("validator: rejects missing or non-integer campaign counter", () => {
  const missing = { ...validRollupProps, campaigns: { ...validRollupProps.campaigns } };
  delete (missing.campaigns as Record<string, unknown>).draft;
  assert.equal(validateWidgetProps("workspace_rollup", missing), false);

  const float = {
    ...validRollupProps,
    campaigns: { ...validRollupProps.campaigns, active: 1.5 },
  };
  assert.equal(validateWidgetProps("workspace_rollup", float), false);

  const nan = {
    ...validRollupProps,
    campaigns: { ...validRollupProps.campaigns, closed: Number.NaN },
  };
  assert.equal(validateWidgetProps("workspace_rollup", nan), false);
});

test("validator: rejects missing nested sections", () => {
  const noInvitees = { ...validRollupProps };
  delete (noInvitees as Record<string, unknown>).invitees;
  assert.equal(validateWidgetProps("workspace_rollup", noInvitees), false);

  const noResponses = { ...validRollupProps };
  delete (noResponses as Record<string, unknown>).responses;
  assert.equal(validateWidgetProps("workspace_rollup", noResponses), false);

  const noInvitations = { ...validRollupProps };
  delete (noInvitations as Record<string, unknown>).invitations;
  assert.equal(validateWidgetProps("workspace_rollup", noInvitations), false);
});

test("validator: rejects missing / non-string generated_at", () => {
  const missing = { ...validRollupProps };
  delete (missing as Record<string, unknown>).generated_at;
  assert.equal(validateWidgetProps("workspace_rollup", missing), false);

  const empty = { ...validRollupProps, generated_at: "" };
  assert.equal(validateWidgetProps("workspace_rollup", empty), false);

  const numeric = { ...validRollupProps, generated_at: 1_700_000_000 };
  assert.equal(validateWidgetProps("workspace_rollup", numeric), false);
});

// ---- (b) compute correctness ----

test("compute: returns every counter in the expected shape", async () => {
  const { prismaLike } = makeRollupStub({
    campaignCount: 4,
    statusGroups: [
      { status: "draft", _count: { _all: 1 } },
      { status: "active", _count: { _all: 2 } },
      { status: "closed", _count: { _all: 1 } },
    ],
    inviteeCount: 20,
    responseTotal: 12,
    attending: 8,
    declined: 4,
    recent24h: 3,
    sent24h: 7,
  });
  const now = new Date("2026-04-19T12:00:00.000Z");
  const props = await computeWorkspaceRollup(prismaLike, {}, now);

  assert.deepEqual(props.campaigns, {
    draft: 1,
    active: 2,
    closed: 1,
    archived: 0,
    total: 4,
  });
  assert.equal(props.invitees.total, 20);
  assert.deepEqual(props.responses, {
    total: 12,
    attending: 8,
    declined: 4,
    recent_24h: 3,
  });
  assert.equal(props.invitations.sent_24h, 7);
  assert.equal(props.generated_at, "2026-04-19T12:00:00.000Z");
  // Own validator accepts what we just produced — pins the drift
  // defence at its tightest.
  assert.equal(validateWidgetProps("workspace_rollup", props), true);
});

test("compute: unknown groupBy status strings don't blow up the per-status buckets", async () => {
  const { prismaLike } = makeRollupStub({
    campaignCount: 3,
    statusGroups: [
      { status: "draft", _count: { _all: 1 } },
      { status: "sending", _count: { _all: 1 } }, // not in the schema — ignored
      { status: "active", _count: { _all: 1 } },
    ],
  });
  const props = await computeWorkspaceRollup(prismaLike, {});
  // Unknown status contributes to `total` (via the separate count),
  // but NOT to any per-status bucket.
  assert.equal(props.campaigns.draft, 1);
  assert.equal(props.campaigns.active, 1);
  assert.equal(props.campaigns.closed, 0);
  assert.equal(props.campaigns.archived, 0);
  assert.equal(props.campaigns.total, 3);
});

test("compute: passes campaignScope through unchanged at every call site", async () => {
  const { prismaLike, state } = makeRollupStub();
  // Non-admin scope: the OR shape scopedCampaignWhere returns for an
  // editor on one team. This is exactly the fragment that gets
  // clobbered by `{...campaignScope, OR: [...]}` spread bugs.
  const campaignScope: Prisma.CampaignWhereInput = {
    OR: [{ teamId: null }, { teamId: { in: ["team-a"] } }],
  };

  await computeWorkspaceRollup(prismaLike, campaignScope);

  // Campaign-level counters: scope lands as the `where` directly
  // (campaign queries are native-kind).
  const campaignCount = state.calls.find(
    (c) => c.table === "campaign.count",
  );
  assert.ok(campaignCount, "campaign.count was called");
  assert.deepEqual(campaignCount!.where, campaignScope);

  const groupBy = state.calls.find((c) => c.table === "campaign.groupBy");
  assert.ok(groupBy, "campaign.groupBy was called");
  assert.deepEqual(groupBy!.where, campaignScope);

  // Relation-level counters (invitee / response / invitation):
  // scope must be nested under the `campaign` relation filter so
  // the response/invitation/invitee WHERE's top level doesn't
  // collide with any OR the scope carries.
  const inviteeCount = state.calls.find(
    (c) => c.table === "invitee.count",
  );
  assert.ok(inviteeCount);
  assert.deepEqual(inviteeCount!.where, { campaign: campaignScope });

  // Three response.count calls: total / attending / declined / recent
  // — check that `campaign: campaignScope` is present on every one.
  const responseCalls = state.calls.filter(
    (c) => c.table === "response.count",
  );
  assert.ok(responseCalls.length >= 3, "expected 4 response.count calls");
  for (const r of responseCalls) {
    const w = r.where as Record<string, unknown>;
    assert.deepEqual(
      w.campaign,
      campaignScope,
      "scope fragment preserved on response.count",
    );
  }

  const invitationCount = state.calls.find(
    (c) => c.table === "invitation.count",
  );
  assert.ok(invitationCount);
  const invWhere = invitationCount!.where as Record<string, unknown>;
  assert.deepEqual(invWhere.campaign, campaignScope);
});

test("compute: invitation count filters to successful deliveries in 24h", async () => {
  const { prismaLike, state } = makeRollupStub();
  const now = new Date("2026-04-19T12:00:00.000Z");
  await computeWorkspaceRollup(prismaLike, {}, now);

  const invitationCount = state.calls.find(
    (c) => c.table === "invitation.count",
  );
  const w = invitationCount!.where as Record<string, unknown>;
  // Status filter excludes failed / bounced / queued.
  assert.deepEqual(w.status, { in: ["sent", "delivered"] });
  // sentAt cutoff is exactly 24h before `now`.
  const sentAt = w.sentAt as Record<string, Date>;
  const expectedCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  assert.equal(sentAt.gte.getTime(), expectedCutoff.getTime());
});

test("compute: recent_24h response cutoff is relative to `now`", async () => {
  const { prismaLike, state } = makeRollupStub();
  const now = new Date("2026-04-19T12:00:00.000Z");
  await computeWorkspaceRollup(prismaLike, {}, now);

  const recentCall = state.calls.find((c) => {
    if (c.table !== "response.count") return false;
    const w = c.where as Record<string, unknown>;
    return w.respondedAt !== undefined;
  });
  assert.ok(recentCall, "response.count called with respondedAt filter");
  const w = recentCall!.where as Record<string, unknown>;
  const r = w.respondedAt as Record<string, Date>;
  assert.equal(
    r.gte.getTime(),
    new Date(now.getTime() - 24 * 60 * 60 * 1000).getTime(),
  );
});

// ---- (c) refresh integration ----

test("refresh: happy path writes a row under workspace.summary", async () => {
  const { prismaLike, state } = makeRollupStub({
    campaignCount: 2,
    statusGroups: [{ status: "draft", _count: { _all: 2 } }],
    inviteeCount: 5,
  });
  const widget = await refreshWorkspaceSummary(
    { prismaLike },
    { sessionId: "s-1", campaignScope: {} },
  );
  assert.ok(widget, "refresh should return the persisted widget");
  assert.equal(widget!.widgetKey, WORKSPACE_SUMMARY_WIDGET_KEY);
  assert.equal(widget!.kind, "workspace_rollup");
  assert.equal(widget!.slot, "summary");
  assert.equal(widget!.order, 0);
  assert.equal(widget!.sourceMessageId, null);

  // Row shape sanity: props are JSON-stringified on the row, but the
  // returned Widget re-parsed them.
  assert.equal(state.rows.length, 1);
  assert.equal(typeof state.rows[0]!.props, "string");
  const parsed = JSON.parse(state.rows[0]!.props);
  assert.equal(parsed.campaigns.total, 2);
  assert.equal(parsed.invitees.total, 5);
});

test("refresh: a second call UPSERTS in place (no duplicate summary row)", async () => {
  const stub = makeRollupStub({ campaignCount: 1 });
  await refreshWorkspaceSummary(
    { prismaLike: stub.prismaLike },
    { sessionId: "s-1", campaignScope: {} },
  );
  assert.equal(stub.state.rows.length, 1, "first refresh writes one row");

  // Simulate a mutation: bump the counters and refresh again.
  stub.state.campaignCount = 2;
  stub.state.statusGroups = [{ status: "active", _count: { _all: 2 } }];
  await refreshWorkspaceSummary(
    { prismaLike: stub.prismaLike },
    { sessionId: "s-1", campaignScope: {} },
  );
  assert.equal(
    stub.state.rows.length,
    1,
    "second refresh updates in place, does not append",
  );
  const parsed = JSON.parse(stub.state.rows[0]!.props);
  assert.equal(parsed.campaigns.total, 2);
  assert.equal(parsed.campaigns.active, 2);
});

test("refresh: separate sessions each get their own summary row", async () => {
  // Sanity pin on the composite (sessionId, widgetKey) identity —
  // two chat sessions running side-by-side must not share a rollup.
  const stub = makeRollupStub({ campaignCount: 3 });
  await refreshWorkspaceSummary(
    { prismaLike: stub.prismaLike },
    { sessionId: "s-1", campaignScope: {} },
  );
  await refreshWorkspaceSummary(
    { prismaLike: stub.prismaLike },
    { sessionId: "s-2", campaignScope: {} },
  );
  assert.equal(stub.state.rows.length, 2);
  assert.ok(stub.state.rows.every((r) => r.widgetKey === WORKSPACE_SUMMARY_WIDGET_KEY));
  const sessionIds = stub.state.rows.map((r) => r.sessionId).sort();
  assert.deepEqual(sessionIds, ["s-1", "s-2"]);
});
