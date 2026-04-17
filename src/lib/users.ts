import { prisma } from "./db";
import { hashPassword, type Role, ROLES } from "./auth";

export type UserInput = {
  email: string;
  fullName?: string | null;
  role: Role;
  active?: boolean;
};

export type UserMutationResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid_email" | "duplicate_email" | "invalid_role" | "not_found" | "weak_password" };

function emailOk(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
}

export async function listUsers() {
  return prisma.user.findMany({
    orderBy: [{ active: "desc" }, { email: "asc" }],
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      active: true,
      createdAt: true,
      lastLoginAt: true,
    },
  });
}

export async function createUser(input: UserInput, password: string): Promise<UserMutationResult> {
  const email = input.email.trim().toLowerCase();
  if (!emailOk(email)) return { ok: false, reason: "invalid_email" };
  if (!(ROLES as readonly string[]).includes(input.role)) return { ok: false, reason: "invalid_role" };
  if (password.length < 10) return { ok: false, reason: "weak_password" };
  try {
    const hash = await hashPassword(password);
    const u = await prisma.user.create({
      data: {
        email,
        passwordHash: hash,
        mustChangePassword: true, // first login forces a self-set password
        fullName: (input.fullName ?? "").trim().slice(0, 120) || null,
        role: input.role,
        active: input.active ?? true,
      },
    });
    return { ok: true, userId: u.id };
  } catch (e) {
    if (String(e).includes("Unique constraint")) return { ok: false, reason: "duplicate_email" };
    throw e;
  }
}

export async function updateUser(
  userId: string,
  input: UserInput,
): Promise<UserMutationResult> {
  const email = input.email.trim().toLowerCase();
  if (!emailOk(email)) return { ok: false, reason: "invalid_email" };
  if (!(ROLES as readonly string[]).includes(input.role)) return { ok: false, reason: "invalid_role" };
  try {
    await prisma.user.update({
      where: { id: userId },
      data: {
        email,
        fullName: (input.fullName ?? "").trim().slice(0, 120) || null,
        role: input.role,
        active: input.active ?? true,
      },
    });
    return { ok: true, userId };
  } catch (e) {
    if (String(e).includes("Unique constraint")) return { ok: false, reason: "duplicate_email" };
    if (String(e).includes("Record to update not found")) return { ok: false, reason: "not_found" };
    throw e;
  }
}

export async function resetPassword(userId: string, newPassword: string): Promise<UserMutationResult> {
  if (newPassword.length < 10) return { ok: false, reason: "weak_password" };
  const hash = await hashPassword(newPassword);
  // Admin-driven reset forces the user to change it on next sign-in.
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: hash, mustChangePassword: true },
  });
  await prisma.session.deleteMany({ where: { userId } });
  return { ok: true, userId };
}

export async function deactivateUser(userId: string) {
  await prisma.user.update({ where: { id: userId }, data: { active: false } });
  await prisma.session.deleteMany({ where: { userId } });
}

export async function deleteUser(userId: string) {
  await prisma.user.delete({ where: { id: userId } });
}
