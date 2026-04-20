import { test } from "node:test";
import assert from "node:assert/strict";

import { render, escapeHtml } from "../../src/lib/template";

// P14-J pin set (half A) — `render()` and `escapeHtml()` in
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
//   - `render` drift → every invitation sent with raw handlebars
//     (`Hi {{name}}`) in the subject/body
//   - `escapeHtml` drift → XSS vector in any field a operator types
//     that gets re-rendered (e.g., campaign descriptions, notes)
//
// These are pin-only targets — pure functions, already exported,
// ZERO test coverage. Same pattern as P14-F and P14-I halves.

// ---------------------------------------------------------------
// render — basic substitution.
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
  // Important for the email body: `{{brand}}` appears in both the
  // subject and the sign-off on the default template (see i18n.ts).
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
// render — unknown / missing token behavior (critical safety).
// ---------------------------------------------------------------

test("render: unknown token renders as empty string (NOT left as handlebars)", () => {
  // Load-bearing — if this regressed, operators would see literal
  // `{{unknown}}` in previews and invitees would receive
  // malformed templates. Empty-string is the safer fallback than
  // leaking the token syntax. Pinned.
  assert.equal(
    render("Hi {{name}}!", {}),
    "Hi !",
  );
});

test("render: token with explicit undefined value renders as empty", () => {
  // Subtle distinction from missing-key: a var that's explicitly
  // `undefined` should behave the same as missing. Pinned because
  // a regression using `vars[key] || ""` would conflate empty
  // string with missing (edge case doesn't change observable, but
  // a regression to `vars[key] ?? key` would).
  assert.equal(
    render("Hi {{name}}", { name: undefined }),
    "Hi ",
  );
});

test("render: empty-string value renders as empty (does not fall back)", () => {
  // Distinct from undefined — an operator explicitly setting
  // `{brand: ""}` intends an empty value, not a handlebars
  // fallback. `??` semantics preserve this.
  assert.equal(render("[{{brand}}]", { brand: "" }), "[]");
});

// ---------------------------------------------------------------
// render — whitespace + token-name rules.
// ---------------------------------------------------------------

test("render: whitespace inside handlebars tolerated — {{ name }} works", () => {
  // Mustache-like — trailing/leading whitespace inside the braces
  // is ignored. Pinned because operators hand-editing templates
  // may accidentally add spaces.
  assert.equal(
    render("Hi {{ name }}", { name: "Alice" }),
    "Hi Alice",
  );
});

test("render: token name allows dots (e.g., {{user.name}})", () => {
  // The regex allows dots in token names — this is consumed by
  // mustache-style dotted paths. But since `vars` is a FLAT
  // Record, the lookup uses the full key literally ("user.name"),
  // NOT nested resolution.
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
  // `{{ }}` (empty name), `{{with-dash}}` (dash not in char class),
  // `{{has space}}` (space in name). Because these don't match
  // the regex, they render verbatim — which is the correct
  // behavior (operator-visible sign that the template has a typo).
  assert.equal(
    render("{{ }} and {{has space}}", {}),
    "{{ }} and {{has space}}",
  );
});

// ---------------------------------------------------------------
// render — security properties.
// ---------------------------------------------------------------

test("render: one-pass — var values containing handlebars are NOT re-rendered", () => {
  // SECURITY: if vars.name = "{{secret}}" and the result were
  // re-scanned, we could leak the `secret` value. One-pass
  // discipline means the output keeps the handlebars literal.
  // Pinned.
  const result = render(
    "Hi {{name}}",
    { name: "{{secret}}", secret: "SHOULD-NOT-APPEAR" },
  );
  assert.equal(result, "Hi {{secret}}");
  assert.ok(
    !result.includes("SHOULD-NOT-APPEAR"),
    "one-pass discipline — nested render MUST NOT resolve",
  );
});

test("render: html-like content in values passes through verbatim (no auto-escape)", () => {
  // `render` does NOT html-escape — that's escapeHtml's job,
  // called separately on untrusted fields. Pinned so a refactor
  // that adds auto-escape doesn't silently break the plain-text
  // template path (which deliberately passes `<` through as a
  // literal for the email client to render).
  assert.equal(
    render("Hi {{name}}", { name: "<b>bold</b>" }),
    "Hi <b>bold</b>",
  );
});

// ---------------------------------------------------------------
// render — edge cases.
// ---------------------------------------------------------------

test("render: empty template → empty string", () => {
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
// escapeHtml — each of the five chars + ordering + empty.
// ---------------------------------------------------------------

test("escapeHtml: & → &amp; (MUST be first to avoid double-encoding)", () => {
  // Critical ordering — if `&` ran after `<` → `&lt;`, the
  // ampersand in `&lt;` would then encode to `&amp;lt;`, yielding
  // literal `&amp;lt;` in the output (visible corruption).
  assert.equal(escapeHtml("a & b"), "a &amp; b");
});

test("escapeHtml: < → &lt;", () => {
  assert.equal(escapeHtml("a < b"), "a &lt; b");
});

test("escapeHtml: > → &gt;", () => {
  assert.equal(escapeHtml("a > b"), "a &gt; b");
});

test("escapeHtml: double-quote → &quot;", () => {
  assert.equal(
    escapeHtml('say "hello"'),
    "say &quot;hello&quot;",
  );
});

test("escapeHtml: single-quote → &#39;", () => {
  // Apostrophe encoding prevents attribute-value injection like
  // `value='...'`. The numeric entity &#39; is used instead of
  // &apos; because &apos; is not HTML4-safe.
  assert.equal(
    escapeHtml("don't"),
    "don&#39;t",
  );
});

test("escapeHtml: all five chars in one string — correct ORDER (no double-encoding)", () => {
  // The killer ordering test. If & were not encoded first, the
  // < → &lt; substitution would double-encode. Pinned.
  assert.equal(
    escapeHtml(`<"&'>`),
    "&lt;&quot;&amp;&#39;&gt;",
  );
});

test("escapeHtml: empty string → empty string", () => {
  assert.equal(escapeHtml(""), "");
});

test("escapeHtml: plain text with no special chars passes through", () => {
  assert.equal(
    escapeHtml("Hello world 123"),
    "Hello world 123",
  );
});

test("escapeHtml: injection attempt — <script>alert('xss')</script>", () => {
  // Classic XSS — pinned to verify escapeHtml handles the
  // canonical payload safely.
  assert.equal(
    escapeHtml("<script>alert('xss')</script>"),
    "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;",
  );
});
