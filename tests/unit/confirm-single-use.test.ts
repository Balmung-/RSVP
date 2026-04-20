import { test } from "node:test";
import assert from "node:assert/strict";

import { runConfirmSend } from "../../src/lib/ai/confirm-flow";
import type {
  ConfirmPort,
  ConfirmRow,
  ConfirmSendOutcome,
} from "../../src/lib/ai/confirm-flow";
import type {
  DispatchResult,
  ToolCtx,
} from "../../src/lib/ai/tools/types";

// Guards the Push 7 single-use confirm anchor. The highest-risk
// destructive-path invariant in the whole chat surface: a second
// POST against the same `messageId` MUST return
// `already_confirmed` / 409 without re-dispatching send_campaign.
// If the atomic-claim predicate regresses, two clicks on the same
// anchor re-send the whole campaign — the "Confirm" card's
// "button hidden after success" is React state only and can't
// defend against retry / browser-back / forged POST.
//
// The route's claim is `prisma.chatMessage.updateMany({where: {id,
// confirmedAt: null}, data: {confirmedAt: now}})`. Postgres runs
// that as a single row-locking UPDATE, so exactly one of two
// concurrent callers sees `count: 1` (the winner) and the other
// sees `count: 0` (the loser, which the route maps to 409).
//
// Rather than stand up a DB for the test, we exercise the full
// flow through `runConfirmSend` with a fake port whose `claim`
// mimics the atomic predicate. That pins every invariant the
// route's HTTP contract depends on:
//   - fast-path 409 when `row.confirmedAt` is already set
//   - race-path 409 when the claim returns `count: 0`
//   - winner path: dispatch is called, audit confirms effective
//     outcome, transcript is persisted, 200 is returned
//   - refusal path: dispatch is called, classify flips ok to
//     false, release runs only on whitelisted codes, 400 is
//     returned with the error in the body
//   - non-releasable refusal: release is NOT called (the claim
//     stays held so a retry can't re-enter send fan-out)
//
// Every call to the port is counted so we can assert on the
// ordering AND on the negative assertions ("dispatch was not
// called on the loser path").

type Call<T> = { args: T; at: number };

type PortRecorder = {
  port: ConfirmPort;
  claimCalls: Call<void>[];
  releaseCalls: Call<void>[];
  dispatchCalls: Call<{ input: unknown; ctx: ToolCtx }>[];
  persistCalls: Call<{
    sessionId: string;
    content: string;
    isError: boolean;
  }>[];
  auditConfirmCalls: Call<Record<string, unknown>>[];
  auditDeniedCalls: Call<Record<string, unknown>>[];
  markOutcomeCalls: Call<ConfirmSendOutcome>[];
};

// Build a fake port that simulates an atomic `updateMany({where:
// {id, confirmedAt: null}})`: the first caller to invoke `claim`
// wins (count=1) and flips the internal `confirmedAt`; every
// subsequent caller loses (count=0). `release` clears it, so a
// releasable-refusal path can retry.
function buildPort(
  opts: {
    dispatchResult: DispatchResult;
    initialConfirmedAt?: Date | null;
  },
): PortRecorder {
  let confirmedAt: Date | null = opts.initialConfirmedAt ?? null;
  let t = 0;
  const rec: PortRecorder = {
    port: undefined as unknown as ConfirmPort,
    claimCalls: [],
    releaseCalls: [],
    dispatchCalls: [],
    persistCalls: [],
    auditConfirmCalls: [],
    auditDeniedCalls: [],
    markOutcomeCalls: [],
  };
  rec.port = {
    claim: async () => {
      rec.claimCalls.push({ args: undefined, at: t++ });
      if (confirmedAt === null) {
        confirmedAt = new Date();
        return { count: 1 };
      }
      return { count: 0 };
    },
    release: async () => {
      rec.releaseCalls.push({ args: undefined, at: t++ });
      confirmedAt = null;
    },
    dispatchSend: async (input, ctx) => {
      rec.dispatchCalls.push({ args: { input, ctx }, at: t++ });
      return opts.dispatchResult;
    },
    persistTranscript: async (args) => {
      rec.persistCalls.push({ args, at: t++ });
    },
    auditConfirm: async (args) => {
      rec.auditConfirmCalls.push({ args: args.data, at: t++ });
    },
    auditDenied: async (args) => {
      rec.auditDeniedCalls.push({ args: args.data, at: t++ });
    },
    markConfirmSendOutcome: async (outcome) => {
      rec.markOutcomeCalls.push({ args: outcome, at: t++ });
    },
  };
  return rec;
}

const fakeCtx: ToolCtx = {
  user: { id: "u-fake", email: "fake@test" } as ToolCtx["user"],
  isAdmin: false,
  locale: "en",
  campaignScope: {},
};

const makeRow = (overrides: Partial<ConfirmRow> = {}): ConfirmRow => ({
  id: "m-1",
  sessionId: "s-1",
  confirmedAt: null,
  ...overrides,
});

test("runConfirmSend: first POST wins, dispatches, audits, persists, 200", async () => {
  const rec = buildPort({
    dispatchResult: {
      ok: true,
      result: {
        output: {
          sent: 3,
          email: 2,
          sms: 1,
          skipped: 0,
          failed: 0,
          summary: "Sent 3: 2 email, 1 sms",
        },
      },
    },
  });
  const resp = await runConfirmSend(
    makeRow(),
    "m-1",
    { campaign_id: "c-1" },
    fakeCtx,
    rec.port,
  );
  assert.equal(resp.status, 200);
  assert.equal((resp.body as { ok: boolean }).ok, true);
  assert.equal((resp.body as { summary: string }).summary, "Sent 3: 2 email, 1 sms");
  // Claim attempted, dispatch attempted, audit recorded,
  // transcript persisted, no denied-audit, no release.
  assert.equal(rec.claimCalls.length, 1);
  assert.equal(rec.dispatchCalls.length, 1);
  assert.equal(rec.auditConfirmCalls.length, 1);
  assert.equal(rec.auditConfirmCalls[0].args.ok, true);
  assert.equal(rec.persistCalls.length, 1);
  assert.equal(rec.persistCalls[0].args.isError, false);
  assert.equal(rec.auditDeniedCalls.length, 0);
  assert.equal(rec.releaseCalls.length, 0);
  // W5 — widget row flipped to "done" with the handler's counters.
  // Must run AFTER auditConfirm + persistTranscript so a widget-write
  // failure doesn't mask the authoritative record of the send.
  assert.equal(rec.markOutcomeCalls.length, 1);
  const outcome = rec.markOutcomeCalls[0].args;
  assert.equal(outcome.state, "done");
  if (outcome.state === "done") {
    // P13-D.2 — `whatsapp` is required on the persisted outcome. The
    // dispatch output here doesn't carry it (pre-P13 fixture shape);
    // the outcome writer's `asFiniteNumber` defensively coerces the
    // missing field to 0. That coercion is load-bearing: it keeps old
    // transcript replays and abbreviated test fixtures landing on a
    // validator-clean shape.
    assert.deepEqual(outcome.result, {
      email: 2,
      sms: 1,
      whatsapp: 0,
      skipped: 0,
      failed: 0,
    });
  }
  assert(rec.markOutcomeCalls[0].at > rec.auditConfirmCalls[0].at);
  assert(rec.markOutcomeCalls[0].at > rec.persistCalls[0].at);
});

test("runConfirmSend: SECOND call against same row short-circuits to 409 without dispatching", async () => {
  // Shared port — same claim-store across both calls. The first
  // call wins (count=1, confirmedAt stamped); the second call's
  // claim returns count=0.
  const rec = buildPort({
    dispatchResult: {
      ok: true,
      result: {
        output: {
          sent: 1,
          email: 1,
          sms: 0,
          skipped: 0,
          failed: 0,
          summary: "Sent 1",
        },
      },
    },
  });
  // First — wins.
  const r1 = await runConfirmSend(
    makeRow(),
    "m-1",
    {},
    fakeCtx,
    rec.port,
  );
  assert.equal(r1.status, 200);
  // Second — loses. Note: `row.confirmedAt` is still null in this
  // call because the test simulates a stale row read (the exact
  // scenario the race-path guards against: both callers read
  // confirmedAt=null before either updateMany ran).
  const r2 = await runConfirmSend(
    makeRow(),
    "m-1",
    {},
    fakeCtx,
    rec.port,
  );
  assert.equal(r2.status, 409);
  assert.equal((r2.body as { ok: boolean }).ok, false);
  assert.equal((r2.body as { error: string }).error, "already_confirmed");
  // Critical negative assertion: dispatch was NOT called a second
  // time. A regression that re-dispatched on count=0 would show
  // `dispatchCalls.length === 2` here.
  assert.equal(rec.dispatchCalls.length, 1);
  // The loser audited as denied with reason=already_confirmed, raced=true.
  assert.equal(rec.auditDeniedCalls.length, 1);
  assert.equal(rec.auditDeniedCalls[0].args.reason, "already_confirmed");
  assert.equal(rec.auditDeniedCalls[0].args.raced, true);
  // W5 — loser also must NOT touch the widget row. The winner's
  // outcome is the source of truth; the loser re-marking could
  // overwrite with stale data in a future refactor.
  assert.equal(rec.markOutcomeCalls.length, 1);
});

test("runConfirmSend: fast-path 409 when row.confirmedAt is already set — no claim attempted", async () => {
  const rec = buildPort({
    dispatchResult: {
      ok: true,
      result: { output: { sent: 0 } },
    },
  });
  const confirmedAt = new Date("2026-04-19T12:00:00.000Z");
  const resp = await runConfirmSend(
    makeRow({ confirmedAt }),
    "m-1",
    {},
    fakeCtx,
    rec.port,
  );
  assert.equal(resp.status, 409);
  assert.equal((resp.body as { error: string }).error, "already_confirmed");
  // No claim should have been attempted — the fast-path is
  // specifically about skipping the updateMany when we already
  // know the anchor is taken.
  assert.equal(rec.claimCalls.length, 0);
  assert.equal(rec.dispatchCalls.length, 0);
  // Audit-denied fires with the confirmedAt timestamp in the data.
  assert.equal(rec.auditDeniedCalls.length, 1);
  assert.equal(rec.auditDeniedCalls[0].args.reason, "already_confirmed");
  assert.equal(
    rec.auditDeniedCalls[0].args.confirmedAt,
    confirmedAt.toISOString(),
  );
  // W5 — fast-path also does not touch the widget row. The original
  // winner stamped it already; re-marking could overwrite with stale
  // data.
  assert.equal(rec.markOutcomeCalls.length, 0);
});

test("runConfirmSend: releasable structured refusal releases the claim and returns 400", async () => {
  const rec = buildPort({
    dispatchResult: {
      ok: true,
      result: {
        output: {
          error: "status_not_sendable",
          summary: "Campaign must be active to send.",
        },
      },
    },
  });
  const resp = await runConfirmSend(
    makeRow(),
    "m-1",
    {},
    fakeCtx,
    rec.port,
  );
  assert.equal(resp.status, 400);
  assert.equal((resp.body as { ok: boolean }).ok, false);
  assert.equal((resp.body as { error: string }).error, "status_not_sendable");
  // Release ran (refusal is whitelisted), audit flipped to ok:false,
  // transcript persisted with isError=true.
  assert.equal(rec.releaseCalls.length, 1);
  assert.equal(rec.auditConfirmCalls.length, 1);
  assert.equal(rec.auditConfirmCalls[0].args.ok, false);
  assert.equal(rec.auditConfirmCalls[0].args.error, "status_not_sendable");
  assert.equal(rec.persistCalls[0].args.isError, true);
  // W5 — widget row flipped to "error" carrying the refusal code, so
  // a reload shows the same actionable error the transcript surfaces.
  assert.equal(rec.markOutcomeCalls.length, 1);
  const outcome = rec.markOutcomeCalls[0].args;
  assert.equal(outcome.state, "error");
  if (outcome.state === "error") {
    assert.equal(outcome.error, "status_not_sendable");
  }
});

test("runConfirmSend: dispatch throw keeps the claim held (non-releasable)", async () => {
  const rec = buildPort({
    // Dispatch-layer failure — classifyOutcome reports this as
    // non-releasable because a throw could have happened mid-fanout
    // inside sendCampaign, leaving partial state.
    dispatchResult: { ok: false, error: "handler_error:Error: boom" },
  });
  const resp = await runConfirmSend(
    makeRow(),
    "m-1",
    {},
    fakeCtx,
    rec.port,
  );
  assert.equal(resp.status, 400);
  assert.equal(
    (resp.body as { error: string }).error,
    "handler_error:Error: boom",
  );
  // Critical: the claim is NOT released. A retry would re-enter
  // sendCampaign's fan-out; the previous run could have sent to
  // some invitees before throwing.
  assert.equal(rec.releaseCalls.length, 0);
  assert.equal(rec.auditConfirmCalls[0].args.ok, false);
});

test("runConfirmSend: non-releasable structured refusal also keeps the claim held", async () => {
  // A hypothetical refusal code not in the whitelist — still flips
  // to failure via classifyOutcome, but the claim stays held.
  const rec = buildPort({
    dispatchResult: {
      ok: true,
      result: { output: { error: "some_future_code" } },
    },
  });
  const resp = await runConfirmSend(
    makeRow(),
    "m-1",
    {},
    fakeCtx,
    rec.port,
  );
  assert.equal(resp.status, 400);
  assert.equal(rec.releaseCalls.length, 0);
});

// ---- P13-D.2: WhatsApp counter in the outcome writer ----

test("runConfirmSend: WhatsApp counter from dispatch output flows into persisted outcome", async () => {
  // The end-to-end wiring: `send_campaign` returns `{email, sms,
  // whatsapp, skipped, failed}` → confirm-flow reads each counter
  // off `output` → W5 writer persists the widget row with the full
  // shape. Pinning this catches the regression where a channel field
  // gets dropped somewhere in the pipe (validator, outcome writer,
  // or the `rec.whatsapp` read in confirm-flow.ts).
  const rec = buildPort({
    dispatchResult: {
      ok: true,
      result: {
        output: {
          sent: 6,
          email: 2,
          sms: 1,
          whatsapp: 3,
          skipped: 0,
          failed: 0,
          summary: "Sent 6: 2 email, 1 sms, 3 whatsapp",
        },
      },
    },
  });
  const resp = await runConfirmSend(
    makeRow(),
    "m-1",
    { campaign_id: "c-1", channel: "all" },
    fakeCtx,
    rec.port,
  );
  assert.equal(resp.status, 200);
  assert.equal(rec.markOutcomeCalls.length, 1);
  const outcome = rec.markOutcomeCalls[0].args;
  assert.equal(outcome.state, "done");
  if (outcome.state === "done") {
    assert.equal(outcome.result.whatsapp, 3);
    assert.equal(outcome.result.email, 2);
    assert.equal(outcome.result.sms, 1);
  }
});

test("runConfirmSend: non-finite whatsapp counter coerces to 0 in outcome", async () => {
  // Defensive — if a handler bug emits `NaN` or `Infinity`, the
  // outcome writer must still produce a validator-clean blob. The
  // validator's `isFiniteNumber` rejects both, which would drop the
  // widget write. `asFiniteNumber` is the load-bearing coercion here.
  const rec = buildPort({
    dispatchResult: {
      ok: true,
      result: {
        output: {
          sent: 1,
          email: 1,
          sms: 0,
          whatsapp: Number.NaN,
          skipped: 0,
          failed: 0,
        },
      },
    },
  });
  await runConfirmSend(
    makeRow(),
    "m-1",
    {},
    fakeCtx,
    rec.port,
  );
  const outcome = rec.markOutcomeCalls[0].args;
  assert.equal(outcome.state, "done");
  if (outcome.state === "done") {
    assert.equal(outcome.result.whatsapp, 0);
  }
});
