import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { isUniqueViolation, isNotFound } from "./prisma-errors";

export const TEAM_ROLES = ["lead", "member", "guest"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const TEAM_ROLE_LABEL: Record<TeamRole, string> = {
  lead: "Lead",
  member: "Member",
  guest: "Guest",
};

export function teamsEnabled(): boolean {
  return (process.env.TEAMS_ENABLED ?? "").toLowerCase() === "true";
}

export type TeamInput = {
  name: string;
  slug?: string;
  color?: string | null;
  description?: string | null;
};

export type TeamMutationResult =
  | { ok: true; teamId: string }
  | { ok: false; reason: "missing_name" | "duplicate" | "not_found" | "invalid_slug" };

export type TeamMemberMutationResult =
  | { ok: true }
  | { ok: false; reason: "not_found" };

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50);
}

export async function createTeam(tenantId: string, input: TeamInput): Promise<TeamMutationResult> {
  const name = input.name.trim().slice(0, 100);
  if (!name) return { ok: false, reason: "missing_name" };
  const slug = input.slug?.trim() || slugify(name);
  if (!/^[a-z0-9-]{1,50}$/.test(slug)) return { ok: false, reason: "invalid_slug" };
  const color = input.color && /^#[0-9A-Fa-f]{3,8}$/.test(input.color) ? input.color : null;
  try {
    const row = await prisma.team.create({
      data: {
        tenantId,
        name,
        slug,
        color,
        description: (input.description ?? "").trim().slice(0, 500) || null,
      },
    });
    return { ok: true, teamId: row.id };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: "duplicate" };
    throw e;
  }
}

export async function updateTeam(tenantId: string, teamId: string, input: TeamInput): Promise<TeamMutationResult> {
  const name = input.name.trim().slice(0, 100);
  if (!name) return { ok: false, reason: "missing_name" };
  const slug = input.slug?.trim() || slugify(name);
  if (!/^[a-z0-9-]{1,50}$/.test(slug)) return { ok: false, reason: "invalid_slug" };
  const color = input.color && /^#[0-9A-Fa-f]{3,8}$/.test(input.color) ? input.color : null;
  try {
    const existing = await prisma.team.findFirst({ where: { id: teamId, tenantId }, select: { id: true } });
    if (!existing) return { ok: false, reason: "not_found" };
    await prisma.team.update({
      where: { id: teamId },
      data: {
        name,
        slug,
        color,
        description: (input.description ?? "").trim().slice(0, 500) || null,
      },
    });
    return { ok: true, teamId };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: "duplicate" };
    if (isNotFound(e)) return { ok: false, reason: "not_found" };
    throw e;
  }
}

export async function archiveTeam(tenantId: string, teamId: string) {
  await prisma.team.updateMany({ where: { id: teamId, tenantId }, data: { archivedAt: new Date() } });
}

export async function unarchiveTeam(tenantId: string, teamId: string) {
  await prisma.team.updateMany({ where: { id: teamId, tenantId }, data: { archivedAt: null } });
}

export async function deleteTeamRecord(tenantId: string, teamId: string) {
  await prisma.team.deleteMany({ where: { id: teamId, tenantId } });
}

export async function listTeams(tenantId: string, opts: { includeArchived?: boolean } = {}) {
  return prisma.team.findMany({
    where: { tenantId, ...(opts.includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ name: "asc" }],
    include: {
      _count: { select: { memberships: true, campaigns: true } },
    },
  });
}

export async function addMember(
  tenantId: string,
  teamId: string,
  userId: string,
  role: TeamRole,
): Promise<TeamMemberMutationResult> {
  const [team, membership] = await Promise.all([
    prisma.team.findFirst({
      where: { id: teamId, tenantId },
      select: { id: true },
    }),
    prisma.tenantMembership.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      select: { tenantId: true },
    }),
  ]);
  if (!team || !membership) return { ok: false, reason: "not_found" };
  await prisma.teamMembership.upsert({
    where: { teamId_userId: { teamId, userId } },
    create: { teamId, userId, role },
    update: { role },
  });
  return { ok: true };
}

export async function removeMember(tenantId: string, teamId: string, userId: string) {
  await prisma.teamMembership.deleteMany({
    where: { teamId, userId, team: { tenantId } },
  });
}

export async function userTeams(userId: string) {
  return prisma.teamMembership.findMany({
    where: { userId },
    include: { team: true },
  });
}

// Returns just the team IDs the user belongs to (active memberships,
// any role). Used by tenant-scoped list pages to build a
// `Campaign.teamId IN (...)` filter without dragging the team rows
// along. Returns an empty array for users with no memberships —
// callers decide whether to interpret that as "no results" or
// "office-wide" (e.g. admins see everything; scoped views see nothing).
export async function teamIdsForUser(userId: string, tenantId: string | null | undefined): Promise<string[]> {
  if (!tenantId) return [];
  const rows = await prisma.teamMembership.findMany({
    where: { userId, team: { tenantId, archivedAt: null } },
    select: { teamId: true },
  });
  return rows.map((r) => r.teamId);
}

// Produces a Prisma where clause that limits Campaign queries to
// those the user can see. Rules:
//   - Admins always see everything (`role=admin`).
//   - When TEAMS_ENABLED=false, everyone sees everything (feature off).
//   - Otherwise, non-admins see:
//       (a) campaigns with no team assignment (office-wide), plus
//       (b) campaigns in teams they're a member of.
// The returned object plugs directly into a `Campaign.where` clause or
// an `AND` list.
export async function scopedCampaignWhere(
  userId: string,
  isAdmin: boolean,
  tenantId: string | null | undefined,
): Promise<Prisma.CampaignWhereInput> {
  if (!tenantId) return { id: "__no_tenant__" };
  if (isAdmin || !teamsEnabled()) return { tenantId };
  const ids = await teamIdsForUser(userId, tenantId);
  return {
    AND: [
      { tenantId },
      {
        OR: [
          { teamId: null },
          ...(ids.length > 0 ? [{ teamId: { in: ids } }] : []),
        ],
      },
    ],
  };
}

// Quick yes/no: does this user have access to this specific campaign?
// Admins always do; TEAMS_ENABLED=false treats every campaign as
// office-wide. Used for guarding /campaigns/[id]/* routes.
export async function canSeeCampaign(
  userId: string,
  isAdmin: boolean,
  tenantId: string | null | undefined,
  campaignId: string,
): Promise<boolean> {
  if (!tenantId) return false;
  const c = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { teamId: true, tenantId: true },
  });
  if (!c) return false;
  if (c.tenantId !== tenantId) return false;
  if (isAdmin || !teamsEnabled()) return true;
  if (c.teamId === null) return true;
  const ids = await teamIdsForUser(userId, tenantId);
  return ids.includes(c.teamId);
}

// Same check, but when it's already known the campaign exists and we
// hold its teamId — skips the extra round-trip. Handy in pages that
// already fetched the full Campaign row for rendering.
export async function canSeeCampaignRow(
  userId: string,
  isAdmin: boolean,
  tenantId: string | null | undefined,
  campaignTenantId: string,
  teamId: string | null,
): Promise<boolean> {
  if (!tenantId || campaignTenantId !== tenantId) return false;
  if (isAdmin || !teamsEnabled()) return true;
  if (teamId === null) return true;
  const ids = await teamIdsForUser(userId, tenantId);
  return ids.includes(teamId);
}
