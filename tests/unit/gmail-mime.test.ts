import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildRawMessage,
  buildRfc5322,
  encodeHeaderValue,
} from "../../src/lib/providers/email/gmail-mime";

// Pins the RFC 5322 builder contract. The Gmail provider passes
// `buildRawMessage`'s output straight into Gmail API's `raw` field;
// any drift in the produced string = a silent 400 from Google at
// the worst possible time (during a real send). These tests
// hand-examine the intermediate RFC 5322 text (via `buildRfc5322`,
// exposed for exactly this purpose) and also assert the final
// base64url envelope is valid.
//
// What we're specifically guarding:
//   (1) Subject encoding — plain ASCII passes through, non-ASCII
//       (Arabic, accented) becomes an RFC 2047 encoded-word. The
//       protocol office's invitations are often Arabic; if this
//       test regresses, recipients see `=?garbled?= mojibake` in
//       their inbox.
//   (2) Multi-chunk encoded-words for long non-ASCII subjects —
//       the 75-char-per-word limit is strict; a long Arabic subject
//       must split into multiple encoded-words joined by CRLF+SP
//       (standard header folding).
//   (3) Body structure — html-only is a single text/html part;
//       html+text is a multipart/alternative with boundaries. Order
//       matters: text first, html last, because RFC 2046 says
//       receivers prefer the LAST renderable alternative.
//   (4) CRLF injection rejection — a `\n` in any user-controlled
//       field (from/fromName/to/replyTo/subject/custom headers)
//       throws. This is the single most important security guard
//       in the module; if someone regresses it, an attacker with
//       control over a display name could inject a Bcc.
//   (5) Reserved-header rejection — a caller stuffing `Subject`
//       into the custom `headers` bag would otherwise produce a
//       duplicate Subject header. Throw instead of silently sending
//       a malformed message.
//   (6) base64url output — Gmail API's `raw` field requires URL-
//       safe base64 without padding. Any `+`, `/`, or `=` = 400.

const FIXED_BOUNDARY = "=_test_boundary_0123";
const FIXED_MESSAGE_ID = "<fixed@example.test>";
const FIXED_DATE = new Date(Date.UTC(2024, 2, 18, 12, 34, 56));

function header(raw: string, name: string): string | null {
  // Case-insensitive header pick from the top of the RFC 5322
  // message. Stops at the first empty line (header/body separator).
  const lines = raw.split("\r\n");
  const lower = name.toLowerCase();
  for (const line of lines) {
    if (line === "") return null;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    if (line.slice(0, colon).toLowerCase() === lower) {
      return line.slice(colon + 1).trim();
    }
  }
  return null;
}

test("buildRfc5322 emits plain-ASCII subject unchanged", () => {
  const raw = buildRfc5322({
    from: "sender@example.gov.sa",
    to: "recipient@example.com",
    subject: "Invitation to the 3pm briefing",
    html: "<p>See you there.</p>",
    boundary: FIXED_BOUNDARY,
    messageId: FIXED_MESSAGE_ID,
    date: FIXED_DATE,
  });
  assert.equal(header(raw, "Subject"), "Invitation to the 3pm briefing");
});

test("buildRfc5322 encodes Arabic subject as RFC 2047 encoded-word", () => {
  const raw = buildRfc5322({
    from: "sender@example.gov.sa",
    to: "recipient@example.com",
    subject: "دعوة رسمية للمناسبة", // "Official invitation to the event"
    html: "<p>x</p>",
    boundary: FIXED_BOUNDARY,
    messageId: FIXED_MESSAGE_ID,
    date: FIXED_DATE,
  });
  const subj = header(raw, "Subject");
  assert.ok(subj !== null);
  assert.ok(subj!.startsWith("=?UTF-8?B?"), `expected encoded-word, got ${subj}`);
  assert.ok(subj!.endsWith("?="), `expected encoded-word close, got ${subj}`);
});

test("encodeHeaderValue round-trips through base64 back to original Arabic string", () => {
  const original = "دعوة رسمية";
  const encoded = encodeHeaderValue(original);
  // Strip the encoded-word wrapper(s) and base64-decode each chunk.
  const chunks = encoded.split(/\r\n /);
  const reconstructed = chunks
    .map((c) => {
      const m = c.match(/^=\?UTF-8\?B\?(.+)\?=$/);
      assert.ok(m, `chunk missing encoded-word wrapper: ${c}`);
      return Buffer.from(m![1], "base64").toString("utf8");
    })
    .join("");
  assert.equal(reconstructed, original);
});

test("encodeHeaderValue splits long non-ASCII subjects into multiple chunks", () => {
  // Long Arabic subject — should force a multi-chunk encoded-word
  // because any single chunk would exceed the 75-char limit.
  const subject = "دعوة رسمية لحضور مناسبة افتتاح مبنى المكتب الرئيسي في الرياض يوم الخميس";
  const encoded = encodeHeaderValue(subject);
  const chunks = encoded.split(/\r\n /);
  assert.ok(
    chunks.length >= 2,
    `expected at least 2 encoded-word chunks for long Arabic subject, got ${chunks.length}`,
  );
  for (const c of chunks) {
    assert.ok(c.length <= 75, `encoded-word chunk exceeds 75 chars: ${c.length} (${c})`);
  }
});

test("buildRfc5322 with html only produces a single text/html part", () => {
  const raw = buildRfc5322({
    from: "a@b.com",
    to: "c@d.com",
    subject: "S",
    html: "<p>hi</p>",
    boundary: FIXED_BOUNDARY,
    messageId: FIXED_MESSAGE_ID,
    date: FIXED_DATE,
  });
  assert.match(header(raw, "Content-Type") ?? "", /^text\/html;/);
  assert.equal(header(raw, "Content-Transfer-Encoding"), "base64");
  assert.ok(!raw.includes(`--${FIXED_BOUNDARY}`), "single-part must not include boundary");
});

test("buildRfc5322 with html+text produces multipart/alternative text-first-html-last", () => {
  const raw = buildRfc5322({
    from: "a@b.com",
    to: "c@d.com",
    subject: "S",
    html: "<p>html body</p>",
    text: "plain body",
    boundary: FIXED_BOUNDARY,
    messageId: FIXED_MESSAGE_ID,
    date: FIXED_DATE,
  });
  const ct = header(raw, "Content-Type") ?? "";
  assert.match(ct, /^multipart\/alternative; boundary="=_test_boundary_0123"$/);
  // text part before html part.
  const textIdx = raw.indexOf('Content-Type: text/plain; charset="UTF-8"');
  const htmlIdx = raw.indexOf('Content-Type: text/html; charset="UTF-8"');
  assert.ok(textIdx > 0 && htmlIdx > textIdx, "text part must come before html part");
  // Closing boundary present.
  assert.ok(
    raw.includes(`--${FIXED_BOUNDARY}--`),
    "multipart must end with closing boundary",
  );
});

test("buildRfc5322 emits Reply-To when provided, skips it when not", () => {
  const withReply = buildRfc5322({
    from: "a@b.com",
    to: "c@d.com",
    subject: "S",
    html: "x",
    replyTo: "rsvp+token@example.gov.sa",
    boundary: FIXED_BOUNDARY,
    messageId: FIXED_MESSAGE_ID,
    date: FIXED_DATE,
  });
  assert.equal(header(withReply, "Reply-To"), "rsvp+token@example.gov.sa");

  const without = buildRfc5322({
    from: "a@b.com",
    to: "c@d.com",
    subject: "S",
    html: "x",
    boundary: FIXED_BOUNDARY,
    messageId: FIXED_MESSAGE_ID,
    date: FIXED_DATE,
  });
  assert.equal(header(without, "Reply-To"), null);
});

test("buildRfc5322 threads custom headers through (e.g. List-Unsubscribe)", () => {
  const raw = buildRfc5322({
    from: "a@b.com",
    to: "c@d.com",
    subject: "S",
    html: "x",
    headers: {
      "List-Unsubscribe": "<https://rsvp.example/u/abc>, <mailto:unsubscribe@rsvp.example>",
      "X-Campaign-Id": "cmp_123",
    },
    boundary: FIXED_BOUNDARY,
    messageId: FIXED_MESSAGE_ID,
    date: FIXED_DATE,
  });
  assert.equal(
    header(raw, "List-Unsubscribe"),
    "<https://rsvp.example/u/abc>, <mailto:unsubscribe@rsvp.example>",
  );
  assert.equal(header(raw, "X-Campaign-Id"), "cmp_123");
});

test("buildRfc5322 rejects reserved custom headers", () => {
  assert.throws(
    () =>
      buildRfc5322({
        from: "a@b.com",
        to: "c@d.com",
        subject: "S",
        html: "x",
        headers: { Subject: "injected" },
      }),
    /reserved/,
  );
  assert.throws(
    () =>
      buildRfc5322({
        from: "a@b.com",
        to: "c@d.com",
        subject: "S",
        html: "x",
        headers: { Bcc: "attacker@x" },
      }),
    /reserved/,
  );
  assert.throws(
    () =>
      buildRfc5322({
        from: "a@b.com",
        to: "c@d.com",
        subject: "S",
        html: "x",
        headers: { "Content-Type": "text/plain" },
      }),
    /reserved/,
  );
});

test("buildRfc5322 rejects CR/LF injection in every user-controlled field", () => {
  const base = {
    from: "a@b.com",
    to: "c@d.com",
    subject: "S",
    html: "x",
  };
  assert.throws(
    () => buildRfc5322({ ...base, from: "a@b.com\r\nBcc: attacker@x" }),
    /CR\/LF/,
  );
  assert.throws(
    () => buildRfc5322({ ...base, to: "c@d.com\nX: y" }),
    /CR\/LF/,
  );
  assert.throws(
    () => buildRfc5322({ ...base, subject: "hi\r\nBcc: x" }),
    /CR\/LF/,
  );
  assert.throws(
    () => buildRfc5322({ ...base, replyTo: "rsvp@x\r\nBcc: x" }),
    /CR\/LF/,
  );
  assert.throws(
    () => buildRfc5322({ ...base, fromName: "ok\r\nBcc: x" }),
    /CR\/LF/,
  );
  assert.throws(
    () =>
      buildRfc5322({ ...base, headers: { "X-Custom": "v\r\nBcc: x" } }),
    /CR\/LF/,
  );
  assert.throws(
    () =>
      buildRfc5322({ ...base, headers: { "X-Bad\r\nName": "v" } }),
    /CR\/LF/,
  );
});

test("buildRfc5322 quotes display names containing RFC 5322 specials", () => {
  const raw = buildRfc5322({
    from: "a@b.com",
    fromName: "Smith, John",
    to: "c@d.com",
    subject: "S",
    html: "x",
    boundary: FIXED_BOUNDARY,
    messageId: FIXED_MESSAGE_ID,
    date: FIXED_DATE,
  });
  // Comma is an RFC 5322 special — must be quoted.
  assert.equal(header(raw, "From"), '"Smith, John" <a@b.com>');
});

test("buildRfc5322 escapes backslash and double-quote inside quoted display name", () => {
  const raw = buildRfc5322({
    from: "a@b.com",
    fromName: 'She said "hi" \\ thanks',
    to: "c@d.com",
    subject: "S",
    html: "x",
    boundary: FIXED_BOUNDARY,
    messageId: FIXED_MESSAGE_ID,
    date: FIXED_DATE,
  });
  // The quoted-string body has each " escaped to \" and each \ to \\.
  const from = header(raw, "From");
  assert.equal(from, '"She said \\"hi\\" \\\\ thanks" <a@b.com>');
});

test("buildRfc5322 encodes non-ASCII display names (Arabic)", () => {
  const raw = buildRfc5322({
    from: "a@b.com",
    fromName: "مكتب البروتوكول",
    to: "c@d.com",
    subject: "S",
    html: "x",
    boundary: FIXED_BOUNDARY,
    messageId: FIXED_MESSAGE_ID,
    date: FIXED_DATE,
  });
  const from = header(raw, "From");
  assert.ok(from !== null);
  assert.ok(
    from!.startsWith("=?UTF-8?B?"),
    `expected encoded-word display name, got ${from}`,
  );
  assert.ok(from!.endsWith("<a@b.com>"));
});

test("buildRawMessage emits base64url without + / =", () => {
  const raw = buildRawMessage({
    from: "a@b.com",
    to: "c@d.com",
    subject: "S",
    html: "<p>hi</p>",
    boundary: FIXED_BOUNDARY,
    messageId: FIXED_MESSAGE_ID,
    date: FIXED_DATE,
  });
  assert.ok(/^[A-Za-z0-9_-]+$/.test(raw), `expected base64url chars only, got ${raw.slice(0, 60)}...`);
});

test("buildRawMessage round-trips: base64url-decoded output equals the RFC 5322 text", () => {
  const input = {
    from: "a@b.com",
    to: "c@d.com",
    subject: "S",
    html: "<p>hi</p>",
    boundary: FIXED_BOUNDARY,
    messageId: FIXED_MESSAGE_ID,
    date: FIXED_DATE,
  };
  const raw = buildRawMessage(input);
  const rfc = buildRfc5322(input);
  // base64url -> base64 (reverse the urlsafe substitution, re-pad)
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const decoded = Buffer.from(padded, "base64").toString("utf8");
  assert.equal(decoded, rfc);
});
