import type { Prisma } from "@prisma/client";
import { prisma } from "./db";

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

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50);
}

export async function createTeam(input: TeamInput): Promise<TeamMutationResult> {
  const name = input.name.trim().slice(0, 100);
  if (!name) return { ok: false, reason: "missing_name" };
  const slug = input.slug?.trim() || slugify(name);
  if (!/^[a-z0-9-]{1,50}$/.test(slug)) return { ok: false, reason: "invalid_slug" };
  const color = input.color && /^#[0-9A-Fa-f]{3,8}$/.test(input.color) ? input.color : null;
  try {
    const row = await prisma.team.create({
      data: {
        name,
        slug,
        color,
        description: (input.description ?? "").trim().slice(0, 500) || null,
      },
    });
    return { ok: true, teamId: row.id };
  } catch (e) {
    if (String(e).includes("Unique constraint")) return { ok: false, reason: "duplicate" };
    throw e;
  }
}

export async function updateTeam(teamId: string, input: TeamInput): Promise<TeamMutationResult> {
  const name = input.name.trim().slice(0, 100);
  if (!name) return { ok: false, reason: "missing_name" };
  const slug = input.slug?.trim() || slugify(name);
  if (!/^[a-z0-9-]{1,50}$/.test(slug)) return { ok: false, reason: "invalid_slug" };
  const color = input.color && /^#[0-9A-Fa-f]{3,8}$/.test(input.color) ? input.color : null;
  try {
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
    if (String(e).includes("Unique constraint")) return { ok: false, reason: "duplicate" };
    if (String(e).includes("Record to update not found")) return { ok: false, reason: "not_found" };
    throw e;
  }
}

export async function archiveTeam(teamId: string) {
  await prisma.team.update({ where: { id: teamId }, data: { archivedAt: new Date() } });
}

export async function unarchiveTeam(teamId: string) {
  await prisma.team.update({ where: { id: teamId }, data: { archivedAt: null } });
}

export async function deleteTeamRecord(teamId: string) {
  await prisma.team.delete({ where: { id: teamId } });
}

export async function listTeams(opts: { includeArchived?: boolean } = {}) {
  return prisma.team.findMany({
    where: opts.includeArchived ? {} : { archivedAt: null },
    orderBy: [{ name: "asc" }],
    include: {
      _count: { select: { memberships: true, campaigns: true } },
    },
  });
}

export async function addMember(teamId: string, userId: string, role: TeamRole) {
  return prisma.teamMembership.upsert({
    where: { teamId_userId: { teamId, userId } },
    create: { teamId, userId, role },
    update: { role },
  });
}

export async function removeMember(teamId: string, userId: string) {
  await prisma.teamMembership.deleteMany({ where: { teamId, userId } });
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
export async function teamIdsForUser(userId: string): Promise<string[]> {
  const rows = await prisma.teamMembership.findMany({
    where: { userId },
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
): Promise<Prisma.CampaignWhereInput> {
  if (isAdmin || !teamsEnabled()) return {};
  const ids = await teamIdsForUser(userId);
  return {
    OR: [
      { teamId: null },
      ...(ids.length > 0 ? [{ teamId: { in: ids } }] : []),
    ],
  };
}

// Quick yes/no: does this user have access to this specific campaign?
// Admins always do; TEAMS_ENABLED=false treats every campaign as
// office-wide. Used for guarding /campaigns/[id]/* routes.
export async function canSeeCampaign(
  userId: string,
  isAdmin: boolean,
  campaignId: string,
): Promise<boolean> {
  if (isAdmin || !teamsEnabled()) return true;
  const c = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { teamId: true },
  });
  if (!c) return false;
  if (c.teamId === null) return true;
  const ids = await teamIdsForUser(userId);
  return ids.includes(c.teamId);
}

// Same check, but when it's already known the campaign exists and we
// hold its teamId — skips the extra round-trip. Handy in pages that
// already fetched the full Campaign row for rendering.
export async function canSeeCampaignRow(
  userId: string,
  isAdmin: boolean,
  teamId: string | null,
): Promise<boolean> {
  if (isAdmin || !teamsEnabled()) return true;
  if (teamId === null) return true;
  const ids = await teamIdsForUser(userId);
  return ids.includes(teamId);
}
