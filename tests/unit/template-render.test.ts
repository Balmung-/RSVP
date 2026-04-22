import { test } from "node:test";
import assert from "node:assert/strict";

import { render, escapeHtml } from "../../src/lib/template";
import {
  GOVERNMENT_TEMPLATE_PACK,
  buildMissingGovernmentTemplates,
} from "../../src/lib/templates";

// P14-J pin set (half A) - `render()` and `escapeHtml()` in
// `src/lib/template.ts` are the two primitive string-manipulation
// functions that every invitation send and every operator-visible
// HTML field passes through:
//
//   - `render(template, vars)`: interpolates `{{name}}` tokens with
//     values from `vars`. Unknown tokens render as empty string.
//   - `escapeHtml(s)`: HTML-encodes five chars (`& < > " '`) for
//     safe insertion into HTML attributes and text content.
//
// A regression in either one corrupts the operator and invitee
// experience silently:
//
//   - `render` drift -> every invitation sent with raw handlebars
//     (`Hi {{name}}`) in the subject/body
//   - `escapeHtml` drift -> XSS vector in any field an operator types
//     that gets re-rendered (e.g., campaign descriptions, notes)
//
// These are pin-only targets - pure functions, already exported,
// ZERO test coverage. Same pattern as P14-F and P14-I halves.

// ---------------------------------------------------------------
// render - basic substitution.
// ---------------------------------------------------------------

test("render: single token substitutes from vars", () => {
  assert.equal(render("Hi {{name}}", { name: "Alice" }), "Hi Alice");
});

test("render: multiple distinct tokens interpolate in order", () => {
  assert.equal(
    render("{{greeting}}, {{name}}!", {
      greeting: "Hello",
      name: "Bob",
    }),
    "Hello, Bob!",
  );
});

test("render: repeated same token interpolates every occurrence", () => {
  assert.equal(
    render("{{brand}} invited you, regards {{brand}}", {
      brand: "Einai",
    }),
    "Einai invited you, regards Einai",
  );
});

test("render: adjacent tokens with no separator", () => {
  assert.equal(
    render("{{first}}{{last}}", { first: "Jane", last: "Doe" }),
    "JaneDoe",
  );
});

// ---------------------------------------------------------------
// render - unknown / missing token behavior (critical safety).
// ---------------------------------------------------------------

test("render: unknown token renders as empty string (NOT left as handlebars)", () => {
  assert.equal(
    render("Hi {{name}}!", {}),
    "Hi !",
  );
});

test("render: token with explicit undefined value renders as empty", () => {
  assert.equal(
    render("Hi {{name}}", { name: undefined }),
    "Hi ",
  );
});

test("render: empty-string value renders as empty (does not fall back)", () => {
  assert.equal(render("[{{brand}}]", { brand: "" }), "[]");
});

// ---------------------------------------------------------------
// render - whitespace + token-name rules.
// ---------------------------------------------------------------

test("render: whitespace inside handlebars tolerated - {{ name }} works", () => {
  assert.equal(
    render("Hi {{ name }}", { name: "Alice" }),
    "Hi Alice",
  );
});

test("render: token name allows dots (e.g., {{user.name}})", () => {
  assert.equal(
    render("Hi {{user.name}}", { "user.name": "Alice" }),
    "Hi Alice",
  );
});

test("render: token name with underscores and digits", () => {
  assert.equal(
    render("{{var_1}} {{var2}}", { var_1: "A", var2: "B" }),
    "A B",
  );
});

test("render: invalid token shapes are NOT substituted (literal leaked)", () => {
  assert.equal(
    render("{{ }} and {{has space}}", {}),
    "{{ }} and {{has space}}",
  );
});

// ---------------------------------------------------------------
// render - security properties.
// ---------------------------------------------------------------

test("render: one-pass - var values containing handlebars are NOT re-rendered", () => {
  const result = render(
    "Hi {{name}}",
    { name: "{{secret}}", secret: "SHOULD-NOT-APPEAR" },
  );
  assert.equal(result, "Hi {{secret}}");
  assert.ok(
    !result.includes("SHOULD-NOT-APPEAR"),
    "one-pass discipline - nested render MUST NOT resolve",
  );
});

test("render: html-like content in values passes through verbatim (no auto-escape)", () => {
  assert.equal(
    render("Hi {{name}}", { name: "<b>bold</b>" }),
    "Hi <b>bold</b>",
  );
});

// ---------------------------------------------------------------
// render - edge cases.
// ---------------------------------------------------------------

test("render: empty template -> empty string", () => {
  assert.equal(render("", { a: "x" }), "");
});

test("render: template with no tokens passes through verbatim", () => {
  assert.equal(
    render("Plain text, no tokens.", { unused: "x" }),
    "Plain text, no tokens.",
  );
});

test("render: token at start of string", () => {
  assert.equal(
    render("{{greeting}}, world!", { greeting: "Hello" }),
    "Hello, world!",
  );
});

test("render: token at end of string", () => {
  assert.equal(
    render("Hello, {{name}}", { name: "Bob" }),
    "Hello, Bob",
  );
});

// ---------------------------------------------------------------
// escapeHtml - each of the five chars + ordering + empty.
// ---------------------------------------------------------------

test("escapeHtml: & -> &amp; (MUST be first to avoid double-encoding)", () => {
  assert.equal(escapeHtml("a & b"), "a &amp; b");
});

test("escapeHtml: < -> &lt;", () => {
  assert.equal(escapeHtml("a < b"), "a &lt; b");
});

test("escapeHtml: > -> &gt;", () => {
  assert.equal(escapeHtml("a > b"), "a &gt; b");
});

test('escapeHtml: double-quote -> &quot;', () => {
  assert.equal(
    escapeHtml('say "hello"'),
    "say &quot;hello&quot;",
  );
});

test("escapeHtml: single-quote -> &#39;", () => {
  assert.equal(
    escapeHtml("don't"),
    "don&#39;t",
  );
});

test("escapeHtml: all five chars in one string - correct ORDER (no double-encoding)", () => {
  assert.equal(
    escapeHtml(`<"&'>`),
    "&lt;&quot;&amp;&#39;&gt;",
  );
});

test("escapeHtml: empty string -> empty string", () => {
  assert.equal(escapeHtml(""), "");
});

test("escapeHtml: plain text with no special chars passes through", () => {
  assert.equal(
    escapeHtml("Hello world 123"),
    "Hello world 123",
  );
});

test("escapeHtml: injection attempt - <script>alert('xss')</script>", () => {
  assert.equal(
    escapeHtml("<script>alert('xss')</script>"),
    "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;",
  );
});

test("government template pack: names are unique", () => {
  const names = GOVERNMENT_TEMPLATE_PACK.map((tpl) => tpl.name);
  assert.equal(new Set(names).size, names.length);
});

test("government template pack: missing-builder returns the full pack when nothing exists", () => {
  const missing = buildMissingGovernmentTemplates([]);
  assert.equal(missing.length, GOVERNMENT_TEMPLATE_PACK.length);
  assert.deepEqual(
    missing.map((tpl) => tpl.name),
    GOVERNMENT_TEMPLATE_PACK.map((tpl) => tpl.name),
  );
});

test("government template pack: existing names are filtered out exactly", () => {
  const missing = buildMissingGovernmentTemplates([
    "Ministry Invitation - Email (AR)",
    "Ministry RSVP Reminder - SMS (EN)",
  ]);
  assert.ok(!missing.some((tpl) => tpl.name === "Ministry Invitation - Email (AR)"));
  assert.ok(!missing.some((tpl) => tpl.name === "Ministry RSVP Reminder - SMS (EN)"));
  assert.equal(missing.length, GOVERNMENT_TEMPLATE_PACK.length - 2);
});

test("government template pack: returned rows are clones, not exported references", () => {
  const [first] = buildMissingGovernmentTemplates([]);
  assert.notEqual(first, GOVERNMENT_TEMPLATE_PACK[0]);
});
