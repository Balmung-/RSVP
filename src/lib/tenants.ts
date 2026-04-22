import { prisma } from "./db";
import { hashPassword } from "./auth";
import { isUniqueViolation, isNotFound } from "./prisma-errors";
import {
  TENANT_ROLES,
  TENANT_ROLE_LABEL,
  canAssignTenantRole,
  canRemoveTenantMember,
  isTenantRole,
  type TenantRole,
} from "./tenant-roles";

export { TENANT_ROLES, TENANT_ROLE_LABEL };
export type { TenantRole };

export type TenantInput = {
  name: string;
  slug?: string | null;
  locale?: "en" | "ar" | null;
};

export type TenantInviteInput = {
  email: string;
  fullName?: string | null;
  role: TenantRole;
};

export type TenantMutationResult =
  | { ok: true; tenantId: string; ownerUserId: string; ownerCreated: boolean }
  | {
      ok: false;
      reason:
        | "missing_name"
        | "invalid_slug"
        | "duplicate_slug"
        | "invalid_email"
        | "weak_password"
        | "invalid_role";
    };

export type TenantInviteResult =
  | { ok: true; userId: string; created: boolean }
  | {
      ok: false;
      reason:
        | "invalid_email"
        | "weak_password"
        | "invalid_role"
        | "forbidden_role"
        | "duplicate_member";
    };

export type TenantMemberMutationResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "invalid_role"
        | "forbidden_role"
        | "not_found"
        | "last_owner";
    };

function emailOk(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50);
}

function normalizeTenantInput(input: TenantInput) {
  const name = input.name.trim().slice(0, 120);
  if (!name) return { ok: false as const, reason: "missing_name" as const };
  const slug = (input.slug?.trim() || slugify(name)).slice(0, 50);
  if (!/^[a-z0-9-]{1,50}$/.test(slug)) return { ok: false as const, reason: "invalid_slug" as const };
  return {
    ok: true as const,
    data: {
      name,
      slug,
      locale: input.locale === "ar" ? "ar" : "en",
    },
  };
}

function normalizeInviteInput(input: TenantInviteInput) {
  const email = input.email.trim().toLowerCase();
  if (!emailOk(email)) return { ok: false as const, reason: "invalid_email" as const };
  if (!isTenantRole(input.role)) return { ok: false as const, reason: "invalid_role" as const };
  return {
    ok: true as const,
    data: {
      email,
      fullName: (input.fullName ?? "").trim().slice(0, 120) || null,
      role: input.role,
    },
  };
}

export async function listTenants(opts: { includeArchived?: boolean } = {}) {
  return prisma.tenant.findMany({
    where: opts.includeArchived ? {} : { archivedAt: null },
    orderBy: [{ name: "asc" }],
    include: {
      _count: { select: { memberships: true, sessions: true } },
    },
  });
}

export async function createTenantWithOwner(
  tenantInput: TenantInput,
  ownerInput: { email: string; fullName?: string | null },
  password: string,
): Promise<TenantMutationResult> {
  const tenant = normalizeTenantInput(tenantInput);
  if (!tenant.ok) return { ok: false, reason: tenant.reason };
  const owner = normalizeInviteInput({ ...ownerInput, role: "owner" });
  if (!owner.ok) return { ok: false, reason: owner.reason };
  const existingUser = await prisma.user.findUnique({ where: { email: owner.data.email } });
  if (!existingUser && password.length < 10) return { ok: false, reason: "weak_password" };

  try {
    const hash = existingUser ? null : await hashPassword(password);
    const result = await prisma.$transaction(async (tx) => {
      const tenantRow = await tx.tenant.create({ data: tenant.data });
      const user =
        existingUser ??
        (await tx.user.create({
          data: {
            email: owner.data.email,
            passwordHash: hash!,
            mustChangePassword: true,
            fullName: owner.data.fullName,
            role: "viewer",
            active: true,
          },
        }));
      await tx.tenantMembership.create({
        data: {
          tenantId: tenantRow.id,
          userId: user.id,
          role: "owner",
        },
      });
      return { tenantId: tenantRow.id, ownerUserId: user.id, ownerCreated: !existingUser };
    });
    return { ok: true, ...result };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: "duplicate_slug" };
    throw e;
  }
}

export async function listTenantUsers(tenantId: string) {
  return prisma.tenantMembership.findMany({
    where: { tenantId },
    orderBy: [{ createdAt: "asc" }],
    select: {
      role: true,
      userId: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          email: true,
          fullName: true,
          active: true,
          lastLoginAt: true,
          role: true,
        },
      },
    },
  });
}

export async function inviteUserToTenant(
  tenantId: string,
  actorRole: TenantRole | null | undefined,
  isPlatformAdmin: boolean,
  input: TenantInviteInput,
  password: string,
): Promise<TenantInviteResult> {
  const invite = normalizeInviteInput(input);
  if (!invite.ok) return { ok: false, reason: invite.reason };
  if (!canAssignTenantRole(actorRole, invite.data.role, isPlatformAdmin)) {
    return { ok: false, reason: "forbidden_role" };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const existingMembership = await tx.tenantMembership.findFirst({
        where: { tenantId, user: { email: invite.data.email } },
        select: { userId: true },
      });
      if (existingMembership) return { ok: false as const, reason: "duplicate_member" as const };

      let user = await tx.user.findUnique({ where: { email: invite.data.email } });
      let created = false;
      if (!user) {
        if (password.length < 10) return { ok: false as const, reason: "weak_password" as const };
        user = await tx.user.create({
          data: {
            email: invite.data.email,
            passwordHash: await hashPassword(password),
            mustChangePassword: true,
            fullName: invite.data.fullName,
            role: "viewer",
            active: true,
          },
        });
        created = true;
      } else if (!user.fullName && invite.data.fullName) {
        user = await tx.user.update({
          where: { id: user.id },
          data: { fullName: invite.data.fullName },
        });
      }

      await tx.tenantMembership.create({
        data: {
          tenantId,
          userId: user.id,
          role: invite.data.role,
        },
      });
      return { ok: true as const, userId: user.id, created };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: "duplicate_member" };
    throw e;
  }
}

async function ownerCount(
  tx: { tenantMembership: { count(args: { where: { tenantId: string; role: string } }): Promise<number> } },
  tenantId: string,
): Promise<number> {
  return tx.tenantMembership.count({ where: { tenantId, role: "owner" } });
}

export async function updateTenantMemberRole(
  tenantId: string,
  userId: string,
  actorRole: TenantRole | null | undefined,
  isPlatformAdmin: boolean,
  nextRole: TenantRole,
): Promise<TenantMemberMutationResult> {
  if (!isTenantRole(nextRole)) return { ok: false, reason: "invalid_role" };

  try {
    return await prisma.$transaction(async (tx) => {
      const membership = await tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
        select: { role: true },
      });
      if (!membership || !isTenantRole(membership.role)) return { ok: false as const, reason: "not_found" as const };
      if (membership.role === nextRole) return { ok: true as const };
      if (!canAssignTenantRole(actorRole, nextRole, isPlatformAdmin)) return { ok: false as const, reason: "forbidden_role" as const };
      if (membership.role === "owner" && nextRole !== "owner" && (await ownerCount(tx, tenantId)) <= 1) {
        return { ok: false as const, reason: "last_owner" as const };
      }
      await tx.tenantMembership.update({
        where: { tenantId_userId: { tenantId, userId } },
        data: { role: nextRole },
      });
      return { ok: true as const };
    });
  } catch (e) {
    if (isNotFound(e)) return { ok: false, reason: "not_found" };
    throw e;
  }
}

export async function removeTenantMember(
  tenantId: string,
  userId: string,
  actorRole: TenantRole | null | undefined,
  isPlatformAdmin: boolean,
): Promise<TenantMemberMutationResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const membership = await tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
        select: { role: true },
      });
      if (!membership || !isTenantRole(membership.role)) return { ok: false as const, reason: "not_found" as const };
      const owners = await ownerCount(tx, tenantId);
      if (!canRemoveTenantMember(actorRole, membership.role, owners, isPlatformAdmin)) {
        return { ok: false as const, reason: membership.role === "owner" && owners <= 1 ? "last_owner" : "forbidden_role" as const };
      }
      await tx.tenantMembership.delete({
        where: { tenantId_userId: { tenantId, userId } },
      });
      return { ok: true as const };
    });
  } catch (e) {
    if (isNotFound(e)) return { ok: false, reason: "not_found" };
    throw e;
  }
}
