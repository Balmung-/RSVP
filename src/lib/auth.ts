import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { prisma } from "./db";
import type { User } from "@prisma/client";
import { appRankForTenantRole, hasTenantRoleValue, isTenantRole, type TenantRole } from "./tenant-roles";

// Auth surface — tight + swappable. The rest of the app only talks to
// getCurrentUser / requireUser / hasRole / startSession / endSession.
// Passwords use node:crypto scrypt (no native deps, works on Alpine).

export const ROLES = ["admin", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];
export type AuthUser = User & {
  activeTenantId: string | null;
  activeTenantName: string | null;
  activeTenantSlug: string | null;
  activeTenantRole: TenantRole | null;
};

const COOKIE = "einai_sid";
const SESSION_DAYS = 14;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

// Password hashing --------------------------------------------------

export function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16);
    scrypt(
      password,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      (err, derived) => {
        if (err) return reject(err);
        resolve(`scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${derived.toString("hex")}`);
      },
    );
  });
}

export function verifyPassword(password: string, stored: string): Promise<boolean> {
  return new Promise((resolve) => {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return resolve(false);
    const [, nS, rS, pS, saltHex, hashHex] = parts;
    const N = Number(nS), r = Number(rS), p = Number(pS);
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    scrypt(password, salt, expected.length, { N, r, p }, (err, derived) => {
      if (err) return resolve(false);
      resolve(expected.length === derived.length && timingSafeEqual(expected, derived));
    });
  });
}

// Cookie signing ----------------------------------------------------

function sign(value: string): string {
  const secret = process.env.SESSION_SECRET ?? "dev-secret";
  return createHmac("sha256", secret).update(value).digest("hex");
}

function pack(sid: string): string {
  return `${sid}.${sign(sid)}`;
}

function unpack(raw: string | undefined): string | null {
  if (!raw) return null;
  const idx = raw.indexOf(".");
  if (idx < 0) return null;
  const sid = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);
  const expected = sign(sid);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return sid;
}

// Session CRUD ------------------------------------------------------

export async function startSession(userId: string, meta: { ip?: string; userAgent?: string }) {
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  const firstMembership = await prisma.tenantMembership.findFirst({
    where: { userId, tenant: { archivedAt: null } },
    orderBy: [{ createdAt: "asc" }],
    select: { tenantId: true },
  });
  const session = await prisma.session.create({
    data: {
      userId,
      activeTenantId: firstMembership?.tenantId ?? null,
      expiresAt,
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 300),
    },
  });
  await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  cookies().set(COOKIE, pack(session.id), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
  return session.id;
}

export async function endSession() {
  const raw = cookies().get(COOKIE)?.value;
  const sid = unpack(raw);
  if (sid) {
    await prisma.session.deleteMany({ where: { id: sid } });
  }
  cookies().set(COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

// Current user lookup ----------------------------------------------

// Request-scoped cache via React — multiple components in one render share
// a single DB lookup, and different requests get their own call.
export const getCurrentUser = cache(async (): Promise<AuthUser | null> => {
  const raw = cookies().get(COOKIE)?.value;
  const sid = unpack(raw);
  if (!sid) return null;
  const session = await prisma.session.findUnique({
    where: { id: sid },
    include: {
      user: true,
      activeTenant: { select: { id: true, name: true, slug: true, archivedAt: true } },
    },
  });
  if (!session || session.expiresAt < new Date() || !session.user.active) return null;
  let activeTenantId = session.activeTenant?.archivedAt ? null : session.activeTenant?.id ?? null;
  let activeTenantName = session.activeTenant?.archivedAt ? null : session.activeTenant?.name ?? null;
  let activeTenantSlug = session.activeTenant?.archivedAt ? null : session.activeTenant?.slug ?? null;
  let activeTenantRole: TenantRole | null = null;

  if (activeTenantId) {
    const membership = await prisma.tenantMembership.findUnique({
      where: { tenantId_userId: { tenantId: activeTenantId, userId: session.userId } },
      select: { role: true },
    });
    activeTenantRole = membership && isTenantRole(membership.role) ? membership.role : null;
  }

  if (!activeTenantId) {
    const fallback = await prisma.tenantMembership.findFirst({
      where: { userId: session.userId, tenant: { archivedAt: null } },
      orderBy: [{ createdAt: "asc" }],
      select: { role: true, tenant: { select: { id: true, name: true, slug: true } } },
    });
    if (fallback && isTenantRole(fallback.role)) {
      activeTenantId = fallback.tenant.id;
      activeTenantName = fallback.tenant.name;
      activeTenantSlug = fallback.tenant.slug;
      activeTenantRole = fallback.role;
    }
  }

  return Object.assign(session.user, {
    activeTenantId,
    activeTenantName,
    activeTenantSlug,
    activeTenantRole,
  });
});

// Capability checks ------------------------------------------------

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

export function hasPlatformRole(user: Pick<User, "role"> | null | undefined, role: Role): boolean {
  if (!user) return false;
  const r = user.role as Role;
  return (ROLE_RANK[r] ?? -1) >= ROLE_RANK[role];
}

export function hasRole(
  user: (Pick<User, "role"> & { activeTenantRole?: TenantRole | null }) | null | undefined,
  role: Role,
): boolean {
  if (!user) return false;
  if (hasPlatformRole(user, role)) return true;
  if (role === "admin") return false;
  return appRankForTenantRole(user.activeTenantRole ?? null) >= ROLE_RANK[role];
}

export function hasTenantRole(
  user: (Pick<User, "role"> & { activeTenantRole?: TenantRole | null }) | null | undefined,
  role: TenantRole,
): boolean {
  if (!user) return false;
  if (hasPlatformRole(user, "admin")) return true;
  return hasTenantRoleValue(user.activeTenantRole ?? null, role);
}

export async function isAuthed(): Promise<boolean> {
  return (await getCurrentUser()) !== null;
}

// Gate a server action or page on a minimum role. Redirects to /login if
// unauthenticated; redirects to / if authenticated but under-privileged.
// Returns the user so callers can attribute logs.
export async function requireRole(role: Role): Promise<AuthUser> {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  if (!hasRole(u, role)) redirect("/chat");
  return u;
}

export async function requireTenantRole(role: TenantRole): Promise<AuthUser> {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  if (!u.activeTenantId) redirect("/tenants");
  if (!hasTenantRole(u, role)) redirect("/chat");
  return u;
}

export async function requirePlatformAdmin(): Promise<AuthUser> {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  if (!hasPlatformRole(u, "admin")) redirect("/chat");
  return u;
}

export function requireActiveTenantId(user: { activeTenantId?: string | null }): string {
  if (!user.activeTenantId) redirect("/tenants");
  return user.activeTenantId;
}

export function activeTenantIdOf(user: { activeTenantId?: string | null } | null | undefined): string | null {
  return user?.activeTenantId ?? null;
}

export async function setActiveTenant(tenantId: string): Promise<boolean> {
  const raw = cookies().get(COOKIE)?.value;
  const sid = unpack(raw);
  if (!sid) return false;
  const session = await prisma.session.findUnique({
    where: { id: sid },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date() || !session.user.active) return false;
  const exists = hasPlatformRole(session.user, "admin")
    ? await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } })
    : await prisma.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId: session.userId } },
        select: { tenantId: true },
      });
  if (!exists) return false;
  await prisma.session.update({
    where: { id: sid },
    data: { activeTenantId: tenantId },
  });
  return true;
}

// Bootstrap --------------------------------------------------------

// On first login attempt with no users, seed a root admin using the
// ADMIN_PASSWORD env. Keeps existing deployments working; after one admin is
// created, the env is ignored.
export async function ensureBootstrapAdmin(): Promise<void> {
  const existing = await prisma.user.count();
  if (existing > 0) return;
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return;
  const hash = await hashPassword(pw);
  // Upsert so two concurrent first-logins can't race on the unique index.
  await prisma.user.upsert({
    where: { email: "admin@local" },
    create: {
      email: "admin@local",
      passwordHash: hash,
      fullName: "Root admin",
      role: "admin",
      active: true,
    },
    update: {},
  });
}

// Credential check — returns the user or null. Does not issue a session.
export async function authenticateWithPassword(
  email: string,
  password: string,
): Promise<User | null> {
  await ensureBootstrapAdmin();
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user || !user.active || !user.passwordHash) return null;
  const ok = await verifyPassword(password, user.passwordHash);
  return ok ? user : null;
}

// --- Pending-2FA handshake -----------------------------------------

// After password succeeds but before the session is issued, we stash the
// user id in a short-lived signed cookie. The /login?step=2fa page reads
// it, verifies the TOTP code, then calls startSession.

const PENDING_COOKIE = "einai_pending";
const PENDING_TTL = 5 * 60 * 1000;

export function issuePending(userId: string) {
  const ts = String(Date.now());
  const payload = `${userId}:${ts}`;
  const token = `${payload}.${sign(payload)}`;
  cookies().set(PENDING_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 300,
  });
}

export function readPending(): string | null {
  const raw = cookies().get(PENDING_COOKIE)?.value;
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const [userId, tsRaw] = payload.split(":");
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || Date.now() - ts > PENDING_TTL) return null;
  return userId;
}

export function clearPending() {
  cookies().set(PENDING_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}
