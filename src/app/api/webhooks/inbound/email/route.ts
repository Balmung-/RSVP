import { NextResponse } from "next/server";
import { ingest } from "@/lib/inbound";
import { secretMatches } from "@/lib/webhook-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Provider-agnostic inbound email webhook. Each provider (SendGrid
// Inbound Parse, Mailgun Routes, Postmark Inbound, AWS SES via Lambda)
// sends a slightly different payload — we accept multipart/form-data
// OR JSON and normalize to { from, to, subject, text, headers }.
//
// Auth: shared bearer token in x-inbound-secret. Configure
// INBOUND_WEBHOOK_SECRET on both ends. Providers that can't send a
// custom header should front this with a small relay that adds it.

export async function POST(req: Request) {
  const secret = process.env.INBOUND_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  const sent = req.headers.get("x-inbound-secret") ?? "";
  if (!secretMatches(sent, secret)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const ct = req.headers.get("content-type") ?? "";
  let from = "", to = "", subject = "", body = "", headers = "", providerId: string | null = null;

  if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
    const fd = await req.formData();
    // SendGrid Inbound Parse
    from = String(fd.get("from") ?? fd.get("sender") ?? "");
    to = String(fd.get("to") ?? fd.get("recipient") ?? "");
    subject = String(fd.get("subject") ?? "");
    body = String(fd.get("text") ?? fd.get("plain") ?? fd.get("body-plain") ?? "");
    if (!body) body = htmlToText(String(fd.get("html") ?? fd.get("body-html") ?? ""));
    headers = String(fd.get("headers") ?? fd.get("message-headers") ?? "");
    providerId = String(fd.get("Message-ID") ?? fd.get("message-id") ?? "") || null;
  } else if (ct.includes("application/json")) {
    const j = (await req.json()) as Record<string, unknown>;
    from = String((j.from as string | undefined) ?? (j.sender as string | undefined) ?? "");
    to = String((j.to as string | undefined) ?? (j.recipient as string | undefined) ?? "");
    subject = String((j.subject as string | undefined) ?? "");
    body = String((j.text as string | undefined) ?? (j.plain as string | undefined) ?? "");
    if (!body) body = htmlToText(String((j.html as string | undefined) ?? ""));
    headers = String((j.headers as string | undefined) ?? "");
    providerId = (j["Message-ID"] as string | undefined) ?? (j.messageId as string | undefined) ?? null;
  } else {
    return NextResponse.json({ ok: false, error: "unsupported_content_type" }, { status: 415 });
  }

  const fromAddress = extractEmail(from);
  const toAddress = extractEmail(to);
  if (!fromAddress) return NextResponse.json({ ok: false, error: "no_sender" }, { status: 400 });

  const outcome = await ingest({
    channel: "email",
    providerId,
    fromAddress,
    toAddress,
    subject,
    body,
    rawHeaders: headers || null,
  });
  return NextResponse.json({ ok: true, ...outcome });
}

function extractEmail(raw: string): string | null {
  const m = raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
