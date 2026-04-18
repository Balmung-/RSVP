import { NextResponse } from "next/server";
import { ingest } from "@/lib/inbound";
import { secretMatches } from "@/lib/webhook-auth";

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

  // Some SMS providers (Twilio Studio, older Unifonic configs) can only
  // post to a plain URL and can't add a custom header; we accept the
  // secret via ?key= as a last resort. It will land in access logs, so
  // prefer a header whenever the provider supports it.
  const url = new URL(req.url);
  const sent = req.headers.get("x-inbound-secret") ?? url.searchParams.get("key") ?? "";
  if (!secretMatches(sent, secret)) {
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
