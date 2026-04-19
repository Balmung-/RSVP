import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveGmailAccount,
  type MinimalAccountRow,
} from "../../src/lib/providers/email/resolve-account";

// Pins the routing decision tree of resolveGmailAccount. The Gmail
// adapter delegates account selection entirely to this resolver, so
// every branch here corresponds to a real send-path outcome:
//
//   - team_hit                      -> per-team send uses team mailbox
//   - team_miss_fallback_office     -> audit-worthy; team row missing
//   - office_hit                    -> office-wide send as expected
//   - no_account                    -> hard fail_closed from adapter
//
// Tests use a stub findFirst so zero DB access is needed. Matches
// the oauth-url-builder / oauth-revoke test style.

const teamRow: MinimalAccountRow = {
  id: "row-team",
  teamId: "team-x",
  googleEmail: "team@example.com",
  accessTokenEnc: "enc-a-team",
  refreshTokenEnc: "enc-r-team",
  tokenExpiresAt: new Date(0),
};

const officeRow: MinimalAccountRow = {
  id: "row-office",
  teamId: null,
  googleEmail: "office@example.com",
  accessTokenEnc: "enc-a-office",
  refreshTokenEnc: "enc-r-office",
  tokenExpiresAt: new Date(0),
};

// Keyed by teamId — null is stored under the literal "__null__".
// Captures the calls array so tests can assert both outcome AND
// that we didn't make a wasted round trip.
function stubFindFirst(byTeam: Record<string, MinimalAccountRow | null>) {
  const calls: Array<string | null> = [];
  const fn = async (teamId: string | null) => {
    calls.push(teamId);
    const key = teamId === null ? "__null__" : teamId;
    return byTeam[key] ?? null;
  };
  return { fn, calls };
}

test("resolveGmailAccount: office request + office row -> office_hit (one lookup)", async () => {
  const { fn, calls } = stubFindFirst({ __null__: officeRow });
  const r = await resolveGmailAccount({ targetTeamId: null, findFirst: fn });
  assert.equal(r.routing.kind, "office_hit");
  assert.equal(r.account?.id, "row-office");
  // Office-wide request must not do a fallback lookup — it IS the
  // fallback target.
  assert.deepEqual(calls, [null]);
});

test("resolveGmailAccount: office request + no row -> no_account", async () => {
  const { fn, calls } = stubFindFirst({});
  const r = await resolveGmailAccount({ targetTeamId: null, findFirst: fn });
  assert.equal(r.routing.kind, "no_account");
  if (r.routing.kind === "no_account") {
    assert.equal(r.routing.requestedTeamId, null);
  }
  assert.equal(r.account, null);
  assert.deepEqual(calls, [null]);
});

test("resolveGmailAccount: team request + team row -> team_hit (no office lookup)", async () => {
  // Critical for DB-efficiency: when the team row exists, we must
  // NOT also hit the office-wide row. Otherwise every per-team send
  // would double its findFirst round trips.
  const { fn, calls } = stubFindFirst({
    "team-x": teamRow,
    __null__: officeRow,
  });
  const r = await resolveGmailAccount({
    targetTeamId: "team-x",
    findFirst: fn,
  });
  assert.equal(r.routing.kind, "team_hit");
  if (r.routing.kind === "team_hit") {
    assert.equal(r.routing.teamId, "team-x");
  }
  assert.equal(r.account?.id, "row-team");
  assert.equal(r.account?.googleEmail, "team@example.com");
  assert.deepEqual(calls, ["team-x"]);
});

test("resolveGmailAccount: team request + team miss + office row -> team_miss_fallback_office", async () => {
  // The audit-worthy outcome. Real-world cause: a campaign tagged
  // with teamId=X pre-dates the day an admin connected team X's
  // mailbox. The adapter must fall through to office-wide rather
  // than fail the send — matches pre-B3 behavior for these
  // campaigns — and must emit a routing.fallback audit (verified
  // in the adapter, not this pure-helper test).
  const { fn, calls } = stubFindFirst({ __null__: officeRow });
  const r = await resolveGmailAccount({
    targetTeamId: "team-x",
    findFirst: fn,
  });
  assert.equal(r.routing.kind, "team_miss_fallback_office");
  if (r.routing.kind === "team_miss_fallback_office") {
    assert.equal(r.routing.requestedTeamId, "team-x");
  }
  assert.equal(r.account?.id, "row-office");
  assert.equal(r.account?.teamId, null);
  // Two lookups: team first, then null fallback.
  assert.deepEqual(calls, ["team-x", null]);
});

test("resolveGmailAccount: team request + neither row -> no_account (preserves requestedTeamId)", async () => {
  const { fn, calls } = stubFindFirst({});
  const r = await resolveGmailAccount({
    targetTeamId: "team-x",
    findFirst: fn,
  });
  assert.equal(r.routing.kind, "no_account");
  if (r.routing.kind === "no_account") {
    // Preserving requestedTeamId in the no_account case matters for
    // the adapter's error message — we want the operator to see
    // "no OAuthAccount for teamId=team-x" not "... for <office-wide>"
    // when the caller actually asked for a team.
    assert.equal(r.routing.requestedTeamId, "team-x");
  }
  assert.equal(r.account, null);
  assert.deepEqual(calls, ["team-x", null]);
});

test("resolveGmailAccount: propagates findFirst errors (does not swallow)", async () => {
  // The resolver is pure — it shouldn't swallow infra errors. The
  // adapter's try/catch around the whole send is what translates
  // them into retryable SendResults. If the resolver silently
  // returned no_account on a transient DB error, we'd lose the
  // retryable signal and drop invitations.
  const boom = new Error("db_unreachable");
  const fn = async () => {
    throw boom;
  };
  await assert.rejects(
    () => resolveGmailAccount({ targetTeamId: "team-x", findFirst: fn }),
    /db_unreachable/,
  );
});

test("resolveGmailAccount: second lookup uses null exactly (not coerced)", async () => {
  // The fallback lookup must pass literal null so Prisma maps it to
  // `teamId IS NULL`. Passing undefined would drop the where clause
  // entirely and return the latest row across ALL teams — the exact
  // cross-team leak we're trying to prevent.
  const { fn, calls } = stubFindFirst({ __null__: officeRow });
  await resolveGmailAccount({ targetTeamId: "team-x", findFirst: fn });
  assert.equal(calls.length, 2);
  assert.equal(calls[1], null);
  // Strict-equal guard against a future refactor that coerces to
  // undefined.
  assert.ok(calls[1] === null);
});
