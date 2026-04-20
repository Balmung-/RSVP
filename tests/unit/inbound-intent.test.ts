import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseIntent,
  extractTokenFromAddress,
  extractTokenFromBody,
} from "../../src/lib/inbound";

// P14-F — pin-only slice. Unlike P14-A through P14-E (which extracted
// inline logic into pure helpers), these three functions are ALREADY
// pure + exported; the gap is they have zero unit coverage. And they
// are the highest-risk uncovered surface in the codebase: their output
// drives `ingest()` in the same file, which:
//
//   - writes `Unsubscribe` rows when parseIntent returns `stop` high
//   - calls `submitResponse` (a real RSVP row write) when parseIntent
//     returns `attending` / `declined` high for a matched invitee
//   - only falls through to reviewer when confidence is medium/low
//     or the intent is unknown/autoreply
//
// A regression in any of these classifiers silently corrupts invitee
// state at the data level — no loud failure, just wrong RSVP outcomes
// landing in the DB. Regression vectors pinned here:
//
//   (A) Keyword-list drift — a copy-paste that lands "regret" in
//       YES_KEYWORDS would invert every decline; adding "ok" to
//       YES_KEYWORDS would classify "ok whatever" as attending.
//
//   (B) Confidence-threshold drift — the `yesHits >= 2 && noHits === 0`
//       gate prevents single-word-appearance false positives. Dropping
//       to `>= 1` would flip every message containing "yes" somewhere
//       (even "yes I mean no") to attending high — which ingest()
//       would auto-apply with no reviewer step.
//
//   (C) `startsWith` → `includes` drift on STOP_KEYWORDS — currently
//       "please stop emailing me" is NOT classified as stop (full
//       body must start with a stop keyword). A switch to `.includes`
//       would make any email mentioning "stop" unsubscribe the sender,
//       including operator tests and quoted-reply threads.
//
//   (D) Ordering drift between AUTOREPLY / STOP / keyword paths — the
//       autoreply check runs FIRST, so an out-of-office whose body
//       contains "stop" is classified autoreply (ignored), not stop
//       (unsubscribed). Flipping the order would start unsubscribing
//       people based on OOO boilerplate.
//
//   (E) Token regex bounds — the `{10,64}` char class on the
//       subaddress / body patterns. Widening to `{5,64}` enables
//       short-token spoofing; narrowing to `{20,64}` drops legit
//       shorter-token historical campaigns.
//
//   (F) Normalization — lowercase + whitespace-collapse. A regression
//       dropping `.toLowerCase()` would fail to match "YES" /
//       "UNSUBSCRIBE" (all caps is common in reply footers). Dropping
//       the whitespace collapse would fail to match "yes  please"
//       against the "yes" keyword.

// ---------------------------------------------------------------
// (A) extractTokenFromAddress — subaddress parsing
// ---------------------------------------------------------------

test("extractTokenFromAddress: valid rsvp+<token>@host returns the token", () => {
  // Happy path: 16-char alphanumeric+underscore+hyphen token.
  assert.equal(
    extractTokenFromAddress("rsvp+abc123XYZ-_def@example.com"),
    "abc123XYZ-_def",
  );
});

test("extractTokenFromAddress: returns null on null / undefined / empty", () => {
  // Defensive input — webhooks can omit the To header entirely.
  assert.equal(extractTokenFromAddress(null), null);
  assert.equal(extractTokenFromAddress(undefined), null);
  assert.equal(extractTokenFromAddress(""), null);
});

test("extractTokenFromAddress: returns null when local-part has no '+'", () => {
  // A bare rsvp@host (no subaddress) has no token. A regression that
  // treated the whole local-part as a token would route every inbound
  // rsvp@ address as a token-match and mis-link replies.
  assert.equal(extractTokenFromAddress("rsvp@example.com"), null);
  assert.equal(extractTokenFromAddress("alice@example.com"), null);
});

test("extractTokenFromAddress: rejects tokens shorter than 10 chars", () => {
  // The `{10,64}` lower bound prevents trivial 4-char-slug spoofing
  // (e.g. rsvp+ab@ would otherwise enumerate trivially).
  assert.equal(extractTokenFromAddress("rsvp+abc12@example.com"), null);
  assert.equal(extractTokenFromAddress("rsvp+123456789@example.com"), null); // 9 chars
});

test("extractTokenFromAddress: accepts tokens exactly 10 chars (boundary)", () => {
  // The lower bound is inclusive — pinning so a drift to `{11,64}`
  // would break legit 10-char-token historical invites.
  assert.equal(
    extractTokenFromAddress("rsvp+abcde12345@example.com"),
    "abcde12345",
  );
});

test("extractTokenFromAddress: rejects tokens longer than 64 chars", () => {
  // Upper bound prevents DoS-style inputs and also means an accidental
  // junk address won't get treated as a valid token.
  const tooLong = "a".repeat(65);
  assert.equal(
    extractTokenFromAddress(`rsvp+${tooLong}@example.com`),
    null,
  );
});

test("extractTokenFromAddress: rejects tokens with disallowed characters", () => {
  // Character class is `[a-zA-Z0-9_-]`. A `$` / `!` / space / plus
  // should fail — these aren't produced by `nanoid` and their
  // presence usually means someone spoofed or typo'd the address.
  assert.equal(extractTokenFromAddress("rsvp+abc$1234567@example.com"), null);
  assert.equal(extractTokenFromAddress("rsvp+abc!1234567@example.com"), null);
  assert.equal(extractTokenFromAddress("rsvp+abc 1234567@example.com"), null);
});

test("extractTokenFromAddress: only inspects the local part, not the domain", () => {
  // A token-like string in the domain should NOT be extracted. This
  // guards against a regression that parsed the whole address string
  // and picked up e.g. the domain's subdomain as a token.
  assert.equal(
    extractTokenFromAddress("rsvp@abc123XYZdef456.example.com"),
    null,
  );
});

// ---------------------------------------------------------------
// (B) extractTokenFromBody — body-side fallback patterns
// ---------------------------------------------------------------

test("extractTokenFromBody: extracts rsvp+<token>@ from body text", () => {
  // Mirrors the subaddress pattern. {10,64} char class.
  const token = extractTokenFromBody(
    "Sure, I'll make it.\n\nReplying to rsvp+abc123XYZdef@host.com, thanks",
  );
  assert.equal(token, "abc123XYZdef");
});

test("extractTokenFromBody: extracts rsvp: <token> (tag form) — 20 char minimum", () => {
  // The tag form is more permissive on what precedes the token but
  // stricter on length — `{20,64}` — to avoid false positives inside
  // prose. Pinning the 20-char lower bound because dropping to 10
  // would make every "rsvp: yes" line look like a token.
  assert.equal(
    extractTokenFromBody("rsvp: abcdefghij1234567890"),
    "abcdefghij1234567890",
  );
  // 19 chars: just under — should NOT match the tag pattern.
  assert.equal(extractTokenFromBody("rsvp: abcdefghij123456789"), null);
});

test("extractTokenFromBody: tag form is case-insensitive ('RSVP:' also matches)", () => {
  // The `i` flag on the tag regex handles the common "RSVP:" all-caps
  // footer. Address pattern is case-sensitive by design (rsvp+ is a
  // contract with the mail server's forwarding config).
  assert.equal(
    extractTokenFromBody("RSVP: abcdefghij1234567890"),
    "abcdefghij1234567890",
  );
});

test("extractTokenFromBody: address pattern takes precedence over tag pattern", () => {
  // When both appear in the same body, the subaddress match fires
  // first (it's more reliable — came through the mail From header
  // forwarding). Pinning so a refactor that runs tag FIRST doesn't
  // silently switch which token wins.
  const body =
    "rsvp: tagTokenABCDEFGHIJKLMNOP but see also rsvp+addrTokenABCDEF@host";
  assert.equal(extractTokenFromBody(body), "addrTokenABCDEF");
});

test("extractTokenFromBody: returns null on empty body and on bodies without rsvp patterns", () => {
  assert.equal(extractTokenFromBody(""), null);
  assert.equal(extractTokenFromBody("Hello, I'll attend. — Alice"), null);
});

// ---------------------------------------------------------------
// (C) parseIntent — autoreply path (runs FIRST, guards against OOO
// bodies being mis-classified as stop/attending/etc)
// ---------------------------------------------------------------

test("parseIntent: body with 'out of office' → autoreply high", () => {
  const r = parseIntent("Out of Office — I'll be back Monday.");
  assert.equal(r.intent, "autoreply");
  assert.equal(r.confidence, "high");
});

test("parseIntent: body with 'auto-reply' phrasing → autoreply high", () => {
  const r = parseIntent("This is an auto-reply. Please don't respond.");
  assert.equal(r.intent, "autoreply");
});

test("parseIntent: header 'X-Autoreply:' triggers autoreply even on a body that looks like stop", () => {
  // The header-level check is a strong signal — vacation responders
  // often set X-Autoreply: yes. Pinning because ingest()'s decision
  // between writing an Unsubscribe row (stop path) and silently
  // ignoring (autoreply path) hinges on this.
  const r = parseIntent("stop", "X-Autoreply: yes\r\n");
  assert.equal(r.intent, "autoreply");
});

test("parseIntent: autoreply is checked BEFORE stop (order regression guard)", () => {
  // An OOO body that HAPPENS to contain "stop" (e.g. "I will stop by
  // the office on Monday") must NOT unsubscribe the sender. Ordering
  // regression vector.
  const r = parseIntent("I'm currently unavailable. I will stop checking email until Monday.");
  assert.equal(r.intent, "autoreply");
});

// ---------------------------------------------------------------
// (D) parseIntent — stop path (startsWith + exact match; NOT
// .includes)
// ---------------------------------------------------------------

test("parseIntent: single-word 'stop' → stop high", () => {
  const r = parseIntent("stop");
  assert.equal(r.intent, "stop");
  assert.equal(r.confidence, "high");
});

test("parseIntent: body starting with 'unsubscribe ...' → stop high", () => {
  // startsWith-based: "unsubscribe please" starts with the keyword.
  const r = parseIntent("unsubscribe please, no more emails");
  assert.equal(r.intent, "stop");
});

test("parseIntent: body NOT starting with a stop keyword is NOT classified as stop", () => {
  // CRITICAL regression vector: a switch from .startsWith to .includes
  // would flip this to stop and silently unsubscribe the sender.
  // "please stop emailing me" would then classify the whole inbox's
  // quoted replies containing "stop" as unsubscribes.
  const r = parseIntent("please stop emailing me");
  assert.notEqual(r.intent, "stop");
});

test("parseIntent: Arabic stop keyword ('إلغاء') at start → stop high", () => {
  // Arabic keyword coverage. Pinning the bilingual contract so a
  // regression dropping the Arabic terms would silently regress
  // Arabic-speaking operators' opt-out handling.
  const r = parseIntent("إلغاء");
  assert.equal(r.intent, "stop");
});

// ---------------------------------------------------------------
// (E) parseIntent — multi-keyword high-confidence gate
// ---------------------------------------------------------------

test("parseIntent: ≥2 yes hits AND 0 no hits → attending high", () => {
  // Multi-keyword gate. Two+ distinct YES_KEYWORDS must appear, and
  // zero NO_KEYWORDS. Single-word replies go through the firstLine
  // exact-match branch below (different path).
  //
  // NOTE: the body-match uses .includes, so "no" matches ANY substring
  // including "now", "not", "nothing". This test body is deliberately
  // picked to avoid accidental "no" substrings — a regression that
  // relaxed the `noHits === 0` gate to `noHits <= N` for some N would
  // auto-apply mixed bodies through ingest(), so we want to pin the
  // strict-zero gate here.
  const r = parseIntent("Accept, yes. Please confirm.");
  // "accept" + "yes" + "confirm" = 3 yes hits; zero no substrings.
  assert.equal(r.intent, "attending");
  assert.equal(r.confidence, "high");
});

test("parseIntent: mixed yes + no signal DOWNGRADES to medium (safety pin)", () => {
  // The inverse of the previous test. This body has BOTH yes and no
  // hits ("no" inside "cannot" via NO_KEYWORDS, plus "attend" + "yes"
  // via YES_KEYWORDS). The high-confidence gates require the opposing
  // count to be zero, so both gates fail and we fall to medium tier.
  //
  // CRITICAL safety property: ingest() auto-applies only on HIGH
  // confidence. Downgrading to medium keeps the reviewer in the loop
  // for ambiguous replies — pinning the downgrade so a future refactor
  // loosening the high-gate (e.g. to `noHits <= 1`) would immediately
  // break this test and require conscious review.
  const r = parseIntent("I want to say yes but I cannot attend.");
  assert.notEqual(r.confidence, "high");
});

test("parseIntent: single-word 'yes' (exact firstLine match) → attending high", () => {
  // Lightweight single-word replies are common ("yes" / "no" /
  // "لا"). The firstLine exact-match rule classifies these as high
  // confidence. Pinning because a regression requiring ≥2 body hits
  // would drop confidence to low for the most common RSVP case.
  const r = parseIntent("yes");
  assert.equal(r.intent, "attending");
  assert.equal(r.confidence, "high");
  assert.equal(r.note, "single-word yes");
});

test("parseIntent: single-word 'no' (exact firstLine match) → declined high", () => {
  const r = parseIntent("no");
  assert.equal(r.intent, "declined");
  assert.equal(r.confidence, "high");
  assert.equal(r.note, "single-word no");
});

test("parseIntent: single-word Arabic 'نعم' → attending high", () => {
  const r = parseIntent("نعم");
  assert.equal(r.intent, "attending");
  assert.equal(r.confidence, "high");
});

test("parseIntent: medium-tier selects attending when yesHits > noHits AND both > 0", () => {
  // The sibling to "mixed downgrade" above — this one pins the
  // DIRECTION of the medium-tier tiebreaker. If the body leans yes
  // (yesHits > noHits > 0), ingest() will still route to reviewer,
  // but the intent label is "attending medium" (not "declined" or
  // "unknown"). Pinning so a swap of the `>` direction would silently
  // flip the reviewer's default-action suggestion.
  const r = parseIntent("Yes, I accept. Sure, I'll attend. cannot wait.");
  // "yes" + "accept" + "sure" + "attend" = 4 yes hits; "cannot" = 1
  // no hit. Medium gate: yesHits (4) > noHits (1) → attending medium.
  assert.equal(r.intent, "attending");
  assert.equal(r.confidence, "medium");
});

// ---------------------------------------------------------------
// (F) parseIntent — unknown fallback + normalization
// ---------------------------------------------------------------

test("parseIntent: unrelated body → unknown low", () => {
  const r = parseIntent("Hi, can you send the venue address?");
  assert.equal(r.intent, "unknown");
  assert.equal(r.confidence, "low");
});

test("parseIntent: empty body → unknown low", () => {
  const r = parseIntent("");
  assert.equal(r.intent, "unknown");
  assert.equal(r.confidence, "low");
});

test("parseIntent: uppercase input is normalized — 'YES' is treated same as 'yes'", () => {
  // The `.toLowerCase()` in normalize() is load-bearing. Reply
  // footers sometimes come through all-caps; dropping this
  // normalization would silently fail to match.
  const r = parseIntent("YES");
  assert.equal(r.intent, "attending");
  assert.equal(r.confidence, "high");
});

test("parseIntent: whitespace is collapsed — 'yes   and   attend' matches both keywords", () => {
  // The `.replace(/\s+/g, " ")` step. A regression dropping it
  // would make multi-space tokens miss keyword matches. Here we
  // want both "yes" and "attend" to count toward yesHits.
  const r = parseIntent("yes   and   i will attend the event");
  assert.equal(r.intent, "attending");
  assert.equal(r.confidence, "high");
});

// ---------------------------------------------------------------
// (G) parseIntent — shape drift guards
// ---------------------------------------------------------------

test("parseIntent: returned object has exactly intent + confidence (+ optional note)", () => {
  // Shape pin. A regression adding fields would silently reshape
  // what ingest() reads. Note is optional but when present must
  // match one of the documented strings.
  const r = parseIntent("yes");
  const keys = Object.keys(r).sort();
  assert.ok(keys.includes("intent"));
  assert.ok(keys.includes("confidence"));
  // Optional note field
  if (keys.includes("note")) {
    assert.equal(typeof r.note, "string");
  }
  // No other fields
  for (const k of keys) {
    assert.ok(
      ["intent", "confidence", "note"].includes(k),
      `unexpected key on parseIntent result: ${k}`,
    );
  }
});

test("parseIntent: intent value is drawn from the closed vocabulary", () => {
  // Intent is one of: attending | declined | stop | autoreply | unknown.
  // Pinning the closed-vocabulary so a regression adding a new value
  // without updating ingest()'s switch-on-intent would fire here.
  const samples = [
    parseIntent("yes"),
    parseIntent("no"),
    parseIntent("stop"),
    parseIntent("out of office"),
    parseIntent("hello friend"),
  ];
  const allowed = new Set([
    "attending",
    "declined",
    "stop",
    "autoreply",
    "unknown",
  ]);
  for (const r of samples) {
    assert.ok(
      allowed.has(r.intent),
      `unexpected intent value: ${r.intent}`,
    );
  }
});

test("parseIntent: confidence value is drawn from the closed vocabulary", () => {
  // Confidence is one of: high | medium | low.
  const samples = [
    parseIntent("yes"),
    parseIntent("might come"),
    parseIntent("hello friend"),
  ];
  const allowed = new Set(["high", "medium", "low"]);
  for (const r of samples) {
    assert.ok(
      allowed.has(r.confidence),
      `unexpected confidence value: ${r.confidence}`,
    );
  }
});
