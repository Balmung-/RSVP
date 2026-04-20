import { test } from "node:test";
import assert from "node:assert/strict";
import type { CampaignQuestion } from "@prisma/client";

import {
  parseOptions,
  needsOptions,
  filterForState,
  validateAnswers,
  type QuestionKind,
  type ShowWhen,
} from "../../src/lib/questions";

// P14-K pin set — `src/lib/questions.ts` powers the public RSVP
// form that runs against EVERY invitee: parseOptions +
// needsOptions + filterForState + validateAnswers. Collectively
// they validate + coerce every answer the invitee submits, and
// determine which questions they see.
//
// Regression surfaces protected:
//
//   1. `parseOptions` — options are stored newline-separated; a
//      regression in the split/trim/filter pipeline makes every
//      select-kind question silently reject valid answers.
//
//   2. `needsOptions` — `kind === "single_select" || "multi_select"`.
//      A regression (e.g. adding "boolean" to the list) would
//      persist a stale `options` blob on boolean questions, and
//      conversely dropping "multi_select" would lose all options
//      on multi-select questions on every edit.
//
//   3. `filterForState` — showWhen is `always | attending | declined`.
//      The attending=null case is LOAD-BEARING: the admin preview
//      page passes null for "haven't decided yet" invitees. A
//      regression that shows `attending`-gated questions to them
//      leaks conditional questions prematurely.
//
//   4. `validateAnswers` — the whole coerce + validate pipeline:
//      - empty detection (null, empty string, whitespace-only,
//        empty array) → required → errors[id]="required"
//      - short_text / long_text truncation limits (300 / 5000)
//      - number → Number.isFinite gate (rejects NaN, Infinity)
//      - boolean truthy set ("true"|"yes"|"on"|"1",
//        case-insensitive via toLowerCase) — everything else false
//      - single_select membership check against parsed options
//      - multi_select filter-to-valid with required=0 check
//
//   This is a public-form pin set — every one of these is a
//   data-loss class regression if it breaks.

// ---------------------------------------------------------------
// Mock factory — build a minimal CampaignQuestion row.
// ---------------------------------------------------------------

function q(fields: {
  id?: string;
  kind: QuestionKind;
  required?: boolean;
  options?: string | null;
  showWhen?: ShowWhen;
  prompt?: string;
}): CampaignQuestion {
  return {
    id: fields.id ?? "q1",
    campaignId: "c1",
    order: 0,
    prompt: fields.prompt ?? "prompt?",
    kind: fields.kind,
    required: fields.required ?? false,
    options: fields.options ?? null,
    showWhen: fields.showWhen ?? "always",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

// ---------------------------------------------------------------
// parseOptions
// ---------------------------------------------------------------

test("parseOptions: null → []", () => {
  assert.deepEqual(parseOptions(null), []);
});

test("parseOptions: undefined → []", () => {
  assert.deepEqual(parseOptions(undefined), []);
});

test("parseOptions: empty string → []", () => {
  assert.deepEqual(parseOptions(""), []);
});

test("parseOptions: single line (no newline) → one element", () => {
  assert.deepEqual(parseOptions("hello"), ["hello"]);
});

test("parseOptions: LF-separated → split and preserved in order", () => {
  assert.deepEqual(parseOptions("a\nb\nc"), ["a", "b", "c"]);
});

test("parseOptions: CRLF-separated → split (regex tolerates \\r?\\n)", () => {
  assert.deepEqual(parseOptions("a\r\nb\r\nc"), ["a", "b", "c"]);
});

test("parseOptions: trims leading + trailing whitespace on each line", () => {
  assert.deepEqual(parseOptions("  a  \n\tb\t\n c"), ["a", "b", "c"]);
});

test("parseOptions: drops blank lines (pure whitespace)", () => {
  // Pinned — operator may type extra newlines in the options
  // textarea; those must not become empty options.
  assert.deepEqual(parseOptions("a\n\n   \nb"), ["a", "b"]);
});

test("parseOptions: preserves duplicates (NOT de-duped)", () => {
  // Pinned — the function is a pure split; dedup policy lives
  // elsewhere (the form's Set() usage). Changing this would
  // silently affect multi-select semantics.
  assert.deepEqual(parseOptions("a\nb\na"), ["a", "b", "a"]);
});

// ---------------------------------------------------------------
// needsOptions
// ---------------------------------------------------------------

test("needsOptions: single_select → true", () => {
  assert.equal(needsOptions("single_select"), true);
});

test("needsOptions: multi_select → true", () => {
  assert.equal(needsOptions("multi_select"), true);
});

test("needsOptions: short_text → false", () => {
  assert.equal(needsOptions("short_text"), false);
});

test("needsOptions: long_text → false", () => {
  assert.equal(needsOptions("long_text"), false);
});

test("needsOptions: number → false", () => {
  assert.equal(needsOptions("number"), false);
});

test("needsOptions: boolean → false", () => {
  // Load-bearing — boolean adds to the truthy set from form
  // submissions, NOT an options list. A regression that returned
  // true here would silently persist stale option blobs.
  assert.equal(needsOptions("boolean"), false);
});

// ---------------------------------------------------------------
// filterForState
// ---------------------------------------------------------------

test("filterForState: always always passes (any attending state)", () => {
  const qs = [q({ kind: "short_text", showWhen: "always" })];
  assert.equal(filterForState(qs, true).length, 1);
  assert.equal(filterForState(qs, false).length, 1);
  assert.equal(filterForState(qs, null).length, 1);
});

test("filterForState: attending=true + showWhen=attending → included", () => {
  const qs = [q({ kind: "short_text", showWhen: "attending" })];
  assert.equal(filterForState(qs, true).length, 1);
});

test("filterForState: attending=true + showWhen=declined → dropped", () => {
  const qs = [q({ kind: "short_text", showWhen: "declined" })];
  assert.equal(filterForState(qs, true).length, 0);
});

test("filterForState: attending=false + showWhen=declined → included", () => {
  const qs = [q({ kind: "short_text", showWhen: "declined" })];
  assert.equal(filterForState(qs, false).length, 1);
});

test("filterForState: attending=false + showWhen=attending → dropped", () => {
  const qs = [q({ kind: "short_text", showWhen: "attending" })];
  assert.equal(filterForState(qs, false).length, 0);
});

test("filterForState: attending=null drops conditional questions (LOAD-BEARING)", () => {
  // Pinned — admin preview passes null for undecided invitees.
  // A regression that treated null as attending OR declined
  // would leak conditional questions prematurely.
  const qs = [
    q({ id: "a", kind: "short_text", showWhen: "attending" }),
    q({ id: "b", kind: "short_text", showWhen: "declined" }),
    q({ id: "c", kind: "short_text", showWhen: "always" }),
  ];
  const out = filterForState(qs, null);
  assert.deepEqual(
    out.map((x) => x.id),
    ["c"],
  );
});

test("filterForState: preserves input order", () => {
  const qs = [
    q({ id: "a", kind: "short_text", showWhen: "always" }),
    q({ id: "b", kind: "short_text", showWhen: "attending" }),
    q({ id: "c", kind: "short_text", showWhen: "always" }),
  ];
  const out = filterForState(qs, true);
  assert.deepEqual(
    out.map((x) => x.id),
    ["a", "b", "c"],
  );
});

// ---------------------------------------------------------------
// validateAnswers — empty / required semantics.
// ---------------------------------------------------------------

test("validateAnswers: required + missing key → errors[id]='required'", () => {
  const qs = [q({ id: "x", kind: "short_text", required: true })];
  const r = validateAnswers(qs, {});
  assert.deepEqual(r, { ok: false, errors: { x: "required" } });
});

test("validateAnswers: required + empty string → errors[id]='required'", () => {
  const qs = [q({ id: "x", kind: "short_text", required: true })];
  const r = validateAnswers(qs, { x: "" });
  assert.deepEqual(r, { ok: false, errors: { x: "required" } });
});

test("validateAnswers: required + whitespace-only string → required (via trim)", () => {
  // Pinned — whitespace-only must fail-required. A regression
  // from `.trim()` to raw length check would pass through.
  const qs = [q({ id: "x", kind: "short_text", required: true })];
  const r = validateAnswers(qs, { x: "   \t\n  " });
  assert.deepEqual(r, { ok: false, errors: { x: "required" } });
});

test("validateAnswers: required + empty array → errors[id]='required'", () => {
  const qs = [q({ id: "x", kind: "multi_select", required: true, options: "a\nb" })];
  const r = validateAnswers(qs, { x: [] });
  assert.deepEqual(r, { ok: false, errors: { x: "required" } });
});

test("validateAnswers: NOT required + missing → skipped (no entry in answers)", () => {
  const qs = [q({ id: "x", kind: "short_text", required: false })];
  const r = validateAnswers(qs, {});
  assert.deepEqual(r, { ok: true, answers: [] });
});

test("validateAnswers: NOT required + empty string → skipped", () => {
  const qs = [q({ id: "x", kind: "short_text", required: false })];
  const r = validateAnswers(qs, { x: "" });
  assert.deepEqual(r, { ok: true, answers: [] });
});

// ---------------------------------------------------------------
// validateAnswers — short_text / long_text truncation.
// ---------------------------------------------------------------

test("validateAnswers: short_text truncates to 300 chars", () => {
  const qs = [q({ id: "x", kind: "short_text" })];
  const input = "a".repeat(500);
  const r = validateAnswers(qs, { x: input });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.answers[0].value.length, 300);
    assert.equal(r.answers[0].value, "a".repeat(300));
  }
});

test("validateAnswers: long_text truncates to 5000 chars (NOT 300)", () => {
  // Pinned — the ternary is the discriminator:
  //   `q.kind === "short_text" ? 300 : 5000`
  // A regression to always-300 would silently drop 94% of long_text.
  const qs = [q({ id: "x", kind: "long_text" })];
  const input = "a".repeat(10000);
  const r = validateAnswers(qs, { x: input });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.answers[0].value.length, 5000);
  }
});

test("validateAnswers: short_text under limit passes through verbatim", () => {
  const qs = [q({ id: "x", kind: "short_text" })];
  const r = validateAnswers(qs, { x: "hello world" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.answers[0].value, "hello world");
});

// ---------------------------------------------------------------
// validateAnswers — number kind.
// ---------------------------------------------------------------

test("validateAnswers: number — valid integer string", () => {
  const qs = [q({ id: "x", kind: "number" })];
  const r = validateAnswers(qs, { x: "42" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.answers[0].value, "42");
});

test("validateAnswers: number — valid float string", () => {
  const qs = [q({ id: "x", kind: "number" })];
  const r = validateAnswers(qs, { x: "3.14" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.answers[0].value, "3.14");
});

test("validateAnswers: number — non-numeric → errors[id]='invalid_number'", () => {
  const qs = [q({ id: "x", kind: "number" })];
  const r = validateAnswers(qs, { x: "abc" });
  assert.deepEqual(r, { ok: false, errors: { x: "invalid_number" } });
});

test("validateAnswers: number — 'Infinity' rejected (Number.isFinite gate)", () => {
  // Pinned — Number.isFinite guards against both NaN and ±Infinity.
  // A regression from `Number.isFinite(n)` to `!Number.isNaN(n)`
  // would allow Infinity through.
  const qs = [q({ id: "x", kind: "number" })];
  const r = validateAnswers(qs, { x: "Infinity" });
  assert.deepEqual(r, { ok: false, errors: { x: "invalid_number" } });
});

// ---------------------------------------------------------------
// validateAnswers — boolean kind (truthy set).
// ---------------------------------------------------------------

test("validateAnswers: boolean — 'true' → 'true'", () => {
  const qs = [q({ id: "x", kind: "boolean" })];
  const r = validateAnswers(qs, { x: "true" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.answers[0].value, "true");
});

test("validateAnswers: boolean — 'yes'/'on'/'1' all → 'true'", () => {
  const qs = [q({ id: "x", kind: "boolean" })];
  for (const v of ["yes", "on", "1"]) {
    const r = validateAnswers(qs, { x: v });
    assert.equal(r.ok, true, `truthy value: ${v}`);
    if (r.ok) assert.equal(r.answers[0].value, "true", `truthy value: ${v}`);
  }
});

test("validateAnswers: boolean — case-insensitive ('TRUE', 'Yes')", () => {
  // Pinned — toLowerCase before compare. A regression that
  // dropped the toLowerCase would reject "TRUE" as false.
  const qs = [q({ id: "x", kind: "boolean" })];
  for (const v of ["TRUE", "Yes", "ON"]) {
    const r = validateAnswers(qs, { x: v });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.answers[0].value, "true", `case-insensitive: ${v}`);
  }
});

test("validateAnswers: boolean — 'false' → 'false'", () => {
  const qs = [q({ id: "x", kind: "boolean" })];
  const r = validateAnswers(qs, { x: "false" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.answers[0].value, "false");
});

test("validateAnswers: boolean — non-truthy falls to 'false' (NOT an error)", () => {
  // Pinned — anything that isn't in the truthy set is "false",
  // NOT an invalid_boolean error. A regression that errored on
  // unknown strings would break HTML checkbox semantics (absent
  // checkbox never submits "false"; our fallback handles it).
  const qs = [q({ id: "x", kind: "boolean" })];
  for (const v of ["no", "0", "off", "anything-else"]) {
    const r = validateAnswers(qs, { x: v });
    assert.equal(r.ok, true, `falsy: ${v}`);
    if (r.ok) assert.equal(r.answers[0].value, "false", `falsy: ${v}`);
  }
});

// ---------------------------------------------------------------
// validateAnswers — single_select.
// ---------------------------------------------------------------

test("validateAnswers: single_select — value in options → accepted", () => {
  const qs = [
    q({ id: "x", kind: "single_select", options: "red\ngreen\nblue" }),
  ];
  const r = validateAnswers(qs, { x: "green" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.answers[0].value, "green");
});

test("validateAnswers: single_select — value NOT in options → errors[id]='invalid_choice'", () => {
  const qs = [
    q({ id: "x", kind: "single_select", options: "red\ngreen\nblue" }),
  ];
  const r = validateAnswers(qs, { x: "purple" });
  assert.deepEqual(r, { ok: false, errors: { x: "invalid_choice" } });
});

test("validateAnswers: single_select — blank lines in options stripped before check", () => {
  // Pinned — the membership check runs against parseOptions,
  // which drops blank lines. A regression that compared
  // options.split("\n") directly would accept "" as a choice
  // (and equally, miss "red" if there's a trailing newline on
  // an option row that wasn't trimmed).
  const qs = [
    q({ id: "x", kind: "single_select", options: "\nred\n\ngreen\n  \n" }),
  ];
  const r = validateAnswers(qs, { x: "red" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.answers[0].value, "red");
});

// ---------------------------------------------------------------
// validateAnswers — multi_select.
// ---------------------------------------------------------------

test("validateAnswers: multi_select — all valid values → joined by newline", () => {
  const qs = [
    q({ id: "x", kind: "multi_select", options: "a\nb\nc" }),
  ];
  const r = validateAnswers(qs, { x: ["a", "c"] });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.answers[0].value, "a\nc");
});

test("validateAnswers: multi_select — filters invalid values silently", () => {
  // Pinned — invalid picks are DROPPED, not error. This is how
  // stale options handle gracefully (old answer references an
  // option that operator since deleted — keep the valid ones).
  const qs = [
    q({ id: "x", kind: "multi_select", options: "a\nb\nc" }),
  ];
  const r = validateAnswers(qs, { x: ["a", "zzz", "c", "qqq"] });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.answers[0].value, "a\nc");
});

test("validateAnswers: multi_select — required + all-invalid → errors[id]='required'", () => {
  // Pinned — after filtering, if NO valid picks remain AND
  // required, it's a "required" error (NOT invalid_choice).
  const qs = [
    q({ id: "x", kind: "multi_select", required: true, options: "a\nb" }),
  ];
  const r = validateAnswers(qs, { x: ["zzz", "qqq"] });
  assert.deepEqual(r, { ok: false, errors: { x: "required" } });
});

test("validateAnswers: multi_select — string value (not array) coerced to single-element array", () => {
  // Pinned — FormData.getAll can legitimately return a single
  // string, not always an array. The `Array.isArray` branch
  // wraps it. A regression that only accepted arrays would reject
  // single-pick multi-selects.
  const qs = [
    q({ id: "x", kind: "multi_select", options: "a\nb\nc" }),
  ];
  const r = validateAnswers(qs, { x: "b" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.answers[0].value, "b");
});

test("validateAnswers: multi_select — NOT required + all-invalid → empty value stored", () => {
  // Pinned — non-required + all-invalid produces an empty string
  // value, NOT an error, NOT a skip. The answer row is still
  // created to record "invitee submitted, but nothing matched".
  const qs = [
    q({ id: "x", kind: "multi_select", required: false, options: "a\nb" }),
  ];
  const r = validateAnswers(qs, { x: ["zzz"] });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.answers[0].questionId, "x");
    assert.equal(r.answers[0].value, "");
  }
});

// ---------------------------------------------------------------
// validateAnswers — integration.
// ---------------------------------------------------------------

test("validateAnswers: multiple questions, mixed success/error → returns errors only", () => {
  // Pinned — if ANY question errors, the whole submission returns
  // `{ ok: false, errors }` (dropping the partial answers).
  // Protects the "all-or-nothing commit" discipline in the route.
  const qs = [
    q({ id: "a", kind: "short_text", required: true }),
    q({ id: "b", kind: "number", required: true }),
  ];
  const r = validateAnswers(qs, { a: "hello", b: "not-a-number" });
  assert.deepEqual(r, { ok: false, errors: { b: "invalid_number" } });
});

test("validateAnswers: multiple questions, all success → single ok with all answers in order", () => {
  const qs = [
    q({ id: "a", kind: "short_text" }),
    q({ id: "b", kind: "number" }),
    q({ id: "c", kind: "boolean" }),
  ];
  const r = validateAnswers(qs, { a: "hi", b: "7", c: "yes" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.answers, [
      { questionId: "a", value: "hi" },
      { questionId: "b", value: "7" },
      { questionId: "c", value: "true" },
    ]);
  }
});

test("validateAnswers: unknown kind → skipped via default case (no throw, no entry)", () => {
  // Pinned — a forward-compat question kind shouldn't crash the
  // RSVP form. The default branch `continue`s, producing no
  // error and no answer for that question.
  const qs = [
    q({ id: "a", kind: "short_text" }),
    q({ id: "b", kind: "future_kind" as unknown as QuestionKind }),
    q({ id: "c", kind: "short_text" }),
  ];
  const r = validateAnswers(qs, { a: "ok", b: "whatever", c: "also-ok" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(
      r.answers.map((x) => x.questionId),
      ["a", "c"],
    );
  }
});

test("validateAnswers: errors accumulated across questions (one entry per id)", () => {
  const qs = [
    q({ id: "a", kind: "number", required: true }),
    q({ id: "b", kind: "single_select", options: "x\ny" }),
  ];
  const r = validateAnswers(qs, { a: "nope", b: "z" });
  assert.deepEqual(r, {
    ok: false,
    errors: { a: "invalid_number", b: "invalid_choice" },
  });
});
