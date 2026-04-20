// Pure provider-normalization for inbound webhooks. Extracted from
// the two route handlers at `src/app/api/webhooks/inbound/email/route.ts`
// and `.../sms/route.ts` so the key-priority coalescing rules, the
// HTML→text sanitizer, the angle-bracket email extractor, and the
// missing-field short-circuits are unit-testable without Next's
// `Request` / `FormData` machinery and without prisma (both routes
// finish by calling `ingest()`, which writes invitee state).
//
// This is a provider-fanout layer. SendGrid Inbound Parse, Mailgun
// Routes, Postmark Inbound, AWS SES (via Lambda), and Twilio /
// Unifonic / Msegat all send slightly different payload shapes —
// different casing, different field names, sometimes different
// content types. The shared discipline is: give every inbound
// channel ONE normalized shape that `ingest()` can consume, no
// matter which provider is upstream.
//
// Regression surface this file guards:
//
//   1. Key-priority drift. Every coalesce chain (`from | sender`,
//      `text | plain | body-plain`, `Message-ID | message-id |
//      messageId`, etc.) is a chain where a silent swap of ordering
//      would change which provider's field wins when both are
//      present. That's bad: the wrong source column can land a
//      garbage `fromAddress` that then fails to match any invitee.
//
//   2. `extractEmail` regex bounds. The angle-bracket regex is the
//      only mechanism that turns `"Jane Doe <jane@x.com>"` into a
//      clean `jane@x.com` for the DB. A loosening (e.g., dropping
//      `{2,}` on the TLD) would let `"no@tld"` through; a
//      tightening (e.g., requiring a specific TLD set) would drop
//      legit addresses. Also: the lowercasing is load-bearing —
//      invitee matching is case-sensitive at the DB layer.
//
//   3. `htmlToText` regex pipeline. The order of replacements
//      matters: `<br>` → `\n` MUST run before the generic tag strip
//      (`<[^>]+>`), and entity decode MUST run AFTER tag strip
//      (otherwise `&lt;script&gt;` would survive as `<script>` and
//      re-enter the tag-strip pass too late). A re-ordering cleanup
//      could silently corrupt every HTML-only message's text body.
//
//   4. `no_sender` / `missing_fields` short-circuit. Both refusal
//      shapes must continue to be the EXACT strings the route
//      renders to the provider — a typo or rename here breaks
//      provider webhooks silently (providers don't always surface
//      the error body, just the status).
//
// Behavioral note — minor widening on JSON sources. The pre-
// extraction code had split priority lists (form path could try
// `body-plain`, JSON path couldn't; form path could try `message-
// headers`, JSON path couldn't). The unified lists here are a
// strict superset: form behavior is unchanged, JSON sources may
// now pick up `body-plain` / `message-headers` / `message-id`
// if a provider happens to send those keys in a JSON payload.
// This is a widening, not a narrowing — existing JSON senders are
// unaffected, new ones get more fallback coverage. Pinned by the
// "widening is a strict superset" test in the pin set.

// A minimal shape both `FormData` and our `recordSource` adapter
// satisfy. FormData.get returns `FormDataEntryValue | null`
// (where FormDataEntryValue = string | File); our record adapter
// returns `string | null`. Using `unknown` as the return type
// keeps the interface assignable from both without coercion
// leakage into the type layer — the String() coerce happens
// inside `pickFirst` where it's safe.
export type KeyedSource = {
  get(key: string): unknown;
};

// Wraps a JSON-parsed record into a KeyedSource. Used by the email
// route when content-type is `application/json`. Coerces `undefined`
// (missing key) to `null` so the coalesce semantics match FormData
// (where missing key also yields null).
export function recordSource(r: Record<string, unknown>): KeyedSource {
  return {
    get(key) {
      const v = r[key];
      return v === undefined ? null : v;
    },
  };
}

// First-non-null coalesce across a priority list. Mirrors the
// chained `??` from the pre-extraction routes:
//   `String(fd.get("from") ?? fd.get("sender") ?? "")`
//   ↓
//   `pickFirst(source, ["from", "sender"])`
//
// Empty string DOES NOT fall through (`??` only coalesces null/
// undefined). If an upstream form POSTs `from=` (empty), this
// returns `""` — the caller then decides whether that constitutes
// "missing". That matches the route's `extractEmail("") === null`
// → `no_sender` short-circuit exactly.
export function pickFirst(source: KeyedSource, keys: readonly string[]): string {
  for (const k of keys) {
    const v = source.get(k);
    if (v !== null && v !== undefined) return String(v);
  }
  return "";
}

// Extract a bare email address from a raw `From:` value that might
// be in RFC 5322 form (`"Name Surname" <user@host>`) or bare. Returns
// lowercased match or null. The regex anchors on the at-sign and
// requires a 2+ char TLD so free-form prose with an "@" symbol
// doesn't match (e.g., tweets with `@handle` style).
//
// Case discipline: the DB stores invitee emails lowercase, so
// matching is case-sensitive on the DB side — upstream senders
// that preserve case (Outlook, some Android mail clients) would
// otherwise miss. `.toLowerCase()` here is load-bearing.
export function extractEmail(raw: string): string | null {
  const m = raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

// Strip HTML to a plain-text approximation suitable for intent
// classification. Order matters:
//
//   1. Strip `<style>...</style>` and `<script>...</script>` blocks
//      INCLUDING their contents (otherwise CSS rules / JS code
//      would leak into the body as text).
//   2. Convert `<br>` → `\n` and `</p>` → `\n\n` BEFORE the
//      generic tag strip — otherwise the generic strip eats them
//      both and all paragraph structure collapses to a single
//      line.
//   3. Generic tag strip (`<[^>]+>` → ``).
//   4. Entity decode — `&amp;` / `&lt;` / etc. Must run AFTER the
//      tag strip, otherwise an encoded-tag like `&lt;script&gt;`
//      would decode to `<script>` and survive a pass that already
//      happened (we only do tag-strip once).
//   5. Normalize line endings (`\r\n` → `\n`) and collapse 3+
//      consecutive newlines to two (paragraph break). Trim leading
//      and trailing whitespace.
export function htmlToText(html: string): string {
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

// ---------------------------------------------------------------
// Email — normalized shape + coalesce-chain pinned here.
// ---------------------------------------------------------------

const EMAIL_FROM_KEYS = ["from", "sender"] as const;
const EMAIL_TO_KEYS = ["to", "recipient"] as const;
const EMAIL_SUBJECT_KEYS = ["subject"] as const;
const EMAIL_BODY_KEYS = ["text", "plain", "body-plain"] as const;
const EMAIL_HTML_KEYS = ["html", "body-html"] as const;
const EMAIL_HEADERS_KEYS = ["headers", "message-headers"] as const;
// Three acceptable Message-ID conventions — kebab for form (SendGrid
// / Mailgun), camel for JSON (Postmark), and the case-preserved RFC-
// 5322 spelling. Priority: case-preserved first (most providers
// respect it), kebab second (form-centric), camel third (JSON-
// centric).
const EMAIL_PROVIDER_ID_KEYS = ["Message-ID", "message-id", "messageId"] as const;

export type NormalizedInboundEmail = {
  fromAddress: string; // already through extractEmail + lowercased
  toAddress: string | null; // null when no recipient or extraction fails
  subject: string;
  body: string;
  rawHeaders: string | null;
  providerId: string | null;
};

// Refusal shape: a `no_sender` error if we can't extract a clean
// address from the `from` / `sender` fields. This is the SAME
// literal the route returns to the provider — do not rename
// without coordinating with every provider config that might be
// alerting on the status + body combo.
export type NormalizeEmailError = "no_sender";

export function normalizeInboundEmail(
  source: KeyedSource,
):
  | { ok: true; email: NormalizedInboundEmail }
  | { ok: false; error: NormalizeEmailError } {
  const fromRaw = pickFirst(source, EMAIL_FROM_KEYS);
  const toRaw = pickFirst(source, EMAIL_TO_KEYS);
  const subject = pickFirst(source, EMAIL_SUBJECT_KEYS);
  let body = pickFirst(source, EMAIL_BODY_KEYS);
  if (!body) {
    // HTML-only fallback. Empty-string body (not JUST null body)
    // triggers this — matches the pre-extract `if (!body)` check
    // where `""` is falsy. A sender providing only `html` but no
    // `text` reliably lands here.
    body = htmlToText(pickFirst(source, EMAIL_HTML_KEYS));
  }
  const headersRaw = pickFirst(source, EMAIL_HEADERS_KEYS);
  const providerIdRaw = pickFirst(source, EMAIL_PROVIDER_ID_KEYS);

  const fromAddress = extractEmail(fromRaw);
  if (!fromAddress) return { ok: false, error: "no_sender" };
  // toAddress is best-effort — if the recipient header is malformed
  // we still ingest the message (token extraction from body can
  // still route it to the right invitee).
  const toAddress = extractEmail(toRaw);

  return {
    ok: true,
    email: {
      fromAddress,
      toAddress,
      subject,
      body,
      rawHeaders: headersRaw || null,
      providerId: providerIdRaw || null,
    },
  };
}

// ---------------------------------------------------------------
// SMS — same discipline, narrower scope. Twilio is the canonical
// shape (PascalCase `From` / `To` / `Body` / `MessageSid`);
// Unifonic / Msegat / others typically mirror it but can send
// lowercase variants.
// ---------------------------------------------------------------

// Twilio's shape wins the priority fight because it's the most
// common upstream; lowercase is the de-facto fallback, `sender`
// / `recipient` / `message` / `messageId` are hedges for non-
// Twilio providers.
const SMS_FROM_KEYS = ["From", "from", "sender"] as const;
const SMS_TO_KEYS = ["To", "to", "recipient"] as const;
const SMS_BODY_KEYS = ["Body", "body", "message"] as const;
const SMS_PROVIDER_ID_KEYS = ["MessageSid", "messageId"] as const;

export type NormalizedInboundSms = {
  fromAddress: string;
  toAddress: string | null;
  body: string;
  providerId: string | null;
};

export type NormalizeSmsError = "missing_fields";

export function normalizeInboundSms(
  source: KeyedSource,
):
  | { ok: true; sms: NormalizedInboundSms }
  | { ok: false; error: NormalizeSmsError } {
  const from = pickFirst(source, SMS_FROM_KEYS);
  const to = pickFirst(source, SMS_TO_KEYS);
  const body = pickFirst(source, SMS_BODY_KEYS);
  const providerIdRaw = pickFirst(source, SMS_PROVIDER_ID_KEYS);
  if (!from || !body) return { ok: false, error: "missing_fields" };
  return {
    ok: true,
    sms: {
      fromAddress: from,
      toAddress: to || null,
      body,
      providerId: providerIdRaw || null,
    },
  };
}
