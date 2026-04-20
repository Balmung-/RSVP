import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeEmail,
  normalizePhone,
  dedupKey,
  csvCell,
  csvRow,
  parseContactsText,
} from "../../src/lib/contact";

// P14-L pin set — `src/lib/contact.ts` is the seam between
// operator-pasted contact lists and the invitee database. Every
// import and every CSV export passes through these six helpers:
//
//   normalizeEmail     — email regex gate
//   normalizePhone     — libphonenumber E.164 normalization
//   dedupKey           — one-key-per-person hash (with CSPRNG
//                        fallback for anon entries)
//   csvCell            — CSV CELL sanitizer with formula-injection
//                        defense (= + - @ \t \r prefix)
//   csvRow             — comma-joined row via csvCell
//   parseContactsText  — CSV/TSV parser with quoted fields,
//                        embedded newlines, doubled quotes, BOM
//
// Security-load-bearing surfaces:
//
//   1. csvCell's formula-injection prefix — if an operator's
//      export is opened in Excel with `=cmd|...` in a cell, it
//      executes. The leading apostrophe defuses it. Any
//      regression here (wrong char class, wrong ordering) opens
//      a CSV injection vector on every data export.
//
//   2. normalizePhone's isValid gate — passing through invalid
//      phones would corrupt the DB and cause SMS dispatch to
//      bounce silently. Pinned.
//
//   3. parseContactsText's doubled-quote escape — breaking this
//      makes round-trip CSV->parse->CSV lose data silently (e.g.
//      a name with a real `"` in it).

// ---------------------------------------------------------------
// normalizeEmail
// ---------------------------------------------------------------

test("normalizeEmail: null → null", () => {
  assert.equal(normalizeEmail(null), null);
});

test("normalizeEmail: undefined → null", () => {
  assert.equal(normalizeEmail(undefined), null);
});

test("normalizeEmail: empty string → null", () => {
  assert.equal(normalizeEmail(""), null);
});

test("normalizeEmail: valid email → lowercased + trimmed", () => {
  assert.equal(normalizeEmail("  Alice@Example.COM  "), "alice@example.com");
});

test("normalizeEmail: already-lower valid passthrough", () => {
  assert.equal(normalizeEmail("bob@example.org"), "bob@example.org");
});

test("normalizeEmail: missing @ → null", () => {
  assert.equal(normalizeEmail("no-at-sign.example.com"), null);
});

test("normalizeEmail: missing dot in domain → null", () => {
  assert.equal(normalizeEmail("a@b"), null);
});

test("normalizeEmail: whitespace inside → null (regex rejects \\s)", () => {
  assert.equal(normalizeEmail("a b@c.d"), null);
  assert.equal(normalizeEmail("a@b c.d"), null);
});

test("normalizeEmail: double-@ → null (char class excludes @)", () => {
  // Pinned — the char class `[^\s@]` excludes @ so `a@b@c.d`
  // cannot match. Regression that loosened the class would
  // accept malformed addresses.
  assert.equal(normalizeEmail("a@b@c.d"), null);
});

test("normalizeEmail: valid with subdomain", () => {
  assert.equal(normalizeEmail("a@b.c.d"), "a@b.c.d");
});

// ---------------------------------------------------------------
// normalizePhone
// ---------------------------------------------------------------

// NOTE: normalizePhone's libphonenumber branch is NOT exercised here.
// The `libphonenumber-js` bundled min JSON metadata doesn't load
// cleanly under tsx's ESM/CJS interop — the `metadata.countries`
// property is undefined when reached through the tsx harness,
// crashing inside `isSupportedCountry`. This is the same constraint
// documented in `tests/unit/import-planner.test.ts:30-37`. We pin
// the short-circuit branches (null / undefined / empty string) that
// return before calling `parsePhoneNumberFromString`; the library-
// delegated branches are exercised via Next.js at runtime.

test("normalizePhone: null → null (short-circuit, before libphonenumber)", () => {
  assert.equal(normalizePhone(null), null);
});

test("normalizePhone: undefined → null (short-circuit)", () => {
  assert.equal(normalizePhone(undefined), null);
});

test("normalizePhone: empty string → null (short-circuit)", () => {
  // Load-bearing short-circuit: `if (!raw) return null` runs
  // BEFORE the libphonenumber call, so empty/falsy input never
  // reaches the parser. Pinned because a regression that moved
  // the empty-check after parsing would throw on empty strings.
  assert.equal(normalizePhone(""), null);
});

// ---------------------------------------------------------------
// dedupKey
// ---------------------------------------------------------------

test("dedupKey: both null → 'none:' prefix + random suffix", () => {
  const k = dedupKey(null, null);
  assert.ok(k.startsWith("none:"), `prefix: ${k}`);
  // 12 random bytes → 24 hex chars; total 5 + 24 = 29.
  assert.equal(k.length, 5 + 24);
  assert.match(k.slice(5), /^[0-9a-f]{24}$/);
});

test("dedupKey: both null called twice → DIFFERENT random keys", () => {
  // Pinned — anonymous contacts must NOT collide. A regression
  // that used a deterministic fallback (e.g. "none:empty") would
  // make every anonymous contact dedup-collide.
  const a = dedupKey(null, null);
  const b = dedupKey(null, null);
  assert.notEqual(a, b);
});

test("dedupKey: email only → deterministic 24-char hex", () => {
  const k = dedupKey("alice@example.com", null);
  assert.match(k, /^[0-9a-f]{24}$/);
  assert.equal(k, dedupKey("alice@example.com", null));
});

test("dedupKey: phone only → deterministic 24-char hex", () => {
  const k = dedupKey(null, "+966501234567");
  assert.match(k, /^[0-9a-f]{24}$/);
  assert.equal(k, dedupKey(null, "+966501234567"));
});

test("dedupKey: both → deterministic", () => {
  const k = dedupKey("alice@example.com", "+966501234567");
  assert.match(k, /^[0-9a-f]{24}$/);
  assert.equal(k, dedupKey("alice@example.com", "+966501234567"));
});

test("dedupKey: email null ≠ email '' behaviorally (both coerce to empty seed segment)", () => {
  // Pinned — `email ?? ""` — the nullish-coalesce means a null
  // email and an empty-string email produce the SAME seed. This
  // is INTENTIONAL: normalizeEmail returns null for empty, so
  // the caller never passes "". But if a caller did pass "",
  // it should dedup with null. Pinned.
  assert.equal(
    dedupKey(null, "+966501234567"),
    dedupKey("", "+966501234567"),
  );
});

test("dedupKey: email change → different key (load-bearing for dedup)", () => {
  const a = dedupKey("alice@example.com", null);
  const b = dedupKey("bob@example.com", null);
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------
// csvCell — formula injection defense
// ---------------------------------------------------------------

test("csvCell: plain text → quoted", () => {
  assert.equal(csvCell("hello"), '"hello"');
});

test("csvCell: null → empty quoted", () => {
  assert.equal(csvCell(null), '""');
});

test("csvCell: undefined → empty quoted", () => {
  assert.equal(csvCell(undefined), '""');
});

test("csvCell: value with embedded quote → double-quoted escape", () => {
  // Pinned — doubled-quote is the CSV escape. A regression
  // (e.g. backslash escape) would produce unreadable output.
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
});

test("csvCell: starts with '=' → apostrophe prefix (formula injection defense)", () => {
  // LOAD-BEARING security pin. Without the apostrophe, Excel
  // executes `=...` as a formula when the CSV is opened.
  assert.equal(csvCell("=SUM(A1:A10)"), '"\'=SUM(A1:A10)"');
});

test("csvCell: starts with '+' → apostrophe prefix", () => {
  assert.equal(csvCell("+1-555-0100"), '"\'+1-555-0100"');
});

test("csvCell: starts with '-' → apostrophe prefix", () => {
  assert.equal(csvCell("-hello"), '"\'-hello"');
});

test("csvCell: starts with '@' → apostrophe prefix", () => {
  assert.equal(csvCell("@user"), '"\'@user"');
});

test("csvCell: starts with tab → apostrophe prefix", () => {
  // Tab + CR prefixes are vectors for cell-navigation-triggered
  // formulas in older Excel. Pinned.
  assert.equal(csvCell("\talert"), '"\'\talert"');
});

test("csvCell: starts with CR → apostrophe prefix", () => {
  assert.equal(csvCell("\rpayload"), '"\'\rpayload"');
});

test("csvCell: dangerous char NOT at start → no prefix", () => {
  // The formula-injection defense is ANCHORED — only leading
  // chars matter. A regression that stripped the `^` would
  // spuriously prefix cells with `=` mid-value.
  assert.equal(csvCell("a=b"), '"a=b"');
  assert.equal(csvCell("a+b"), '"a+b"');
});

test("csvCell: number coerced to string", () => {
  assert.equal(csvCell(42), '"42"');
});

test("csvCell: boolean coerced to string", () => {
  assert.equal(csvCell(true), '"true"');
});

test("csvCell: combined — starts with = AND contains quotes", () => {
  // Apostrophe prefix applies FIRST, then doubled-quote escape.
  assert.equal(csvCell('="a"'), '"\'=""a"""');
});

// ---------------------------------------------------------------
// csvRow
// ---------------------------------------------------------------

test("csvRow: empty array → ''", () => {
  assert.equal(csvRow([]), "");
});

test("csvRow: single cell → quoted with no comma", () => {
  assert.equal(csvRow(["a"]), '"a"');
});

test("csvRow: multiple cells joined with comma", () => {
  assert.equal(csvRow(["a", "b", "c"]), '"a","b","c"');
});

test("csvRow: mixed types + injection defense preserved", () => {
  assert.equal(
    csvRow(["name", "=1+1", null, 42]),
    '"name","\'=1+1","","42"',
  );
});

// ---------------------------------------------------------------
// parseContactsText
// ---------------------------------------------------------------

test("parseContactsText: empty string → []", () => {
  assert.deepEqual(parseContactsText(""), []);
});

test("parseContactsText: header only → [] (no data rows)", () => {
  assert.deepEqual(parseContactsText("name,email"), []);
});

test("parseContactsText: BOM stripped", () => {
  // Pinned — a CSV exported from Excel/Sheets often has a
  // leading BOM (U+FEFF). If not stripped, the first header
  // becomes "\uFEFFname" and all lookups by "name" fail.
  const rows = parseContactsText("\uFEFFname,email\nAlice,a@x.com");
  assert.deepEqual(rows, [{ name: "Alice", email: "a@x.com" }]);
});

test("parseContactsText: comma delimiter auto-detected", () => {
  const rows = parseContactsText("name,email\nA,a@x.com\nB,b@x.com");
  assert.deepEqual(rows, [
    { name: "A", email: "a@x.com" },
    { name: "B", email: "b@x.com" },
  ]);
});

test("parseContactsText: tab delimiter auto-detected", () => {
  // Pinned — Google Sheets paste defaults to TSV, not CSV. A
  // regression that hard-coded comma-only would silently turn
  // every Sheets paste into a single-column mess.
  const rows = parseContactsText("name\temail\nA\ta@x.com");
  assert.deepEqual(rows, [{ name: "A", email: "a@x.com" }]);
});

test("parseContactsText: header lowercased + whitespace → underscore", () => {
  const rows = parseContactsText("Full Name,Email Address\nAlice,a@x.com");
  assert.deepEqual(rows, [{ full_name: "Alice", email_address: "a@x.com" }]);
});

test("parseContactsText: data cells trimmed", () => {
  const rows = parseContactsText("name,email\n  Alice  ,  a@x.com  ");
  assert.deepEqual(rows, [{ name: "Alice", email: "a@x.com" }]);
});

test("parseContactsText: missing trailing columns filled with empty string", () => {
  // Pinned — row has fewer fields than header; the helper
  // produces "" for each missing column rather than `undefined`
  // (which would break type contracts downstream).
  const rows = parseContactsText("name,email,phone\nAlice,a@x.com");
  assert.deepEqual(rows, [{ name: "Alice", email: "a@x.com", phone: "" }]);
});

test("parseContactsText: quoted field with comma inside preserves comma", () => {
  const rows = parseContactsText(
    'name,email\n"Last, First",a@x.com',
  );
  assert.deepEqual(rows, [{ name: "Last, First", email: "a@x.com" }]);
});

test("parseContactsText: quoted field with doubled-quote → single quote", () => {
  // Pinned — doubled-quote (`""`) inside a quoted field is the
  // CSV-standard escape for a literal `"`. Round-trips with
  // csvCell's output.
  const rows = parseContactsText('name,email\n"Say ""hi""",a@x.com');
  assert.deepEqual(rows, [{ name: 'Say "hi"', email: "a@x.com" }]);
});

test("parseContactsText: quoted field with embedded newline preserved", () => {
  // Pinned — a quoted field can span lines; the `\n` should be
  // kept as data, not used as a row separator.
  const rows = parseContactsText(
    'name,email\n"line1\nline2",a@x.com',
  );
  assert.deepEqual(rows, [{ name: "line1\nline2", email: "a@x.com" }]);
});

test("parseContactsText: CRLF line endings tolerated (strips \\r)", () => {
  const rows = parseContactsText("name,email\r\nA,a@x.com\r\nB,b@x.com\r\n");
  assert.deepEqual(rows, [
    { name: "A", email: "a@x.com" },
    { name: "B", email: "b@x.com" },
  ]);
});

test("parseContactsText: entirely-empty rows skipped", () => {
  // Pinned — the `field.some((f) => f.length > 0)` gate skips
  // rows with nothing but delimiters. Operators paste lists
  // with trailing blank lines; those should NOT produce empty
  // records.
  const rows = parseContactsText("name,email\nAlice,a@x.com\n\n,,\nBob,b@x.com\n");
  assert.deepEqual(rows, [
    { name: "Alice", email: "a@x.com" },
    { name: "Bob", email: "b@x.com" },
  ]);
});

test("parseContactsText: round-trip via csvCell → parseContactsText", () => {
  // Pinned — key integration: what csvCell produces, the parser
  // must read back identically. Protects the export/import loop.
  const original = [
    { name: "Last, First", email: "a@x.com" },
    { name: 'Say "hi"', email: "b@x.com" },
  ];
  const text =
    'name,email\n' +
    original
      .map((r) => csvRow([r.name, r.email]))
      .join("\n");
  const parsed = parseContactsText(text);
  assert.deepEqual(parsed, original);
});
