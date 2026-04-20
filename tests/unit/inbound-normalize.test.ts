import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractEmail,
  htmlToText,
  pickFirst,
  recordSource,
  normalizeInboundEmail,
  normalizeInboundSms,
  type KeyedSource,
} from "../../src/lib/inbound-normalize";

// P14-H pin set. The helpers under test live in
// `src/lib/inbound-normalize.ts` and are called by the two
// webhook routes in `src/app/api/webhooks/inbound/{email,sms}/route.ts`.
// These tests pin:
//
//   - `extractEmail`: regex bounds + lowercase discipline
//   - `htmlToText`: replacement order + entity decode + whitespace
//     normalization
//   - `pickFirst`: null-coalesce semantics (first non-null wins,
//     empty-string first-match is NOT skipped)
//   - `normalizeInboundEmail`: key-priority coalesce chain,
//     HTML-body fallback, `no_sender` short-circuit, shape
//   - `normalizeInboundSms`: provider key priority (Twilio caps
//     vs lowercase vs generic), `missing_fields` short-circuit
//
// A small test-side KeyedSource factory: accepts a plain record
// and returns the shape normalizeInbound* expects. Undefined
// keys yield null (matching both FormData.get and recordSource).
function src(r: Record<string, unknown>): KeyedSource {
  return {
    get(key: string): unknown {
      const v = r[key];
      return v === undefined ? null : v;
    },
  };
}

// ---------------------------------------------------------------
// (A) extractEmail — 5 tests. Pins the regex bounds and the
//     lowercasing that keeps invitee-matching case-insensitive.
// ---------------------------------------------------------------

test("extractEmail: angle-bracket form yields bare address", () => {
  assert.equal(
    extractEmail("Jane Doe <jane@example.com>"),
    "jane@example.com",
  );
});

test("extractEmail: bare address passes through unchanged", () => {
  assert.equal(extractEmail("alice@example.com"), "alice@example.com");
});

test("extractEmail: uppercase input is lowercased (load-bearing for invitee match)", () => {
  // Outlook, some Android clients, and hand-typed addresses can
  // preserve case. DB stores lowercase; the helper MUST lowercase
  // to keep the match working.
  assert.equal(extractEmail("BOB@EXAMPLE.COM"), "bob@example.com");
  assert.equal(
    extractEmail("Sender <MixedCase@Example.Com>"),
    "mixedcase@example.com",
  );
});

test("extractEmail: no-match returns null (not empty string)", () => {
  // Distinct from `""` — the caller short-circuits on null with
  // `no_sender`; an empty string would fail the short-circuit
  // check in current route code but confuse the type layer.
  assert.equal(extractEmail("not an email at all"), null);
  assert.equal(extractEmail(""), null);
  // A bare "@" with no domain or TLD fails.
  assert.equal(extractEmail("@"), null);
});

test("extractEmail: TLD must be ≥2 chars (rejects `no@tld`)", () => {
  // The `{2,}` bound on the TLD is a deliberate pin — it filters
  // tweet-style `@handle` noise, localhost-only addresses, and
  // malformed mangled strings that happen to contain `@`.
  assert.equal(extractEmail("no@tld"), null);
  // Boundary — exactly 2 chars IS accepted (co, de, uk, sa).
  assert.equal(extractEmail("user@host.co"), "user@host.co");
});

// ---------------------------------------------------------------
// (B) htmlToText — 8 tests. Pins the replacement order, each
//     entity decode, line-ending normalization, and whitespace
//     trim. Order matters here (see the helper header comment).
// ---------------------------------------------------------------

test("htmlToText: <style> block and contents stripped", () => {
  // Just the tags would be wrong — the CSS text itself leaks
  // through unless we strip `[\s\S]*?</style>` entirely.
  assert.equal(
    htmlToText("<html><style>.x{color:red;}</style>hello</html>"),
    "hello",
  );
});

test("htmlToText: <script> block and contents stripped", () => {
  assert.equal(
    htmlToText("<script>alert('x');</script>greeting"),
    "greeting",
  );
});

test("htmlToText: <br> converted to newline (ran BEFORE generic tag strip)", () => {
  // If the generic `<[^>]+>` ran first, `<br>` would vanish with
  // no newline — line structure would collapse.
  assert.equal(htmlToText("line1<br>line2"), "line1\nline2");
  // Self-closing variant.
  assert.equal(htmlToText("line1<br/>line2"), "line1\nline2");
  assert.equal(htmlToText("line1<br />line2"), "line1\nline2");
  // Case-insensitive match.
  assert.equal(htmlToText("line1<BR>line2"), "line1\nline2");
});

test("htmlToText: </p> converted to double newline (paragraph break)", () => {
  // Two newlines is the visual paragraph break; a single newline
  // would merge paragraphs for intent-parsing purposes.
  // Note: the trailing `</p>` emits `\n\n` before the trim runs,
  // which then strips it — so we assert within a middle position.
  assert.equal(
    htmlToText("<p>one</p><p>two</p>"),
    "one\n\ntwo",
  );
});

test("htmlToText: generic tag strip removes non-content markup", () => {
  assert.equal(htmlToText("<b>bold</b>"), "bold");
  assert.equal(htmlToText('<a href="x">click</a>'), "click");
  // Attributes with quotes + equals.
  assert.equal(
    htmlToText('<span class="greeting">hello</span>'),
    "hello",
  );
});

test("htmlToText: HTML entity decode — &amp; &lt; &gt; &quot; &nbsp;", () => {
  // Entity decode MUST run AFTER the tag strip; otherwise
  // `&lt;script&gt;` would decode to `<script>` and get re-read
  // as a tag on a second pass that never happens — i.e., leak.
  assert.equal(htmlToText("a &amp; b"), "a & b");
  assert.equal(htmlToText("&lt;not a tag&gt;"), "<not a tag>");
  assert.equal(htmlToText("he said &quot;hi&quot;"), 'he said "hi"');
  assert.equal(htmlToText("word&nbsp;space"), "word space");
});

test("htmlToText: \\r\\n normalized to \\n", () => {
  // Windows-style line endings (Outlook classic, some older
  // clients). Without normalization, downstream string matches
  // for "Yes\n" etc. would miss.
  assert.equal(htmlToText("line1\r\nline2"), "line1\nline2");
});

test("htmlToText: 3+ newlines collapse to 2; outer whitespace trimmed", () => {
  // Excess paragraph breaks and leading/trailing whitespace vanish,
  // but a single intentional paragraph break (2 newlines) survives.
  assert.equal(htmlToText("\n\n\n\nhello\n\n\n\n"), "hello");
  assert.equal(htmlToText("a\n\n\n\nb"), "a\n\nb");
  assert.equal(htmlToText("   leading and trailing   "), "leading and trailing");
});

// ---------------------------------------------------------------
// (C) pickFirst — 4 tests. Pins the null-coalesce semantics the
//     pre-extract routes relied on (`String(x ?? y ?? "")`).
// ---------------------------------------------------------------

test("pickFirst: first non-null key wins", () => {
  const s = src({ a: "alpha", b: "bravo" });
  assert.equal(pickFirst(s, ["a", "b"]), "alpha");
});

test("pickFirst: null first → fall through to next key", () => {
  const s = src({ b: "bravo" }); // a is missing → null
  assert.equal(pickFirst(s, ["a", "b"]), "bravo");
});

test("pickFirst: empty-string first-match DOES NOT fall through", () => {
  // Load-bearing — matches `??` coalesce semantics exactly. An
  // upstream form POSTing `from=` (empty) must NOT silently pick
  // the `sender` fallback, because routes downstream rely on
  // `extractEmail("")` → null → `no_sender` refusal.
  const s = src({ a: "", b: "bravo" });
  assert.equal(pickFirst(s, ["a", "b"]), "");
});

test("pickFirst: all keys null → empty string default", () => {
  const s = src({});
  assert.equal(pickFirst(s, ["a", "b", "c"]), "");
});

// ---------------------------------------------------------------
// (D) normalizeInboundEmail — 12 tests. Pins the coalesce chain
//     per-field, the HTML-body fallback, the `no_sender` short-
//     circuit, and the output shape.
// ---------------------------------------------------------------

test("normalizeInboundEmail: minimal valid SendGrid-style form", () => {
  const result = normalizeInboundEmail(
    src({
      from: "Jane <jane@example.com>",
      to: "rsvp@einai.app",
      subject: "Re: Wedding",
      text: "Yes!",
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.email, {
    fromAddress: "jane@example.com",
    toAddress: "rsvp@einai.app",
    subject: "Re: Wedding",
    body: "Yes!",
    rawHeaders: null,
    providerId: null,
  });
});

test("normalizeInboundEmail: `sender` falls back when `from` absent", () => {
  // Some providers use `sender` instead of `from`. Pinned: both
  // must resolve to the same normalized fromAddress.
  const result = normalizeInboundEmail(
    src({ sender: "mail@alt.com", subject: "x", text: "hi" }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.email.fromAddress, "mail@alt.com");
});

test("normalizeInboundEmail: `from` wins over `sender` when both present", () => {
  // Priority list `["from", "sender"]` — `from` is first, so it
  // wins even if `sender` also has a valid value. Pinned because
  // a swapped order would silently let the `sender` field (often
  // "noreply@" for auto-sent messages) override the real human.
  const result = normalizeInboundEmail(
    src({
      from: "human@example.com",
      sender: "noreply@example.com",
      text: "hi",
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.email.fromAddress, "human@example.com");
});

test("normalizeInboundEmail: body priority text > plain > body-plain", () => {
  // Triple-key priority — pinned exhaustively. A provider that
  // sends ALL three (SendGrid can) must land on `text`.
  const all = normalizeInboundEmail(
    src({
      from: "a@b.com",
      text: "T-WIN",
      plain: "P-LOSE",
      "body-plain": "BP-LOSE",
    }),
  );
  assert.equal(all.ok && all.email.body, "T-WIN");

  // Missing `text` → `plain` wins over `body-plain`.
  const partial = normalizeInboundEmail(
    src({ from: "a@b.com", plain: "P-WIN", "body-plain": "BP-LOSE" }),
  );
  assert.equal(partial.ok && partial.email.body, "P-WIN");

  // Only `body-plain` → it wins.
  const only = normalizeInboundEmail(
    src({ from: "a@b.com", "body-plain": "BP-WIN" }),
  );
  assert.equal(only.ok && only.email.body, "BP-WIN");
});

test("normalizeInboundEmail: HTML body fallback when all plain-body keys empty", () => {
  // A sender that provides only `html` (no `text` / `plain`) must
  // still yield a body — through htmlToText. Pinned because a
  // regression forgetting this branch would drop HTML-only
  // messages' bodies entirely (intent classifier sees empty).
  const result = normalizeInboundEmail(
    src({
      from: "a@b.com",
      html: "<p>Yes, I'll attend!</p>",
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // htmlToText converts `</p>` to `\n\n`, then trim removes
  // trailing. Content: `"Yes, I'll attend!"`
  assert.equal(result.email.body, "Yes, I'll attend!");
});

test("normalizeInboundEmail: HTML fallback uses `html` > `body-html` priority", () => {
  // When html exists under Mailgun's `body-html`, no SendGrid-style
  // `html` key, the fallback still works.
  const mailgun = normalizeInboundEmail(
    src({
      from: "a@b.com",
      "body-html": "<b>mailgun-flavored</b>",
    }),
  );
  assert.equal(mailgun.ok && mailgun.email.body, "mailgun-flavored");
});

test("normalizeInboundEmail: empty plain body does NOT suppress HTML fallback", () => {
  // Subtle — the `if (!body)` check uses `!""`. Empty string IS
  // falsy, so the HTML fallback SHOULD fire. Pinned because a
  // regression using `if (body === null)` would leave an empty
  // string in place and skip html entirely.
  const result = normalizeInboundEmail(
    src({
      from: "a@b.com",
      text: "", // explicitly empty
      html: "<p>fallback reached</p>",
    }),
  );
  assert.equal(result.ok && result.email.body, "fallback reached");
});

test("normalizeInboundEmail: no_sender when no from/sender resolves", () => {
  const result = normalizeInboundEmail(
    src({ subject: "x", text: "orphan" }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "no_sender");
});

test("normalizeInboundEmail: no_sender when from is garbage (no extractable email)", () => {
  const result = normalizeInboundEmail(
    src({ from: "not a real address", text: "x" }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "no_sender");
});

test("normalizeInboundEmail: toAddress extracted through extractEmail (lowercased)", () => {
  const result = normalizeInboundEmail(
    src({
      from: "a@b.com",
      to: "RSVP <RSVP@Einai.APP>",
      text: "x",
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.email.toAddress, "rsvp@einai.app");
});

test("normalizeInboundEmail: provider ID priority — Message-ID > message-id > messageId", () => {
  // All three conventions resolve. Priority pinned: case-preserved
  // RFC-5322 spelling wins, kebab second, camel third.
  const all = normalizeInboundEmail(
    src({
      from: "a@b.com",
      text: "x",
      "Message-ID": "case-preserved-win",
      "message-id": "kebab-lose",
      messageId: "camel-lose",
    }),
  );
  assert.equal(all.ok && all.email.providerId, "case-preserved-win");

  // Fallback to kebab when case-preserved absent.
  const kebab = normalizeInboundEmail(
    src({
      from: "a@b.com",
      text: "x",
      "message-id": "kebab-win",
      messageId: "camel-lose",
    }),
  );
  assert.equal(kebab.ok && kebab.email.providerId, "kebab-win");

  // Finally camel.
  const camel = normalizeInboundEmail(
    src({ from: "a@b.com", text: "x", messageId: "camel-win" }),
  );
  assert.equal(camel.ok && camel.email.providerId, "camel-win");

  // Absent → null.
  const none = normalizeInboundEmail(
    src({ from: "a@b.com", text: "x" }),
  );
  assert.equal(none.ok && none.email.providerId, null);
});

test("normalizeInboundEmail: rawHeaders = empty string → null", () => {
  // `headers || null` semantics — empty string coalesces to null
  // so downstream DB writes store NULL, not empty. Pinned because
  // a regression using `headers` (without `|| null`) would store
  // empty strings that look like valid headers but contain nothing.
  const empty = normalizeInboundEmail(
    src({ from: "a@b.com", text: "x", headers: "" }),
  );
  assert.equal(empty.ok && empty.email.rawHeaders, null);

  // With actual headers → preserved.
  const actual = normalizeInboundEmail(
    src({
      from: "a@b.com",
      text: "x",
      headers: "X-Mailer: test\r\n",
    }),
  );
  assert.equal(actual.ok && actual.email.rawHeaders, "X-Mailer: test\r\n");
});

// ---------------------------------------------------------------
// (E) normalizeInboundSms — 6 tests. Pins the Twilio-first
//     priority, the `missing_fields` short-circuit, and the
//     `to || null` nullable recipient.
// ---------------------------------------------------------------

test("normalizeInboundSms: Twilio PascalCase — From/Body/MessageSid", () => {
  const result = normalizeInboundSms(
    src({
      From: "+966501234567",
      To: "+966509999999",
      Body: "Yes",
      MessageSid: "SM123abc",
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.sms, {
    fromAddress: "+966501234567",
    toAddress: "+966509999999",
    body: "Yes",
    providerId: "SM123abc",
  });
});

test("normalizeInboundSms: Twilio caps win over lowercase duplicates", () => {
  // `From` wins over `from` wins over `sender`. Pinned: upper-
  // casing the priority list would flip who wins when a provider
  // sends both (some relays re-lower-case keys).
  const result = normalizeInboundSms(
    src({
      From: "+twilio",
      from: "+lowercase",
      sender: "+sender",
      Body: "x",
    }),
  );
  assert.equal(result.ok && result.sms.fromAddress, "+twilio");
});

test("normalizeInboundSms: lowercase body/from fallback for non-Twilio providers", () => {
  // Msegat / some Unifonic configs use lowercase. Pinned: fallback
  // works when PascalCase absent.
  const result = normalizeInboundSms(
    src({
      from: "+from-lowercase",
      body: "Yes please",
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sms.fromAddress, "+from-lowercase");
  assert.equal(result.sms.body, "Yes please");
});

test("normalizeInboundSms: missing_fields when From absent", () => {
  const result = normalizeInboundSms(src({ Body: "orphan" }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "missing_fields");
});

test("normalizeInboundSms: missing_fields when Body absent", () => {
  const result = normalizeInboundSms(src({ From: "+x" }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "missing_fields");
});

test("normalizeInboundSms: empty To yields toAddress=null (via `to || null`)", () => {
  // Some providers don't include `To` on inbound SMS (the receiving
  // number is implicit). `toAddress` must be null, NOT empty string.
  const result = normalizeInboundSms(src({ From: "+x", Body: "hi" }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sms.toAddress, null);
});

// ---------------------------------------------------------------
// (F) recordSource adapter — 2 tests. Pins the JSON-to-KeyedSource
//     wrapper contract.
// ---------------------------------------------------------------

test("recordSource: undefined key returns null (missing-key semantics)", () => {
  const s = recordSource({ a: "alpha" });
  assert.equal(s.get("a"), "alpha");
  assert.equal(s.get("missing"), null);
});

test("recordSource: null value passes through as null", () => {
  // A JSON payload with an explicit `null` value is distinct from
  // missing — both land as null for the coalesce chain, which is
  // correct since FormData.get also returns null for missing keys.
  const s = recordSource({ a: null, b: "value" });
  assert.equal(s.get("a"), null);
  assert.equal(s.get("b"), "value");
});

// ---------------------------------------------------------------
// (G) Shape drift guards — 2 tests. Lock the result-object key
//     sets so a silent addition / rename breaks here before it
//     breaks the route handler or the `ingest()` contract.
// ---------------------------------------------------------------

test("normalizeInboundEmail: output shape is exactly { ok: true, email: {...six fields} }", () => {
  const result = normalizeInboundEmail(
    src({ from: "a@b.com", text: "x" }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Top-level result.
  assert.deepEqual(Object.keys(result).sort(), ["email", "ok"]);
  // Email envelope — exact six fields.
  assert.deepEqual(
    Object.keys(result.email).sort(),
    [
      "body",
      "fromAddress",
      "providerId",
      "rawHeaders",
      "subject",
      "toAddress",
    ],
  );
});

test("normalizeInboundSms: output shape is exactly { ok: true, sms: {...four fields} }", () => {
  const result = normalizeInboundSms(src({ From: "+x", Body: "y" }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(Object.keys(result).sort(), ["ok", "sms"]);
  assert.deepEqual(
    Object.keys(result.sms).sort(),
    ["body", "fromAddress", "providerId", "toAddress"],
  );
});
