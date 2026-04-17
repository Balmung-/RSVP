import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Liveness probe — always 200 if the process can respond. DB state is
// reported in the body so a missing DATABASE_URL does not block first boot.
export async function GET() {
  let db: "up" | "down" = "down";
  let dbError: string | undefined;
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = "up";
  } catch (e) {
    dbError = String(e).slice(0, 200);
  }
  return NextResponse.json({
    ok: true,
    db,
    dbError,
    email: process.env.EMAIL_PROVIDER ?? "stub",
    sms: process.env.SMS_PROVIDER ?? "stub",
  });
}
