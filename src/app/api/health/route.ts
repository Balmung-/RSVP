import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { probeRuntimeConfig } from "@/lib/ai/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Liveness probe. When HEALTH_REQUIRE_DB=true, also requires DB reachability —
// set that after you've wired DATABASE_URL, so Railway surfaces real DB
// failures instead of silently serving 500s.
//
// The `ai` block reports whether the selected AI backend has its env
// wired. It does NOT probe the provider network-side (that would make
// liveness checks a DoS vector and cost money on every ping). Ops can
// curl this after a deploy to confirm the env was picked up without
// having to drive a real `/api/chat` request.
export async function GET() {
  let db: "up" | "down" = "down";
  let dbError: string | undefined;
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = "up";
  } catch (e) {
    dbError = String(e).slice(0, 200);
  }
  const strict = process.env.HEALTH_REQUIRE_DB === "true";
  const status = strict && db === "down" ? 503 : 200;
  return NextResponse.json(
    {
      ok: !strict || db === "up",
      db,
      dbError,
      email: process.env.EMAIL_PROVIDER ?? "stub",
      sms: process.env.SMS_PROVIDER ?? "stub",
      ai: probeRuntimeConfig(),
    },
    { status },
  );
}
