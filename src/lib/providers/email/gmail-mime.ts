// Pure RFC 5322 / 2822 message builder for Gmail API's
// `users.messages.send` endpoint. Takes the same shape as the
// EmailProvider interface expects and emits a base64url-encoded
// raw message ready for the `raw` field of the Gmail send request.
//
// Scope of this module:
//   - NO network, NO Prisma, NO process.env reads.
//   - Pure string-in, string-out so the test harness can cover every
//     header-building branch without fixtures.
//   - Output is already base64url; the Gmail provider passes it
//     straight into the request body.
//
// Why hand-rolled and not a MIME library:
//   Our message surface is narrow — one recipient, one subject, HTML
//   plus optional text, optional Reply-To, custom headers (List-
//   Unsubscribe in particular). Pulling in `nodemailer` or
//   `mimetext` for those ~150 lines of logic would add a dependency
//   and an auth-surface (bugs in the dep = bugs in our send path).
//   Hand-rolling keeps this file reviewable end-to-end.
//
// What gets rewritten by Gmail regardless:
//   Date, Message-ID, and the Return-Path are all rewritten by
//   Google's mail servers on send. We still emit sensible defaults
//   so the output is a valid RFC 5322 message on its own (useful
//   when stepping through a Gmail API 400 in a debugger).
//
// CRLF injection:
//   Every user-controllable header value (from, fromName, to, reply
//   To, custom header keys+values, subject source before encoding)
//   is passed through `stripCrLf`, which THROWS if any CR or LF
//   appears. This is the primary defense against an attacker using
//   a crafted display-name to append a `Bcc:` header and silently
//   exfiltrate invitations. Never weaken this check without also
//   adding a structural header-count assertion at the caller.

import { randomBytes } from "node:crypto";

export interface RawMessageInput {
  // The authenticated Gmail address this message is sent AS. Gmail
  // will 400 if `from` doesn't match the authenticated user (or one
  // of their verified send-as aliases).
  from: string;
  fromName?: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  // Optional overrides for deterministic tests.
  boundary?: string;
  messageId?: string;
  date?: Date;
}

// Entry point. Returns the base64url-encoded raw message, sized and
// encoded exactly as Gmail API expects. The caller just wraps this
// in `{raw: <return>}` and POSTs.
export function buildRawMessage(input: RawMessageInput): string {
  const raw = buildRfc5322(input);
  return b64url(Buffer.from(raw, "utf8"));
}

// Exposed for tests — lets assertions peek at header lines and
// boundary structure without decoding base64url.
export function buildRfc5322(input: RawMessageInput): string {
  const from = stripCrLf(input.from, "from");
  const fromName = input.fromName
    ? stripCrLf(input.fromName, "fromName")
    : undefined;
  const to = stripCrLf(input.to, "to");
  const subject = stripCrLf(input.subject, "subject");
  const replyTo = input.replyTo ? stripCrLf(input.replyTo, "replyTo") : undefined;

  const boundary = input.boundary ?? `=_${randomBytes(12).toString("hex")}`;
  const date = (input.date ?? new Date()).toUTCString();
  const messageId =
    input.messageId ??
    `<${randomBytes(16).toString("hex")}@${domainOf(from) || "localhost"}>`;

  const lines: string[] = [];
  lines.push(`From: ${formatAddress(from, fromName)}`);
  lines.push(`To: ${to}`);
  if (replyTo) lines.push(`Reply-To: ${replyTo}`);
  lines.push(`Subject: ${encodeHeaderValue(subject)}`);
  lines.push(`Date: ${date}`);
  lines.push(`Message-ID: ${messageId}`);
  lines.push("MIME-Version: 1.0");

  if (input.headers) {
    for (const [k, v] of Object.entries(input.headers)) {
      const key = stripCrLf(k, `header[${k}].key`);
      const val = stripCrLf(v, `header[${k}].value`);
      if (RESERVED_HEADERS.has(key.toLowerCase())) {
        // A caller passing `Subject` or `Content-Type` via the
        // headers bag is almost always a bug — the interface has
        // dedicated fields for them. Fail loudly rather than
        // silently double-emit.
        throw new Error(
          `buildRfc5322: header "${key}" is reserved; use the dedicated field instead`,
        );
      }
      lines.push(`${key}: ${val}`);
    }
  }

  // Body structure.
  if (input.text !== undefined) {
    // multipart/alternative — text first, html second. Per RFC 2046,
    // receivers SHOULD prefer the LAST part they can render, so
    // putting HTML last means modern clients show HTML and
    // fallback clients (plain-text terminals, screen readers in
    // basic mode) show text.
    lines.push(
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
    );
    lines.push("");
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: text/plain; charset="UTF-8"`);
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    lines.push(b64body(input.text));
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: text/html; charset="UTF-8"`);
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    lines.push(b64body(input.html));
    lines.push(`--${boundary}--`);
  } else {
    lines.push(`Content-Type: text/html; charset="UTF-8"`);
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    lines.push(b64body(input.html));
  }

  // RFC 5322 requires CRLF between lines AND a terminating CRLF
  // after the final line. `join` + trailing empty produces that.
  return lines.join("\r\n") + "\r\n";
}

// Headers we build ourselves. A caller stuffing any of these into
// `msg.headers` is almost certainly misusing the interface.
const RESERVED_HEADERS = new Set([
  "from",
  "to",
  "reply-to",
  "subject",
  "date",
  "message-id",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "bcc", // no silent BCCs — bcc recipients would be invisible to the audit trail
  "cc", // EmailMessage interface is single-recipient; adding CC via headers would bypass the contract
]);

function formatAddress(email: string, name?: string): string {
  if (!name) return email;
  // Display-name needs quoting if it contains any "specials" per
  // RFC 5322 (',' '(' ')' '<' '>' '[' ']' ':' ';' '@' '\' '"' space).
  // We already stripCrLf'd, so quoting is just for the specials.
  const needsQuoting = /[",()<>@[\];:\\]/.test(name);
  // Escape backslash + double-quote inside quoted-string.
  const safe = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const nameOut = needsQuoting ? `"${safe}"` : name;
  // Encode the display name if it contains non-ASCII (Arabic names,
  // accented characters). RFC 2047 encoded-word inside address
  // phrase is the standard way.
  const isAscii = /^[\x20-\x7E]*$/.test(nameOut);
  const phrase = isAscii ? nameOut : encodeHeaderValue(nameOut);
  return `${phrase} <${email}>`;
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1) : "";
}

// Encode an arbitrary UTF-8 header value using RFC 2047 encoded-word
// syntax when it contains non-ASCII. ASCII-only values pass through
// untouched so plain-English subjects stay human-readable on the
// wire.
//
// Chunking: an encoded-word MUST NOT exceed 75 chars. We target 36
// UTF-8 bytes per chunk so `=?UTF-8?B?<base64>?=` (12 overhead +
// base64(36 bytes)=48 = 60 chars) fits comfortably. Chunks are
// joined with CRLF+SP, the standard header folding continuation.
//
// Character-boundary safe: we walk the string by code point (for-of
// iterator), not by bytes, so multi-byte UTF-8 sequences are never
// split mid-codepoint.
export function encodeHeaderValue(s: string): string {
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  const MAX_BYTES = 36;
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of s) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (currentBytes + chBytes > MAX_BYTES && current.length > 0) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += ch;
    currentBytes += chBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks
    .map((c) => `=?UTF-8?B?${Buffer.from(c, "utf8").toString("base64")}?=`)
    .join("\r\n ");
}

// Reject CR or LF in any header value. Protects against header-
// injection (e.g. `\r\nBcc: attacker@x`). Throws loudly so the
// provider surface can map this to an unambiguous `ok: false` with a
// non-retryable error — retrying the same malicious input is
// pointless.
function stripCrLf(v: string, where: string): string {
  if (typeof v !== "string") {
    throw new Error(`buildRfc5322: ${where} must be a string`);
  }
  if (/[\r\n]/.test(v)) {
    throw new Error(
      `buildRfc5322: ${where} contains CR/LF (header injection attempt?)`,
    );
  }
  return v;
}

// Base64-encode a UTF-8 string and wrap at 76 chars per RFC 2045.
function b64body(content: string): string {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    out.push(b64.slice(i, i + 76));
  }
  return out.join("\r\n");
}

// Gmail API wants URL-safe base64 without padding for the `raw`
// field. Standard base64 characters `+` and `/` are NOT accepted
// there — the API 400s with "Invalid value for ByteString".
function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
