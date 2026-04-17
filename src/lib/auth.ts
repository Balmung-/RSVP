import { cookies } from "next/headers";
import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { prisma } from "./db";
import type { User } from "@prisma/client";

// Auth surface — tight + swappable. The rest of the app only talks to
// getCurrentUser / requireUser / hasRole / startSession / endSession.
// Passwords use node:crypto scrypt (no native deps, works on Alpine).

export const ROLES = ["admin", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

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
  const session = await prisma.session.create({
    data: { userId, expiresAt, ip: meta.ip, userAgent: meta.userAgent?.slice(0, 300) },
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

let cacheUser: { key: string; at: number; user: User | null } | null = null;

export async function getCurrentUser(): Promise<User | null> {
  const raw = cookies().get(COOKIE)?.value;
  const sid = unpack(raw);
  if (!sid) return null;
  // Cache per-request to avoid repeated DB hits within one render. Cache is
  // process-local and short (keyed by sid), fine under Next's request-scoped
  // server components.
  if (cacheUser && cacheUser.key === sid && Date.now() - cacheUser.at < 2000) {
    return cacheUser.user;
  }
  const session = await prisma.session.findUnique({
    where: { id: sid },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date() || !session.user.active) {
    cacheUser = { key: sid, at: Date.now(), user: null };
    return null;
  }
  cacheUser = { key: sid, at: Date.now(), user: session.user };
  return session.user;
}

// Capability checks ------------------------------------------------

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

export function hasRole(user: User | null | undefined, role: Role): boolean {
  if (!user) return false;
  const r = user.role as Role;
  return (ROLE_RANK[r] ?? -1) >= ROLE_RANK[role];
}

export async function isAuthed(): Promise<boolean> {
  return (await getCurrentUser()) !== null;
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
  await prisma.user.create({
    data: {
      email: "admin@local",
      passwordHash: hash,
      fullName: "Root admin",
      role: "admin",
      active: true,
    },
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
