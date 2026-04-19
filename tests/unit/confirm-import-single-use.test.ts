import { test } from "node:test";
import assert from "node:assert/strict";

import { runConfirmImport } from "../../src/lib/ai/confirm-import-flow";
import type {
  ConfirmImportPort,
  ConfirmImportOutcome,
  ConfirmRow,
} from "../../src/lib/ai/confirm-import-flow";
import type {
  DispatchResult,
  ToolCtx,
} from "../../src/lib/ai/tools/types";

// P7 — guards the single-use anchor invariant for the IMPORT arm of
// the confirm flow. Parallel to `confirm-single-use.test.ts` for
// send. The route's claim semantics (atomic `updateMany` with a
// `confirmedAt: null` predicate) are the same; the flow module is
// what fans out to the import-specific dispatch / audit kinds /
// widget outcome shape. This test pins that the same invariants hold
// on the import path:
//
//   - fast-path 409 when `row.confirmedAt` is already set
//   - race-path 409 when the claim returns `count: 0`
//   - winner path: dispatch is called, audit confirms effective
//     outcome, transcript is persisted, 200 is returned
//   - releasable refusal: release runs, 400 is returned
//   - non-releasable refusal: release does NOT run (claim stays
//     held so a retry can't re-enter a partial-write state)
//   - dispatch throw: release does NOT run, 400 is returned
//
// Why a separate test file rather than parameterising
// `confirm-single-use.test.ts`: the outcome shape differs (send
// reports `{email, sms, skipped, failed}`, import reports `{created,
// existingSkipped, duplicatesInFile, invalid, errors}`), the
// whitelist differs, and the dispatch target differs. Each flow
// having its own test is what keeps a future refactor of one from
// silently drifting the other.

type Call<T> = { args: T; at: number };

type PortRecorder = {
  port: ConfirmImportPort;
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
  markOutcomeCalls: Call<ConfirmImportOutcome>[];
};

function buildPort(opts: {
  dispatchResult: DispatchResult;
  initialConfirmedAt?: Date | null;
}): PortRecorder {
  let confirmedAt: Date | null = opts.initialConfirmedAt ?? null;
  let t = 0;
  const rec: PortRecorder = {
    port: undefined as unknown as ConfirmImportPort,
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
    dispatchCommit: async (input, ctx) => {
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
    markConfirmImportOutcome: async (outcome) => {
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
  id: "m-import-1",
  sessionId: "s-1",
  confirmedAt: null,
  ...overrides,
});

test("runConfirmImport: first POST wins, dispatches, audits, persists, 200", async () => {
  const rec = buildPort({
    dispatchResult: {
      ok: true,
      result: {
        output: {
          ok: true,
          ingestId: "ing_1",
          target: "contacts",
          created: 3,
          existingSkipped: 1,
          duplicatesInFile: 0,
          invalid: 0,
          errors: 0,
          summary: 'Imported 3 rows from "guest.csv" → contacts.',
        },
      },
    },
  });
  const resp = await runConfirmImport(
    makeRow(),
    "m-import-1",
    { ingestId: "ing_1", target: "contacts" },
    fakeCtx,
    rec.port,
  );
  assert.equal(resp.status, 200);
  assert.equal((resp.body as { ok: boolean }).ok, true);
  assert.equal(
    (resp.body as { summary: string }).summary,
    'Imported 3 rows from "guest.csv" → contacts.',
  );

  assert.equal(rec.claimCalls.length, 1);
  assert.equal(rec.dispatchCalls.length, 1);
  assert.equal(rec.auditConfirmCalls.length, 1);
  assert.equal(rec.auditConfirmCalls[0].args.ok, true);
  assert.equal(rec.persistCalls.length, 1);
  assert.equal(rec.persistCalls[0].args.isError, false);
  assert.equal(rec.auditDeniedCalls.length, 0);
  assert.equal(rec.releaseCalls.length, 0);

  // Terminal-state widget write lands with the five-counter shape
  // and runs AFTER audit + transcript — a failed widget write must
  // not mask the authoritative durable records.
  assert.equal(rec.markOutcomeCalls.length, 1);
  const outcome = rec.markOutcomeCalls[0].args;
  assert.equal(outcome.state, "done");
  if (outcome.state === "done") {
    assert.deepEqual(outcome.result, {
      created: 3,
      existingSkipped: 1,
      duplicatesInFile: 0,
      invalid: 0,
      errors: 0,
    });
  }
  assert(rec.markOutcomeCalls[0].at > rec.auditConfirmCalls[0].at);
  assert(rec.markOutcomeCalls[0].at > rec.persistCalls[0].at);
});

test("runConfirmImport: SECOND call against same row short-circuits to 409 without dispatching", async () => {
  const rec = buildPort({
    dispatchResult: {
      ok: true,
      result: {
        output: {
          ok: true,
          ingestId: "ing_1",
          target: "contacts",
          created: 1,
          existingSkipped: 0,
          duplicatesInFile: 0,
          invalid: 0,
          errors: 0,
          summary: "Imported 1.",
        },
      },
    },
  });
  // First — wins.
  const r1 = await runConfirmImport(
    makeRow(),
    "m-import-1",
    { ingestId: "ing_1", target: "contacts" },
    fakeCtx,
    rec.port,
  );
  assert.equal(r1.status, 200);
  // Second — loses on the race-path (row.confirmedAt is still null
  // in this simulated stale-read scenario, but the claim returns
  // count:0 because the first call flipped the internal store).
  const r2 = await runConfirmImport(
    makeRow(),
    "m-import-1",
    { ingestId: "ing_1", target: "contacts" },
    fakeCtx,
    rec.port,
  );
  assert.equal(r2.status, 409);
  assert.equal((r2.body as { error: string }).error, "already_confirmed");
  // Critical negative assertion: dispatch was NOT called a second
  // time. A regression that re-dispatched on count:0 would show
  // dispatchCalls.length === 2 here.
  assert.equal(rec.dispatchCalls.length, 1);
  assert.equal(rec.auditDeniedCalls.length, 1);
  assert.equal(rec.auditDeniedCalls[0].args.reason, "already_confirmed");
  assert.equal(rec.auditDeniedCalls[0].args.raced, true);
  // Loser must NOT touch the widget row.
  assert.equal(rec.markOutcomeCalls.length, 1);
});

test("runConfirmImport: fast-path 409 when row.confirmedAt is already set — no claim attempted", async () => {
  const rec = buildPort({
    dispatchResult: {
      ok: true,
      result: { output: { ok: true, created: 0 } },
    },
  });
  const confirmedAt = new Date("2026-04-19T12:00:00.000Z");
  const resp = await runConfirmImport(
    makeRow({ confirmedAt }),
    "m-import-1",
    { ingestId: "ing_1", target: "contacts" },
    fakeCtx,
    rec.port,
  );
  assert.equal(resp.status, 409);
  assert.equal((resp.body as { error: string }).error, "already_confirmed");
  assert.equal(rec.claimCalls.length, 0);
  assert.equal(rec.dispatchCalls.length, 0);
  assert.equal(rec.auditDeniedCalls.length, 1);
  assert.equal(rec.auditDeniedCalls[0].args.reason, "already_confirmed");
  assert.equal(
    rec.auditDeniedCalls[0].args.confirmedAt,
    confirmedAt.toISOString(),
  );
  // Fast-path does not touch the widget row either.
  assert.equal(rec.markOutcomeCalls.length, 0);
});

test("runConfirmImport: releasable structured refusal releases the claim and returns 400", async () => {
  // `nothing_to_commit` is in RELEASABLE_IMPORT_REFUSALS —
  // commit_import returns it BEFORE the planner's createMany, so a
  // retry after the operator re-uploads can safely re-commit.
  const rec = buildPort({
    dispatchResult: {
      ok: true,
      result: {
        output: {
          error: "nothing_to_commit",
          summary: 'Refused: "foo.csv" has no rows to commit.',
        },
      },
    },
  });
  const resp = await runConfirmImport(
    makeRow(),
    "m-import-1",
    { ingestId: "ing_1", target: "contacts" },
    fakeCtx,
    rec.port,
  );
  assert.equal(resp.status, 400);
  assert.equal((resp.body as { ok: boolean }).ok, false);
  assert.equal(
    (resp.body as { error: string }).error,
    "nothing_to_commit",
  );
  assert.equal(rec.releaseCalls.length, 1);
  assert.equal(rec.auditConfirmCalls.length, 1);
  assert.equal(rec.auditConfirmCalls[0].args.ok, false);
  assert.equal(
    rec.auditConfirmCalls[0].args.error,
    "nothing_to_commit",
  );
  assert.equal(rec.persistCalls[0].args.isError, true);
  // Widget row flipped to "error" carrying the refusal code.
  assert.equal(rec.markOutcomeCalls.length, 1);
  const outcome = rec.markOutcomeCalls[0].args;
  assert.equal(outcome.state, "error");
  if (outcome.state === "error") {
    assert.equal(outcome.error, "nothing_to_commit");
  }
});

test("runConfirmImport: dispatch throw keeps the claim held (non-releasable)", async () => {
  // A throw inside commit_import's handler could have happened
  // mid-createMany with some rows persisted; retrying would risk
  // double-insert.
  const rec = buildPort({
    dispatchResult: { ok: false, error: "handler_error:Error: boom" },
  });
  const resp = await runConfirmImport(
    makeRow(),
    "m-import-1",
    { ingestId: "ing_1", target: "contacts" },
    fakeCtx,
    rec.port,
  );
  assert.equal(resp.status, 400);
  assert.equal(
    (resp.body as { error: string }).error,
    "handler_error:Error: boom",
  );
  assert.equal(rec.releaseCalls.length, 0);
  assert.equal(rec.auditConfirmCalls[0].args.ok, false);
});

test("runConfirmImport: non-releasable structured refusal keeps the claim held", async () => {
  // A hypothetical future refusal code not in the whitelist — still
  // flips to failure via classifyImportOutcome, but the claim stays
  // held so a retry can't re-enter a partial-write state.
  const rec = buildPort({
    dispatchResult: {
      ok: true,
      result: { output: { error: "partial_write_rollback_failed" } },
    },
  });
  const resp = await runConfirmImport(
    makeRow(),
    "m-import-1",
    { ingestId: "ing_1", target: "contacts" },
    fakeCtx,
    rec.port,
  );
  assert.equal(resp.status, 400);
  assert.equal(rec.releaseCalls.length, 0);
  assert.equal(
    rec.auditConfirmCalls[0].args.error,
    "partial_write_rollback_failed",
  );
});

test("runConfirmImport: widget outcome coerces junk counters to 0 on the happy path", async () => {
  // Pathological-but-possible: a handler bug surfaces NaN / negative
  // / non-integer on the output counters. The flow's asFiniteNonNegInt
  // coercion must zero them so the validator's "non-negative finite
  // integer" invariants on validateImportResult hold and the widget
  // write lands.
  const rec = buildPort({
    dispatchResult: {
      ok: true,
      result: {
        output: {
          ok: true,
          ingestId: "ing_1",
          target: "contacts",
          created: Number.NaN,
          existingSkipped: -1,
          duplicatesInFile: Infinity,
          invalid: 2.5,
          errors: "oops",
          summary: "Imported.",
        },
      },
    },
  });
  const resp = await runConfirmImport(
    makeRow(),
    "m-import-1",
    { ingestId: "ing_1", target: "contacts" },
    fakeCtx,
    rec.port,
  );
  assert.equal(resp.status, 200);
  assert.equal(rec.markOutcomeCalls.length, 1);
  const outcome = rec.markOutcomeCalls[0].args;
  assert.equal(outcome.state, "done");
  if (outcome.state === "done") {
    // Every junk value collapses to 0 — the validator accepts the
    // blob and the widget row updates without rejecting on NaN.
    assert.deepEqual(outcome.result, {
      created: 0,
      existingSkipped: 0,
      duplicatesInFile: 0,
      invalid: 0,
      errors: 0,
    });
  }
});
