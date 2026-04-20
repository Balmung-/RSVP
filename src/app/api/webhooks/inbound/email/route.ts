import { NextResponse } from "next/server";
import { ingest } from "@/lib/inbound";
import { secretMatches } from "@/lib/webhook-auth";
import {
  normalizeInboundEmail,
  recordSource,
  type KeyedSource,
} from "@/lib/inbound-normalize";

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
//
// P14-H: the per-provider coalesce rules (`from | sender`, `text |
// plain | body-plain`, `Message-ID | message-id | messageId`, etc.),
// the angle-bracket email extractor, the HTML→text sanitizer, and
// the `no_sender` short-circuit all live in
// `src/lib/inbound-normalize.ts`. This route is now a thin
// dispatcher — auth, content-type sniffing, source materialization,
// `ingest()` handoff.

export async function POST(req: Request) {
  const secret = process.env.INBOUND_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ ok: false, error: "not_configured" }, { status: 503 });
  const sent = req.headers.get("x-inbound-secret") ?? "";
  if (!secretMatches(sent, secret)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const ct = req.headers.get("content-type") ?? "";
  let source: KeyedSource;
  if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
    // FormData's shape is structurally compatible with KeyedSource —
    // `get(key)` returns `FormDataEntryValue | null`, which the
    // normalizer coerces via String().
    source = await req.formData();
  } else if (ct.includes("application/json")) {
    const j = (await req.json()) as Record<string, unknown>;
    source = recordSource(j);
  } else {
    return NextResponse.json({ ok: false, error: "unsupported_content_type" }, { status: 415 });
  }

  const result = normalizeInboundEmail(source);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }

  const outcome = await ingest({
    channel: "email",
    ...result.email,
  });
  return NextResponse.json({ ok: true, ...outcome });
}
