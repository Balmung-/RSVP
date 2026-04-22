export const TENANT_ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export const TENANT_ROLE_LABEL: Record<TenantRole, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  viewer: "Viewer",
};

const APP_ROLE_RANK = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 2,
} as const;

const TENANT_ROLE_RANK = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
} as const;

export function isTenantRole(value: string | null | undefined): value is TenantRole {
  return !!value && (TENANT_ROLES as readonly string[]).includes(value);
}

export function appRankForTenantRole(role: TenantRole | null | undefined): number {
  if (!role) return -1;
  return APP_ROLE_RANK[role];
}

export function tenantRank(role: TenantRole | null | undefined): number {
  if (!role) return -1;
  return TENANT_ROLE_RANK[role];
}

export function hasTenantRoleValue(
  role: TenantRole | null | undefined,
  required: TenantRole,
): boolean {
  return tenantRank(role) >= TENANT_ROLE_RANK[required];
}

export function allowedInviteRoles(
  actorRole: TenantRole | null | undefined,
  isPlatformAdmin: boolean,
): TenantRole[] {
  if (isPlatformAdmin) return [...TENANT_ROLES];
  if (actorRole === "owner") return ["admin", "editor", "viewer"];
  if (actorRole === "admin") return ["editor", "viewer"];
  return [];
}

export function canAssignTenantRole(
  actorRole: TenantRole | null | undefined,
  nextRole: TenantRole,
  isPlatformAdmin: boolean,
): boolean {
  return allowedInviteRoles(actorRole, isPlatformAdmin).includes(nextRole);
}

export function canRemoveTenantMember(
  actorRole: TenantRole | null | undefined,
  targetRole: TenantRole,
  ownerCount: number,
  isPlatformAdmin: boolean,
): boolean {
  if (targetRole === "owner" && ownerCount <= 1) return false;
  if (isPlatformAdmin) return true;
  if (actorRole === "owner") return targetRole !== "owner";
  if (actorRole === "admin") return targetRole === "editor" || targetRole === "viewer";
  return false;
}
