import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TITLE_MAX_CHARS,
  deriveSessionTitle,
} from "../../src/lib/ai/session-title";

// P4-A — tests for the first-message → session-title derivation
// used by POST /api/chat when it creates a new ChatSession row.
//
// What matters:
//   1. Happy path: a short message becomes the title verbatim so
//      the picker shows the operator's exact first ask.
//   2. Truncation: long messages cap at TITLE_MAX_CHARS with a
//      U+2026 ellipsis suffix so the picker row stays one line.
//   3. Whitespace collapse: multi-line / tab-heavy first messages
//      flatten to a single-line title.
//   4. Empty-after-trim returns null — the column is nullable and
//      "   " is not a useful label.
//   5. Non-string input returns null (belt-and-braces against a
//      caller that drops a number/undefined through).

// ---- Happy path ---------------------------------------------------

test("deriveSessionTitle: short message returned verbatim", () => {
  assert.equal(
    deriveSessionTitle("Send invites for Eid reception"),
    "Send invites for Eid reception",
  );
});

test("deriveSessionTitle: Arabic message returned verbatim", () => {
  // No special-casing for non-Latin scripts. We use JS code-unit
  // length, same as the rest of the app. Common Arabic phrases are
  // well within TITLE_MAX_CHARS.
  assert.equal(deriveSessionTitle("أرسل دعوات"), "أرسل دعوات");
});

// ---- Truncation ---------------------------------------------------

test("deriveSessionTitle: message at exactly TITLE_MAX_CHARS is NOT truncated", () => {
  // Boundary case — a message of exactly the max length shouldn't
  // get a spurious ellipsis. Tests the off-by-one.
  const msg = "x".repeat(TITLE_MAX_CHARS);
  const out = deriveSessionTitle(msg);
  assert.equal(out, msg);
  assert.equal(out?.endsWith("…"), false);
});

test("deriveSessionTitle: message longer than TITLE_MAX_CHARS is truncated with …", () => {
  const msg = "a".repeat(100);
  const out = deriveSessionTitle(msg);
  assert.ok(out, "truncated title must exist");
  assert.equal(out.length, TITLE_MAX_CHARS);
  assert.ok(out.endsWith("…"), `must end in U+2026, got: ${out}`);
});

test("deriveSessionTitle: truncation preserves prefix bytes up to MAX-1", () => {
  // The truncation keeps TITLE_MAX_CHARS - 1 characters of the
  // original + the ellipsis. Callers that reverse to recover the
  // prefix need this to be predictable.
  const msg = "abcdefghij".repeat(10); // 100 chars
  const out = deriveSessionTitle(msg)!;
  assert.equal(out.slice(0, TITLE_MAX_CHARS - 1), msg.slice(0, TITLE_MAX_CHARS - 1));
});

// ---- Whitespace handling ------------------------------------------

test("deriveSessionTitle: leading/trailing whitespace is trimmed", () => {
  assert.equal(deriveSessionTitle("   hello world   "), "hello world");
});

test("deriveSessionTitle: internal newlines collapse to single space", () => {
  // A pasted multi-paragraph first message shouldn't break the
  // picker's one-line layout. Newlines → single space.
  assert.equal(
    deriveSessionTitle("line one\nline two\nline three"),
    "line one line two line three",
  );
});

test("deriveSessionTitle: tabs and double spaces collapse", () => {
  assert.equal(deriveSessionTitle("hello\t\tworld    now"), "hello world now");
});

test("deriveSessionTitle: mixed whitespace around newlines is handled", () => {
  // "  \n  hello\n  world  \n  " — the combined trim + collapse
  // should produce "hello world".
  assert.equal(deriveSessionTitle("  \n  hello\n  world  \n  "), "hello world");
});

// ---- Nulls --------------------------------------------------------

test("deriveSessionTitle: empty string returns null", () => {
  assert.equal(deriveSessionTitle(""), null);
});

test("deriveSessionTitle: whitespace-only returns null", () => {
  // The API route's length check already rejects empty-trim
  // messages before we get here, so this path is defensive — but
  // a future caller might not do the pre-check, and the column
  // is nullable, so returning null is the honest answer.
  assert.equal(deriveSessionTitle("   \n\t  "), null);
});

test("deriveSessionTitle: non-string input returns null", () => {
  // TypeScript guarantees `string` at compile time; runtime boundary
  // (e.g. a future JSON-sourced caller) could still pass a number.
  assert.equal(deriveSessionTitle(42 as unknown as string), null);
  assert.equal(deriveSessionTitle(null as unknown as string), null);
  assert.equal(deriveSessionTitle(undefined as unknown as string), null);
  assert.equal(deriveSessionTitle({} as unknown as string), null);
});

// ---- Realistic shapes ---------------------------------------------

test("deriveSessionTitle: realistic first-ask shape — truncated pasted paragraph", () => {
  const msg =
    "I'd like to draft a campaign for the Summer Gala on June 15 at the " +
    "Marriott ballroom, invite all contacts tagged 'board-member', and " +
    "send through email with the Arabic locale template.";
  const out = deriveSessionTitle(msg);
  assert.ok(out);
  assert.equal(out.length, TITLE_MAX_CHARS);
  assert.ok(out.endsWith("…"));
  // The prefix should be human-readable (no mid-word cut that
  // produces a useless label). We don't force word boundaries (too
  // much complexity for a minor UX win), but the first few words
  // MUST survive.
  assert.ok(out.startsWith("I'd like to draft"));
});

test("deriveSessionTitle: short Arabic multi-line message — collapsed and trimmed", () => {
  const out = deriveSessionTitle("أرسل\nدعوات\n\nللحفل");
  assert.equal(out, "أرسل دعوات للحفل");
});
