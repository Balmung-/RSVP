import { test } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";

import { buildListCampaignsWhere } from "../../src/lib/ai/tools/list_campaigns";

// Guards the Push 2-fix scope leak: composing the team-scope
// fragment with extra OR-bearing filters via object-spread
// silently drops the scope filter, because JS objects can only
// hold one `OR` key. The fixed implementation composes via an
// `AND` array so both OR clauses survive side-by-side. This test
// would have caught the original leak and pins the regression.
//
// The "team scope" fragment below mirrors what `scopedCampaignWhere`
// returns for a non-admin on teams [t1, t2] — an OR branching over
// "office-wide (teamId=null) OR in one of my teams". The
// `upcoming_only` flag adds a second OR ("eventAt is null OR in
// the future"). Both must be preserved in the resulting WHERE or
// a non-admin could see campaigns outside their team.

const teamScope: Prisma.CampaignWhereInput = {
  OR: [{ teamId: null }, { teamId: { in: ["t1", "t2"] } }],
};

test("buildListCampaignsWhere preserves team scope when upcoming_only adds its own OR", () => {
  const where = buildListCampaignsWhere(
    { upcoming_only: true },
    { campaignScope: teamScope },
    new Date("2025-01-01T00:00:00.000Z"),
  );
  // Must be an AND-composed object, not a spread that loses one OR.
  assert.ok(Array.isArray(where.AND), "where.AND should be an array");
  const and = where.AND as Prisma.CampaignWhereInput[];
  // First clause is the full team scope (team-scope OR branch intact).
  assert.deepEqual(and[0], teamScope);
  // Somewhere in the AND chain we must still find the upcoming-only OR.
  const hasUpcoming = and.some(
    (c) =>
      Array.isArray(c.OR) &&
      c.OR.some((o) => "eventAt" in (o as Record<string, unknown>) &&
        (o as { eventAt?: unknown }).eventAt === null),
  );
  assert.ok(hasUpcoming, "upcoming-only OR branch should survive composition");
});

test("buildListCampaignsWhere still AND-composes when upcoming_only is absent", () => {
  const where = buildListCampaignsWhere(
    {},
    { campaignScope: teamScope },
    new Date("2025-01-01T00:00:00.000Z"),
  );
  assert.ok(Array.isArray(where.AND));
  const and = where.AND as Prisma.CampaignWhereInput[];
  // Team scope present, status filter present, no upcoming clause.
  assert.deepEqual(and[0], teamScope);
  assert.equal(and.length, 2);
});

test("buildListCampaignsWhere applies default statuses when none supplied", () => {
  const where = buildListCampaignsWhere(
    {},
    { campaignScope: {} },
    new Date("2025-01-01T00:00:00.000Z"),
  );
  const and = where.AND as Prisma.CampaignWhereInput[];
  const statusClause = and.find(
    (c) => "status" in c,
  ) as { status?: { in?: string[] } } | undefined;
  assert.ok(statusClause, "status filter should be present");
  assert.deepEqual(statusClause.status?.in, ["draft", "active", "sending"]);
});
