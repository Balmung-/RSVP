import { test } from "node:test";
import assert from "node:assert/strict";

import { buildReviewFileImportResult } from "../../src/lib/ai/tools/review_file_import";
import type { ReviewProfile } from "../../src/lib/ingest/review";
import { importReviewWidgetKey } from "../../src/lib/ai/widgetKeys";
import { validateWidgetProps } from "../../src/lib/ai/widget-validate";

// P6 — unit tests for the pure `buildReviewFileImportResult`. The
// handler does the Prisma fetch + reviewIngest call, then delegates
// to this function; testing it directly covers every target branch
// (contacts / invitees / campaign_metadata) plus the null-profile
// fallback.

const NOW = new Date("2026-04-19T12:00:00Z");

function ingest() {
  return {
    id: "ing_1",
    fileUploadId: "upload_1",
    filename: "guest-list.csv",
  };
}

function contactsProfile(
  overrides: Partial<ReviewProfile> = {},
): ReviewProfile {
  return {
    target: "contacts",
    columns: ["name", "email"],
    sample: [
      {
        fields: { name: "Alice", email: "alice@x.com" },
        rowStatus: "new",
      },
      {
        fields: { name: "Bob", email: "bob@x.com" },
        rowStatus: "existing_match",
        matchId: "contact_bob",
      },
    ],
    totals: {
      rows: 2,
      sampled: 2,
      new: 1,
      existing_match: 1,
      conflict: 0,
      with_issues: 0,
    },
    notes: ["Detected CSV format.", "Auto-detected target: contacts."],
    ...overrides,
  };
}

test("buildReviewFileImportResult: contacts profile emits widget + bilingual-ready summary", () => {
  const result = buildReviewFileImportResult(ingest(), contactsProfile(), NOW);
  assert.equal((result.output as { ok: boolean }).ok, true);
  assert.ok(result.widget);
  assert.equal(result.widget?.kind, "import_review");
  assert.equal(result.widget?.slot, "primary");
  assert.equal(
    result.widget?.widgetKey,
    importReviewWidgetKey("contacts", "ing_1"),
  );

  assert.ok(validateWidgetProps("import_review", result.widget!.props));

  const props = result.widget!.props as Record<string, unknown>;
  assert.equal(props.filename, "guest-list.csv");
  assert.equal(props.target, "contacts");
  assert.deepEqual(props.columns, ["name", "email"]);
  assert.equal(props.detectedAt, "2026-04-19T12:00:00.000Z");

  const summary = (result.output as { summary: string }).summary;
  assert.match(summary, /guest-list\.csv/);
  assert.match(summary, /contacts/);
  assert.match(summary, /1 new/);
  assert.match(summary, /1 already in contact book/);
});

test("buildReviewFileImportResult: coerces numeric sample field values to strings", () => {
  // The review library always emits strings today, but the validator
  // requires it — so the formatter defensively coerces. Prove the
  // coercion actually happens so a future source-side slip doesn't
  // sneak numbers into the DB blob.
  const profile = contactsProfile({
    sample: [
      {
        // Simulate a future detector bug that lets a number through.
        fields: { name: "Alice", age: 42 as unknown as string },
        rowStatus: "new",
      },
    ],
  });
  const result = buildReviewFileImportResult(ingest(), profile, NOW);
  assert.ok(result.widget);
  assert.ok(validateWidgetProps("import_review", result.widget!.props));
  const sample = (result.widget!.props as { sample: Array<{ fields: Record<string, string> }> })
    .sample;
  assert.equal(sample[0].fields.age, "42");
});

test("buildReviewFileImportResult: invitees profile mentions invitees in summary", () => {
  const profile = contactsProfile({
    target: "invitees",
    columns: ["email", "rsvp_token"],
  });
  const result = buildReviewFileImportResult(ingest(), profile, NOW);
  assert.equal(
    result.widget?.widgetKey,
    importReviewWidgetKey("invitees", "ing_1"),
  );
  const summary = (result.output as { summary: string }).summary;
  assert.match(summary, /invitees/);
});

test("buildReviewFileImportResult: campaign_metadata profile omits contacts tally from summary", () => {
  const profile: ReviewProfile = {
    target: "campaign_metadata",
    columns: ["event_name", "venue", "event_at"],
    sample: [
      {
        fields: {
          event_name: "Eid reception",
          venue: "Royal Palace",
          event_at: "2026-05-01",
        },
        rowStatus: "unknown",
      },
    ],
    totals: {
      rows: 1,
      sampled: 1,
      new: 0,
      existing_match: 0,
      conflict: 0,
      with_issues: 0,
    },
    notes: ["Detected CSV format.", "Metadata preview — no row matching performed in P6."],
  };
  const result = buildReviewFileImportResult(ingest(), profile, NOW);
  assert.ok(result.widget);
  assert.ok(validateWidgetProps("import_review", result.widget!.props));
  const summary = (result.output as { summary: string }).summary;
  assert.match(summary, /campaign metadata/);
  // Metadata summary should NOT have the contacts tally line.
  assert.ok(
    !/already in contact book/.test(summary),
    `metadata summary should not mention contact book; got: ${summary}`,
  );
});

test("buildReviewFileImportResult: issues count surfaces in summary", () => {
  const profile = contactsProfile({
    sample: [
      {
        fields: { name: "Alice", email: "not-an-email" },
        rowStatus: "new",
        issues: ["bad_email"],
      },
    ],
    totals: {
      rows: 1,
      sampled: 1,
      new: 1,
      existing_match: 0,
      conflict: 0,
      with_issues: 1,
    },
  });
  const result = buildReviewFileImportResult(ingest(), profile, NOW);
  const summary = (result.output as { summary: string }).summary;
  assert.match(summary, /1 with issues/);
});

test("buildReviewFileImportResult: null profile returns text-only fallback", () => {
  const result = buildReviewFileImportResult(ingest(), null, NOW);
  assert.equal((result.output as { ok: boolean }).ok, false);
  assert.equal(result.widget, undefined);
  const summary = (result.output as { summary: string }).summary;
  assert.match(summary, /does not look like a structured import/i);
  assert.match(summary, /summarize_file/);
});
