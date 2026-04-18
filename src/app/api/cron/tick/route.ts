import { NextResponse } from "next/server";
import { dispatchDueStages } from "@/lib/stages";
import { maybeSendDailyDigest } from "@/lib/digest";
import { secretMatches } from "@/lib/webhook-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Protected cron endpoint. Any external scheduler — Railway cron, Vercel cron,
// cron-job.org, GitHub Actions — can hit this on a minute-ish cadence.
// Auth: bearer token compared in constant time. Required in prod.

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}

async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  }
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : req.headers.get("x-cron-token") ?? "";
  if (!secretMatches(token, secret)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const start = Date.now();
  const result = await dispatchDueStages();
  // Idempotent — only fires when the admin's local digest hour has
  // passed and no digest.sent row exists for today.
  const digest = await maybeSendDailyDigest();
  return NextResponse.json({
    ok: true,
    considered: result.considered,
    ran: result.ran,
    digest,
    ms: Date.now() - start,
  });
}
