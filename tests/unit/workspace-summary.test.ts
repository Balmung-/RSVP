import { test } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";

import {
  validateWidget,
  validateWidgetProps,
} from "../../src/lib/ai/widget-validate";
import {
  CHAT_TOOLS_REFRESHING_SUMMARY,
  computeWorkspaceRollup,
  refreshWorkspaceSummary,
  tryRefreshSummaryForChatTool,
  tryRefreshSummaryForConfirm,
  tryRefreshSummaryForSnapshot,
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
    // P13-E — `sent24h` is the channel-agnostic aggregate; the three
    // per-channel counters drive the new per-channel Invitation queries.
    // Keeping them all on state (rather than deriving sent24h from the
    // three) means each compute test pins exactly the count it set.
    sent24h: number;
    sentEmail24h: number;
    sentSms24h: number;
    sentWhatsApp24h: number;
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
    sentEmail24h: 0,
    sentSms24h: 0,
    sentWhatsApp24h: 0,
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
        // P13-E — four queries hit this stub per compute call:
        // one aggregate (no `channel` filter) and one each for
        // email / sms / whatsapp. Branch on the `channel` field so the
        // stub returns the per-channel count the test set up; the
        // aggregate path falls through to `sent24h` unchanged so the
        // pre-P13-E compute-correctness tests remain honest.
        const w = args.where as Record<string, unknown>;
        if (w.channel === "email") return state.sentEmail24h;
        if (w.channel === "sms") return state.sentSms24h;
        if (w.channel === "whatsapp") return state.sentWhatsApp24h;
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
  // P13-E — per-channel split joined the rollup. The aggregate
  // `sent_24h` stays as the channel-agnostic "anything went out today"
  // read; the three per-channel counts sum to the aggregate in this
  // fixture but the compute function runs them as independent queries
  // so the validator doesn't enforce equality.
  invitations: {
    sent_24h: 45,
    sent_email_24h: 30,
    sent_sms_24h: 12,
    sent_whatsapp_24h: 3,
  },
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

test("validator: rejects missing per-channel invitation counter (P13-E)", () => {
  // Pre-P13-E rollup blobs carried only `sent_24h`. Now that the
  // compute function emits three per-channel fields on every refresh,
  // the validator rejects any blob that lacks one — silent zero-fill
  // would make the renderer's `0w` cell indistinguishable from "field
  // missing, pretending to be zero", exactly the drift bug `campaign_card`
  // gained the same gate for in D.3.
  const missingEmail = {
    ...validRollupProps,
    invitations: { ...validRollupProps.invitations },
  };
  delete (missingEmail.invitations as Record<string, unknown>).sent_email_24h;
  assert.equal(validateWidgetProps("workspace_rollup", missingEmail), false);

  const missingSms = {
    ...validRollupProps,
    invitations: { ...validRollupProps.invitations },
  };
  delete (missingSms.invitations as Record<string, unknown>).sent_sms_24h;
  assert.equal(validateWidgetProps("workspace_rollup", missingSms), false);

  const missingWhatsApp = {
    ...validRollupProps,
    invitations: { ...validRollupProps.invitations },
  };
  delete (missingWhatsApp.invitations as Record<string, unknown>)
    .sent_whatsapp_24h;
  assert.equal(
    validateWidgetProps("workspace_rollup", missingWhatsApp),
    false,
  );

  // A float or NaN on the new per-channel counters is also rejected,
  // matching the existing per-campaign-counter behaviour.
  const floatWhatsApp = {
    ...validRollupProps,
    invitations: { ...validRollupProps.invitations, sent_whatsapp_24h: 1.5 },
  };
  assert.equal(validateWidgetProps("workspace_rollup", floatWhatsApp), false);
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
    // P13-E — independent per-channel counts. The stub branches on
    // the `channel` filter so each query returns exactly what the
    // test set up here rather than always returning `sent24h`.
    sentEmail24h: 4,
    sentSms24h: 2,
    sentWhatsApp24h: 1,
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
  // Aggregate + per-channel split all flow through.
  assert.equal(props.invitations.sent_24h, 7);
  assert.equal(props.invitations.sent_email_24h, 4);
  assert.equal(props.invitations.sent_sms_24h, 2);
  assert.equal(props.invitations.sent_whatsapp_24h, 1);
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

  // P13-E — four invitation.count calls now: one aggregate + one each
  // for email / sms / whatsapp. Every one must pass the scope fragment
  // through intact — the Push 2 scope-leak pattern regressing on a
  // new-channel filter would silently mis-scope WhatsApp numbers.
  const invitationCalls = state.calls.filter(
    (c) => c.table === "invitation.count",
  );
  assert.equal(
    invitationCalls.length,
    4,
    "expected 4 invitation.count calls (aggregate + 3 channels)",
  );
  for (const inv of invitationCalls) {
    const w = inv.where as Record<string, unknown>;
    assert.deepEqual(
      w.campaign,
      campaignScope,
      "scope fragment preserved on invitation.count",
    );
  }
});

test("compute: invitation count filters to successful deliveries in 24h", async () => {
  const { prismaLike, state } = makeRollupStub();
  const now = new Date("2026-04-19T12:00:00.000Z");
  await computeWorkspaceRollup(prismaLike, {}, now);

  // P13-E — the status + sentAt filter must be carried on EVERY
  // invitation.count call (aggregate + 3 per-channel), not just the
  // aggregate. A channel-filtered query that omitted the status gate
  // would count failed / bounced rows and inflate the per-channel
  // breakdown past the aggregate, which is exactly the kind of
  // silent-drift bug the pin here is supposed to catch.
  const invitationCalls = state.calls.filter(
    (c) => c.table === "invitation.count",
  );
  assert.equal(invitationCalls.length, 4);
  const expectedCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  for (const inv of invitationCalls) {
    const w = inv.where as Record<string, unknown>;
    assert.deepEqual(w.status, { in: ["sent", "delivered"] });
    const sentAt = w.sentAt as Record<string, Date>;
    assert.equal(sentAt.gte.getTime(), expectedCutoff.getTime());
  }
});

test("compute: per-channel invitation counts filter on the correct channel string (P13-E)", async () => {
  // Each per-channel query must set `channel: "email"` / "sms" /
  // "whatsapp" explicitly. Missing the channel filter would return
  // the aggregate count under every per-channel key — the bucket
  // numbers would match but the breakdown wouldn't mean anything.
  const { prismaLike, state } = makeRollupStub();
  await computeWorkspaceRollup(prismaLike, {});

  const invitationCalls = state.calls.filter(
    (c) => c.table === "invitation.count",
  );
  const channels = invitationCalls
    .map((c) => (c.where as Record<string, unknown>).channel)
    .filter((c) => c !== undefined)
    .sort();
  assert.deepEqual(channels, ["email", "sms", "whatsapp"]);

  // The aggregate still runs WITHOUT a channel filter — one of the
  // four calls must have `channel === undefined`.
  const aggregates = invitationCalls.filter(
    (c) => (c.where as Record<string, unknown>).channel === undefined,
  );
  assert.equal(aggregates.length, 1);
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

// ---- (d) P14-A: route-trigger helpers ----
//
// The chat and confirm routes each gate a refresh call behind a small
// predicate (tool name == "draft_campaign" / status == 200). Pre-P14-A
// those predicates were inline in the routes, which have Next runtime
// dependencies (NextResponse, session cookies, SSE emitters) and can't
// be loaded from a plain node test without heavy mocking. P14-A
// extracts the predicate + refresh + error-swallow posture into
// `tryRefreshSummaryFor{ChatTool,Confirm}` so every outcome branch
// (`skipped` / `produced` / `invalid` / `error`) is pin-testable here.
//
// What a regression in any of these pins would mean in production:
//   - "skipped" fails closed  → a refresh runs when it shouldn't (e.g.
//     on every read-only tool call), wasting four counter queries per
//     chat turn. Not a correctness bug, but a real perf regression at
//     scale.
//   - "skipped" fails open    → the refresh STOPS running on the tool
//     that should trigger it (e.g. draft_campaign stops refreshing),
//     and the dashboard's counter strip silently goes stale until the
//     next unrelated mutation.
//   - "produced" regression   → the helper returns the widget but the
//     route doesn't emit SSE; dashboard reloads see the correct row on
//     next snapshot but live updates silently break.
//   - "error"/"invalid"       → the error escapes the try/catch and
//     aborts the chat turn OR the confirm response, losing the model's
//     reply / the operator's confirmation outcome.

test("tryRefreshSummaryForChatTool: refreshes on draft_campaign, produces widget outcome", async () => {
  // Happy path pin — the one tool that MUST trigger a refresh in the
  // chat route. If the gate ever narrows (someone removes
  // "draft_campaign" from CHAT_TOOLS_REFRESHING_SUMMARY without
  // noticing this test), the rollup silently stops updating in the
  // live SSE stream.
  const stub = makeRollupStub({ campaignCount: 7 });
  const outcome = await tryRefreshSummaryForChatTool(
    { prismaLike: stub.prismaLike },
    { sessionId: "s-1", campaignScope: {} },
    "draft_campaign",
  );
  assert.equal(outcome.kind, "produced");
  if (outcome.kind === "produced") {
    assert.equal(outcome.widget.widgetKey, WORKSPACE_SUMMARY_WIDGET_KEY);
    assert.equal(outcome.widget.kind, "workspace_rollup");
    assert.equal(outcome.widget.slot, "summary");
  }
  // A counter query actually ran — compute did not short-circuit.
  assert.ok(stub.state.calls.length > 0, "expected compute queries to run");
  // The row landed in the DB — the caller's "produced" emit is safe
  // to send because the widget is already persisted.
  assert.equal(stub.state.rows.length, 1);
});

test("tryRefreshSummaryForChatTool: skips any tool name not in CHAT_TOOLS_REFRESHING_SUMMARY", async () => {
  // The gate's negative space. Every one of these names has a reason
  // to NOT trigger a refresh in the chat route:
  //   - list_campaigns / get_campaign — read-only, nothing to refresh.
  //   - propose_send / propose_import — dispatch-intercepted here;
  //     their real writes happen via the /confirm route which has its
  //     own helper.
  //   - send_campaign / commit_import — destructive; dispatch refuses
  //     them here, they never run on this route.
  //   - empty string — handler for a broken tool envelope.
  // If the gate ever widens to accept one of these (e.g. someone adds
  // "propose_send" thinking it moves counters), the refresh would
  // start running on propose calls — waste a query on every propose
  // turn AND emit a spurious widget_upsert that the client re-orders.
  const nonTriggering = [
    "list_campaigns",
    "get_campaign",
    "propose_send",
    "propose_import",
    "send_campaign",
    "commit_import",
    "draft_campaign_preview",
    "",
  ];
  for (const name of nonTriggering) {
    const stub = makeRollupStub({ campaignCount: 3 });
    const outcome = await tryRefreshSummaryForChatTool(
      { prismaLike: stub.prismaLike },
      { sessionId: "s-1", campaignScope: {} },
      name,
    );
    assert.equal(
      outcome.kind,
      "skipped",
      `expected "${name}" to skip the refresh`,
    );
    // Compute did NOT run — no counter queries, no upsert. This is the
    // load-bearing half of the pin: the gate returning early before
    // touching prisma is what makes the non-triggering case cheap.
    assert.equal(
      stub.state.calls.length,
      0,
      `"${name}" should not have issued any counter queries`,
    );
    assert.equal(
      stub.state.rows.length,
      0,
      `"${name}" should not have written a rollup row`,
    );
  }
});

test("tryRefreshSummaryForChatTool: captures thrown errors as { kind: 'error' } without rethrowing", async () => {
  // Error-swallow posture pin. The chat route's try/catch around
  // the old inline refresh was there BECAUSE a thrown error here
  // would abort the streaming turn mid-response and lose the
  // model's reply. The helper MUST preserve that behaviour —
  // return an `error` outcome and let the route log it, never
  // rethrow. If this pin regresses, a transient prisma failure
  // (connection drop, deadlock) would kill the chat turn.
  const boom = new Error("prisma connection dropped");
  const { prismaLike } = makeRollupStub();
  // Override one of the underlying counters to throw. compute calls
  // campaign.count first in the Promise.all — forcing it to reject
  // exercises the catch path.
  const throwingPrismaLike: WorkspaceSummaryPrismaLike = {
    ...prismaLike,
    campaign: {
      ...prismaLike.campaign,
      async count() {
        throw boom;
      },
    },
  };
  const outcome = await tryRefreshSummaryForChatTool(
    { prismaLike: throwingPrismaLike },
    { sessionId: "s-1", campaignScope: {} },
    "draft_campaign",
  );
  assert.equal(outcome.kind, "error");
  if (outcome.kind === "error") {
    // The raw error is preserved so the route can log it with its
    // own prefix. Losing this reference would degrade logs to
    // "something went wrong" with no diagnostic signal.
    assert.equal(outcome.error, boom);
  }
});

test("tryRefreshSummaryForChatTool: returns { kind: 'invalid' } when upsertWidget rejects", async () => {
  // Defensive branch. `refreshWorkspaceSummary` returns null when
  // upsertWidget's validateWidget step rejects — reachable today
  // only via an empty sessionId (upsertWidget's own guard) or a
  // future compute refactor that produces malformed props. Either
  // path MUST surface as "invalid", not as "produced", so the
  // route logs-and-drops instead of emitting a widget_upsert with
  // a null payload. The empty sessionId path is a stand-in for the
  // compute-produces-bad-shape case that's currently unreachable;
  // the outcome wiring is identical either way.
  const stub = makeRollupStub({ campaignCount: 1 });
  const outcome = await tryRefreshSummaryForChatTool(
    { prismaLike: stub.prismaLike },
    { sessionId: "", campaignScope: {} }, // upsertWidget rejects empty sessionId
    "draft_campaign",
  );
  assert.equal(outcome.kind, "invalid");
  // No row persisted — the empty sessionId short-circuited inside
  // upsertWidget BEFORE the write landed.
  assert.equal(stub.state.rows.length, 0);
});

test("tryRefreshSummaryForConfirm: refreshes on status 200, produces widget outcome", async () => {
  // Happy path pin for the confirm route. A successful send or import
  // (200) moves counters the rollup tracks (`sent_24h` / `invitees.total`).
  // If this gate regresses closed, every send/import silently leaves
  // the rollup stale until the next unrelated mutation refreshes it.
  const stub = makeRollupStub({
    campaignCount: 4,
    inviteeCount: 80,
    sent24h: 5,
    sentEmail24h: 3,
    sentSms24h: 1,
    sentWhatsApp24h: 1,
  });
  const outcome = await tryRefreshSummaryForConfirm(
    { prismaLike: stub.prismaLike },
    { sessionId: "s-1", campaignScope: {} },
    200,
  );
  assert.equal(outcome.kind, "produced");
  if (outcome.kind === "produced") {
    assert.equal(outcome.widget.widgetKey, WORKSPACE_SUMMARY_WIDGET_KEY);
    assert.equal(outcome.widget.kind, "workspace_rollup");
    assert.equal(outcome.widget.slot, "summary");
  }
  assert.equal(stub.state.rows.length, 1);
});

test("tryRefreshSummaryForConfirm: skips every non-200 status", async () => {
  // Gate's negative space. Every non-200 status on the confirm route
  // is either a released-anchor refusal (blocker, forbidden, etc.)
  // where no DB write happened OR a dispatch-throw / in-write refusal
  // where the claim is held and the next real action will refresh
  // anyway. Refreshing on ANY of these would waste four queries AND
  // emit a "fresh" generated_at timestamp that doesn't match a real
  // mutation.
  //
  // Sweep a handful of real statuses the confirm route can produce:
  //   400 — structured refusal, anchor released OR held (depends on
  //         error code whitelist); neither case moved counters.
  //   401 — unauth (shouldn't reach here in practice but defensive).
  //   403 — forbidden (scope check failed; no write).
  //   404 — row not found / ownership mismatch (no write).
  //   409 — already_confirmed on the idempotency gate (no new write).
  //   500 — dispatch-throw (anchor held, no refresh).
  // Plus 0 as the "unset status" edge case in case a refactor forgets
  // to populate status before calling this helper — the gate MUST NOT
  // treat that as "success".
  const statuses = [0, 400, 401, 403, 404, 409, 500];
  for (const status of statuses) {
    const stub = makeRollupStub({ campaignCount: 3 });
    const outcome = await tryRefreshSummaryForConfirm(
      { prismaLike: stub.prismaLike },
      { sessionId: "s-1", campaignScope: {} },
      status,
    );
    assert.equal(
      outcome.kind,
      "skipped",
      `expected status ${status} to skip the refresh`,
    );
    assert.equal(
      stub.state.calls.length,
      0,
      `status ${status} should not have issued any counter queries`,
    );
    assert.equal(
      stub.state.rows.length,
      0,
      `status ${status} should not have written a rollup row`,
    );
  }
});

test("tryRefreshSummaryForConfirm: captures thrown errors as { kind: 'error' } without rethrowing", async () => {
  // Error-swallow posture pin. Mirror of the chat-tool pin above —
  // the confirm route has already sent its response body before this
  // refresh runs, so a throw here would surface as an unhandled
  // promise rejection and break the request finalisation without
  // affecting the operator's outcome. Must stay swallowed.
  const boom = new Error("prisma timed out");
  const { prismaLike } = makeRollupStub();
  const throwingPrismaLike: WorkspaceSummaryPrismaLike = {
    ...prismaLike,
    campaign: {
      ...prismaLike.campaign,
      async count() {
        throw boom;
      },
    },
  };
  const outcome = await tryRefreshSummaryForConfirm(
    { prismaLike: throwingPrismaLike },
    { sessionId: "s-1", campaignScope: {} },
    200,
  );
  assert.equal(outcome.kind, "error");
  if (outcome.kind === "error") {
    assert.equal(outcome.error, boom);
  }
});

test("tryRefreshSummaryForConfirm: returns { kind: 'invalid' } when upsertWidget rejects", async () => {
  // Same defensive branch as the chat-tool variant — if a future
  // refactor breaks compute's produces-validated-shape invariant,
  // or an empty sessionId slips past an earlier guard, the outcome
  // surfaces as "invalid" rather than a null widget leaking into
  // the caller. Empty sessionId is again the concrete trigger.
  const stub = makeRollupStub({ campaignCount: 1 });
  const outcome = await tryRefreshSummaryForConfirm(
    { prismaLike: stub.prismaLike },
    { sessionId: "", campaignScope: {} },
    200,
  );
  assert.equal(outcome.kind, "invalid");
  assert.equal(stub.state.rows.length, 0);
});

test("tryRefreshSummaryForSnapshot: always attempts refresh and produces widget on success", async () => {
  const stub = makeRollupStub({
    campaignCount: 6,
    sent24h: 4,
    sentEmail24h: 2,
    sentSms24h: 1,
    sentWhatsApp24h: 1,
  });
  const outcome = await tryRefreshSummaryForSnapshot(
    { prismaLike: stub.prismaLike },
    { campaignScope: {} },
  );
  assert.equal(outcome.kind, "produced");
  if (outcome.kind === "produced") {
    assert.equal(outcome.widget.widgetKey, WORKSPACE_SUMMARY_WIDGET_KEY);
    assert.equal(outcome.widget.kind, "workspace_rollup");
    assert.equal(outcome.widget.slot, "summary");
  }
  assert.equal(stub.state.rows.length, 0);
  assert.ok(stub.state.calls.length > 0);
});

test("tryRefreshSummaryForSnapshot: returns { kind: 'invalid' } when the computed widget fails validation", async () => {
  const stub = makeRollupStub();
  const throwingPrismaLike: WorkspaceSummaryPrismaLike = {
    ...stub.prismaLike,
    invitation: {
      ...stub.prismaLike.invitation,
      async count() {
        return Number.POSITIVE_INFINITY;
      },
    },
  };
  const outcome = await tryRefreshSummaryForSnapshot(
    { prismaLike: throwingPrismaLike },
    { campaignScope: {} },
  );
  assert.equal(outcome.kind, "invalid");
  assert.equal(stub.state.rows.length, 0);
});

test("tryRefreshSummaryForSnapshot: captures thrown errors as { kind: 'error' } without rethrowing", async () => {
  const boom = new Error("snapshot refresh failed");
  const { prismaLike } = makeRollupStub();
  const throwingPrismaLike: WorkspaceSummaryPrismaLike = {
    ...prismaLike,
    campaign: {
      ...prismaLike.campaign,
      async count() {
        throw boom;
      },
    },
  };
  const outcome = await tryRefreshSummaryForSnapshot(
    { prismaLike: throwingPrismaLike },
    { campaignScope: {} },
  );
  assert.equal(outcome.kind, "error");
  if (outcome.kind === "error") {
    assert.equal(outcome.error, boom);
  }
});

test("CHAT_TOOLS_REFRESHING_SUMMARY is the one-and-only gate list — drift catches here", () => {
  // Meta-pin on the exported tuple. The chat route's gate is driven
  // by this list; changing the list without updating the positive
  // and negative pins above is the exact drift scenario that would
  // leave the rollup half-wired (refresh fires on X but tests only
  // cover Y). The assertion below forces a test update the moment
  // the tuple changes.
  //
  // Today: exactly one entry — `draft_campaign`. `send_campaign` and
  // `commit_import` are destructive and run on the confirm route (see
  // `tryRefreshSummaryForConfirm`); read-only tools don't move
  // counters.
  assert.deepEqual(CHAT_TOOLS_REFRESHING_SUMMARY, ["draft_campaign"]);
});
