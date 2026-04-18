import { Prisma } from "@prisma/client";

// Thin Prisma-error classifiers. The app's mutation helpers used to
// substring-match `String(e)` — brittle across Prisma upgrades and
// inconsistent across locales if the message text ever changes. These
// helpers key on Prisma's stable error codes instead.
//
// - P2002: unique constraint violation (create / update)
// - P2025: record to update/delete not found

export function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002"
  );
}

export function isNotFound(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025"
  );
}
