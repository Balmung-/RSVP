import { test } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../../src/lib/db";
import { addMember, removeMember } from "../../src/lib/teams";

test("addMember: rejects users outside the active tenant before any team upsert", async (t) => {
  t.mock.method(prisma.team, "findFirst", async () => ({ id: "team-1" }));
  t.mock.method(prisma.tenantMembership, "findUnique", async () => null);
  const upsert = t.mock.method(prisma.teamMembership, "upsert", async () => {
    throw new Error("should not upsert");
  });

  const result = await addMember("tenant-1", "team-1", "user-2", "member");

  assert.deepEqual(result, { ok: false, reason: "not_found" });
  assert.equal(upsert.mock.calls.length, 0);
});

test("addMember: upserts only after team and tenant membership both match", async (t) => {
  t.mock.method(prisma.team, "findFirst", async () => ({ id: "team-1" }));
  t.mock.method(prisma.tenantMembership, "findUnique", async () => ({ tenantId: "tenant-1" }));
  const upsert = t.mock.method(prisma.teamMembership, "upsert", async (args: unknown) => args);

  const result = await addMember("tenant-1", "team-1", "user-2", "lead");

  assert.deepEqual(result, { ok: true });
  assert.equal(upsert.mock.calls.length, 1);
  assert.deepEqual(upsert.mock.calls[0]!.arguments[0], {
    where: { teamId_userId: { teamId: "team-1", userId: "user-2" } },
    create: { teamId: "team-1", userId: "user-2", role: "lead" },
    update: { role: "lead" },
  });
});

test("removeMember: scopes deleteMany through the team's tenant", async (t) => {
  const remove = t.mock.method(prisma.teamMembership, "deleteMany", async (args: unknown) => args);

  await removeMember("tenant-1", "team-1", "user-2");

  assert.equal(remove.mock.calls.length, 1);
  assert.deepEqual(remove.mock.calls[0]!.arguments[0], {
    where: {
      teamId: "team-1",
      userId: "user-2",
      team: { tenantId: "tenant-1" },
    },
  });
});
