import { test } from "node:test";
import assert from "node:assert/strict";

import {
  appendReference,
  formatFileReference,
  uploadErrorMessage,
  type UploadResponseIngest,
} from "../../src/components/chat/uploadReference";

// P5-followup — pure helpers for the chat-side upload affordance.
// ChatRail consumes these via closure, but they're tested directly
// so format drift fails here instead of during a manual smoke test.

// --- formatFileReference: success branch -------------------------

test("formatFileReference: text_plain extraction maps to 'text' + char-count", () => {
  const ingest: UploadResponseIngest = { ok: true, kind: "text_plain", bytesExtracted: 523 };
  assert.equal(formatFileReference("notes.txt", ingest), "[file: notes.txt — text, 523 chars extracted]");
});

test("formatFileReference: pdf extraction maps to 'pdf' + kilo-char format", () => {
  const ingest: UploadResponseIngest = { ok: true, kind: "pdf", bytesExtracted: 12100 };
  assert.equal(formatFileReference("brief.pdf", ingest), "[file: brief.pdf — pdf, 12.1k chars extracted]");
});

test("formatFileReference: docx extraction maps to 'docx'", () => {
  const ingest: UploadResponseIngest = { ok: true, kind: "docx", bytesExtracted: 890 };
  assert.equal(formatFileReference("letter.docx", ingest), "[file: letter.docx — docx, 890 chars extracted]");
});

test("formatFileReference: massive file uses M-char format", () => {
  const ingest: UploadResponseIngest = { ok: true, kind: "pdf", bytesExtracted: 2_500_000 };
  assert.equal(formatFileReference("report.pdf", ingest), "[file: report.pdf — pdf, 2.5M chars extracted]");
});

test("formatFileReference: zero bytes reads naturally", () => {
  const ingest: UploadResponseIngest = { ok: true, kind: "text_plain", bytesExtracted: 0 };
  assert.equal(formatFileReference("empty.txt", ingest), "[file: empty.txt — text, 0 chars extracted]");
});

test("formatFileReference: unknown kind passes through verbatim (forward compat)", () => {
  const ingest: UploadResponseIngest = { ok: true, kind: "xml" as string, bytesExtracted: 100 };
  assert.equal(formatFileReference("doc.xml", ingest), "[file: doc.xml — xml, 100 chars extracted]");
});

// --- formatFileReference: failure branch -------------------------

test("formatFileReference: extraction_failed surfaces reason verbatim", () => {
  const ingest: UploadResponseIngest = { ok: false, kind: "pdf", reason: "extraction_failed", error: "corrupt pdf" };
  assert.equal(formatFileReference("bad.pdf", ingest), "[file: bad.pdf — extraction_failed]");
});

test("formatFileReference: unsupported reason surfaces as reason", () => {
  const ingest: UploadResponseIngest = { ok: false, kind: "unsupported", reason: "unsupported" };
  assert.equal(formatFileReference("logo.png", ingest), "[file: logo.png — unsupported]");
});

// --- appendReference ---------------------------------------------

test("appendReference: empty composer yields reference alone", () => {
  assert.equal(appendReference("", "[file: a.txt — text, 5 chars extracted]"), "[file: a.txt — text, 5 chars extracted]");
});

test("appendReference: existing text gets a newline separator", () => {
  assert.equal(
    appendReference("Summarize this please.", "[file: a.txt — text, 5 chars extracted]"),
    "Summarize this please.\n[file: a.txt — text, 5 chars extracted]",
  );
});

test("appendReference: existing text already ending in newline doesn't double", () => {
  assert.equal(
    appendReference("Draft:\n", "[file: a.txt — text, 5 chars extracted]"),
    "Draft:\n[file: a.txt — text, 5 chars extracted]",
  );
});

// --- uploadErrorMessage ------------------------------------------

test("uploadErrorMessage: Error instance returns message", () => {
  assert.equal(uploadErrorMessage(new Error("network down")), "network down");
});

test("uploadErrorMessage: bare string passes through", () => {
  assert.equal(uploadErrorMessage("rate_limited"), "rate_limited");
});

test("uploadErrorMessage: unknown shape falls back to generic", () => {
  assert.equal(uploadErrorMessage({ weird: true }), "upload_error");
  assert.equal(uploadErrorMessage(null), "upload_error");
  assert.equal(uploadErrorMessage(undefined), "upload_error");
});
