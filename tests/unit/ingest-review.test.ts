import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkContactRowIssues,
  detectDelimiter,
  detectHeader,
  detectTarget,
  normalizeLabel,
  normalizePhoneDigits,
  normalizeRow,
  parseCsvLike,
  parseCsvLine,
  reviewIngest,
  type ReviewDeps,
} from "../../src/lib/ingest/review";

// P6 — ingest review library tests.
//
// Covers the pure helpers and the reviewIngest orchestrator. The
// orchestrator is tested with fake deps so we can pin "which rows
// counted as existing matches, which as new" without touching Prisma.

// ---- parseCsvLine ----

test("parseCsvLine: splits on comma with no quotes", () => {
  assert.deepEqual(parseCsvLine("a,b,c", ","), ["a", "b", "c"]);
});

test("parseCsvLine: preserves commas inside quoted fields", () => {
  assert.deepEqual(
    parseCsvLine('"Smith, John",jane@example.com', ","),
    ["Smith, John", "jane@example.com"],
  );
});

test("parseCsvLine: unescapes doubled quotes inside quoted fields", () => {
  assert.deepEqual(
    parseCsvLine('"she said ""hi""",next', ","),
    ['she said "hi"', "next"],
  );
});

test("parseCsvLine: handles trailing empty field", () => {
  assert.deepEqual(parseCsvLine("a,b,", ","), ["a", "b", ""]);
});

test("parseCsvLine: tab delimiter", () => {
  assert.deepEqual(parseCsvLine("a\tb\tc", "\t"), ["a", "b", "c"]);
});

// ---- parseCsvLike ----

test("parseCsvLike: skips blank lines, keeps quoted commas", () => {
  const text = 'name,email\n"Smith, J",j@x.com\n\nKate,k@x.com';
  assert.deepEqual(parseCsvLike(text, ","), [
    ["name", "email"],
    ["Smith, J", "j@x.com"],
    ["Kate", "k@x.com"],
  ]);
});

// ---- detectDelimiter ----

test("detectDelimiter: comma wins on a clean comma file", () => {
  const text = "name,email\nA,a@x.com\nB,b@x.com\nC,c@x.com";
  assert.equal(detectDelimiter(text), ",");
});

test("detectDelimiter: tab wins on a tab-separated file", () => {
  const text = "name\temail\nA\ta@x.com\nB\tb@x.com";
  assert.equal(detectDelimiter(text), "\t");
});

test("detectDelimiter: tab wins ties", () => {
  // Both delimiters yield consistent counts on every line; tab
  // should still win because tab-separated exports are less likely
  // to have embedded punctuation issues.
  const text = "a\tb,c\nd\te,f\ng\th,i";
  assert.equal(detectDelimiter(text), "\t");
});

test("detectDelimiter: rejects prose with inconsistent columns", () => {
  const text =
    "This is a paragraph describing an event.\nIt has several sentences, some with commas, some without.\nShort line.";
  assert.equal(detectDelimiter(text), null);
});

test("detectDelimiter: rejects single-line input", () => {
  assert.equal(detectDelimiter("a,b,c"), null);
});

// ---- normalizeLabel ----

test("normalizeLabel: lowercases, trims, snake-cases spaces and dashes", () => {
  assert.equal(normalizeLabel("  Full Name  "), "full_name");
  assert.equal(normalizeLabel("E-Mail"), "e_mail");
  assert.equal(normalizeLabel("Phone Number"), "phone_number");
});

// ---- detectHeader ----

test("detectHeader: accepts a real header row", () => {
  const rows = [
    ["Name", "Email", "Phone"],
    ["Alice", "a@x.com", "+1 555 1234"],
  ];
  const { header, bodyRows } = detectHeader(rows);
  assert.deepEqual(header, ["name", "email", "phone"]);
  assert.deepEqual(bodyRows, [["Alice", "a@x.com", "+1 555 1234"]]);
});

test("detectHeader: synthesises col_N when first row looks like data", () => {
  const rows = [
    ["Alice", "a@x.com", "+15551234567"],
    ["Bob", "b@x.com", "+15559999999"],
  ];
  const { header, bodyRows } = detectHeader(rows);
  assert.deepEqual(header, ["col_1", "col_2", "col_3"]);
  assert.equal(bodyRows.length, 2);
});

test("detectHeader: ambiguous unknown labels default to header", () => {
  // No recognised labels, no @-sign or long digit run → ambiguous.
  // Default to header so we don't mis-address columns downstream.
  const rows = [
    ["Foo", "Bar", "Baz"],
    ["x", "y", "z"],
  ];
  const { header, bodyRows } = detectHeader(rows);
  assert.deepEqual(header, ["foo", "bar", "baz"]);
  assert.deepEqual(bodyRows, [["x", "y", "z"]]);
});

// ---- detectTarget ----

test("detectTarget: contact channels alone → contacts", () => {
  assert.equal(detectTarget(["name", "email"]), "contacts");
  assert.equal(detectTarget(["full_name", "phone"]), "contacts");
});

test("detectTarget: contact channels + invitee marker → invitees", () => {
  assert.equal(
    detectTarget(["name", "email", "rsvp_token"]),
    "invitees",
  );
  assert.equal(
    detectTarget(["phone", "campaign_id"]),
    "invitees",
  );
});

test("detectTarget: metadata markers without contact channels → campaign_metadata", () => {
  assert.equal(
    detectTarget(["event_name", "venue", "event_at"]),
    "campaign_metadata",
  );
});

test("detectTarget: no recognised columns → null", () => {
  assert.equal(detectTarget(["foo", "bar"]), null);
});

// ---- normalizeRow ----

test("normalizeRow: omits empty cells, trims values", () => {
  const { fields } = normalizeRow(
    ["name", "email", "phone"],
    ["  Alice  ", "", "+15551234"],
  );
  assert.deepEqual(fields, { name: "Alice", phone: "+15551234" });
});

// ---- checkContactRowIssues ----

test("checkContactRowIssues: good row has no issues", () => {
  const issues = checkContactRowIssues({
    name: "Alice",
    email: "a@example.com",
    phone: "+15551234567",
  });
  assert.deepEqual(issues, []);
});

test("checkContactRowIssues: flags missing name + missing contact", () => {
  const issues = checkContactRowIssues({ organization: "Acme" });
  assert.ok(issues.includes("missing_name"));
  assert.ok(issues.includes("missing_contact"));
});

test("checkContactRowIssues: flags bad email", () => {
  const issues = checkContactRowIssues({
    name: "Alice",
    email: "not-an-email",
  });
  assert.ok(issues.includes("bad_email"));
});

test("checkContactRowIssues: flags bad phone (too few digits)", () => {
  const issues = checkContactRowIssues({
    name: "Alice",
    phone: "12",
  });
  assert.ok(issues.includes("bad_phone"));
});

test("checkContactRowIssues: first_name + last_name count as having a name", () => {
  const issues = checkContactRowIssues({
    first_name: "Alice",
    last_name: "Smith",
    email: "a@example.com",
  });
  assert.ok(!issues.includes("missing_name"));
});

// ---- normalizePhoneDigits ----

test("normalizePhoneDigits: preserves leading plus, strips other non-digits", () => {
  assert.equal(normalizePhoneDigits("+1 (555) 123-4567"), "+15551234567");
  assert.equal(normalizePhoneDigits("00 966 50 123 4567"), "00966501234567");
});

// ---- reviewIngest ----

function fakeDeps(
  opts: {
    emailMatches?: Record<string, string>;
    phoneMatches?: Record<string, string>;
  } = {},
): ReviewDeps {
  return {
    async matchContactsByEmail(emails) {
      const out = new Map<string, string>();
      for (const e of emails) {
        const hit = opts.emailMatches?.[e];
        if (hit) out.set(e, hit);
      }
      return out;
    },
    async matchContactsByPhone(phones) {
      const out = new Map<string, string>();
      for (const p of phones) {
        const hit = opts.phoneMatches?.[p];
        if (hit) out.set(p, hit);
      }
      return out;
    },
  };
}

test("reviewIngest: contacts CSV with one email match", async () => {
  const text = [
    "name,email,phone",
    "Alice,alice@example.com,+15551234567",
    "Bob,bob@example.com,+15559999999",
  ].join("\n");
  const profile = await reviewIngest(
    { text },
    fakeDeps({
      emailMatches: { "alice@example.com": "contact_alice" },
    }),
  );
  assert.ok(profile);
  assert.equal(profile.target, "contacts");
  assert.deepEqual(profile.columns, ["name", "email", "phone"]);
  assert.equal(profile.totals.rows, 2);
  assert.equal(profile.totals.sampled, 2);
  assert.equal(profile.totals.new, 1);
  assert.equal(profile.totals.existing_match, 1);
  assert.equal(profile.totals.conflict, 0);

  const aliceRow = profile.sample[0];
  assert.equal(aliceRow.rowStatus, "existing_match");
  assert.equal(aliceRow.matchId, "contact_alice");
  const bobRow = profile.sample[1];
  assert.equal(bobRow.rowStatus, "new");
});

test("reviewIngest: invitee detection via rsvp_token column", async () => {
  const text = [
    "email,rsvp_token",
    "guest@example.com,tok-1",
    "vip@example.com,tok-2",
  ].join("\n");
  const profile = await reviewIngest({ text }, fakeDeps());
  assert.ok(profile);
  assert.equal(profile.target, "invitees");
});

test("reviewIngest: targetHint forces target and records note", async () => {
  // Use a 2-column file so detectDelimiter actually fires — a
  // single-column file can't be distinguished from prose by a
  // column-count-consistency check, so it bails early with null.
  const text = [
    "name,email",
    "Alice,guest@example.com",
    "Bob,vip@example.com",
  ].join("\n");
  const profile = await reviewIngest(
    { text, targetHint: "invitees" },
    fakeDeps(),
  );
  assert.ok(profile);
  assert.equal(profile.target, "invitees");
  // Note should mention the forced target.
  assert.ok(
    profile.notes.some((n) => n.toLowerCase().includes("forced")),
    `expected a "forced" note, got ${JSON.stringify(profile.notes)}`,
  );
});

test("reviewIngest: campaign_metadata target has no row matching, unknown status", async () => {
  const text = [
    "event_name,venue,event_at",
    "Eid reception,Royal Palace,2026-05-01",
  ].join("\n");
  const profile = await reviewIngest({ text }, fakeDeps());
  assert.ok(profile);
  assert.equal(profile.target, "campaign_metadata");
  assert.equal(profile.sample[0].rowStatus, "unknown");
  assert.equal(profile.totals.new, 0);
  assert.equal(profile.totals.existing_match, 0);
});

test("reviewIngest: phone-only matching on contact row", async () => {
  const text = ["name,phone", "Alice,+1 (555) 123-4567"].join("\n");
  const profile = await reviewIngest(
    { text },
    fakeDeps({
      phoneMatches: { "+15551234567": "contact_alice" },
    }),
  );
  assert.ok(profile);
  assert.equal(profile.sample[0].rowStatus, "existing_match");
  assert.equal(profile.sample[0].matchId, "contact_alice");
});

test("reviewIngest: returns null for prose with no delimiter", async () => {
  const text =
    "This is a long paragraph describing an event; it is not structured.\nIt has a few sentences. Some with commas, some without.";
  const profile = await reviewIngest({ text }, fakeDeps());
  assert.equal(profile, null);
});

test("reviewIngest: flags row issues (bad email) on contacts target", async () => {
  const text = ["name,email", "Alice,not-an-email"].join("\n");
  const profile = await reviewIngest({ text }, fakeDeps());
  assert.ok(profile);
  assert.equal(profile.totals.with_issues, 1);
  const [row] = profile.sample;
  assert.ok(row.issues?.includes("bad_email"));
});

test("reviewIngest: respects sampleSize cap on body rows", async () => {
  const rows = ["name,email"];
  for (let i = 0; i < 10; i += 1) {
    rows.push(`User${i},u${i}@example.com`);
  }
  const text = rows.join("\n");
  const profile = await reviewIngest(
    { text, sampleSize: 3 },
    fakeDeps(),
  );
  assert.ok(profile);
  assert.equal(profile.totals.rows, 10);
  assert.equal(profile.totals.sampled, 3);
  assert.equal(profile.sample.length, 3);
});
