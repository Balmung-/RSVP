import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { ingest } from "@/lib/inbound";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Inbound SMS webhook. Twilio posts application/x-www-form-urlencoded
// with From, To, Body, MessageSid. Unifonic / Msegat shapes are roughly
// the same — configure them to post to this URL.
//
// Auth: shared bearer in x-inbound-secret. Providers that can't send
// a header can include it as a query string secret (?key=<token>) too.

export async function POST(req: Request) {
  const secret = process.env.INBOUND_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });

  const url = new URL(req.url);
  const sent = req.headers.get("x-inbound-secret") ?? url.searchParams.get("key") ?? "";
  const a = Buffer.from(sent);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const fd = await req.formData();
  const from = String(fd.get("From") ?? fd.get("from") ?? fd.get("sender") ?? "");
  const to = String(fd.get("To") ?? fd.get("to") ?? fd.get("recipient") ?? "");
  const body = String(fd.get("Body") ?? fd.get("body") ?? fd.get("message") ?? "");
  const providerId = String(fd.get("MessageSid") ?? fd.get("messageId") ?? "") || null;
  if (!from || !body) return NextResponse.json({ ok: false, error: "missing_fields" }, { status: 400 });

  const outcome = await ingest({
    channel: "sms",
    providerId,
    fromAddress: from,
    toAddress: to || null,
    body,
    subject: null,
    rawHeaders: null,
  });
  return NextResponse.json({ ok: true, ...outcome });
}
