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
//
// P6-fix note: the token now carries `ingestId: <cuid>` so the model
// can resolve "the uploaded file" to a FileIngest row and call
// summarize_file / review_file_import. Both branches (ok + failure-
// with-id) embed the id; only the pathological "upload_not_found"
// failure branch (id=null) falls back to the old id-less token.

// --- formatFileReference: success branch -------------------------

test("formatFileReference: text_plain extraction maps to 'text' + char-count + ingestId", () => {
  const ingest: UploadResponseIngest = {
    ok: true,
    id: "ing_abc123",
    kind: "text_plain",
    bytesExtracted: 523,
  };
  assert.equal(
    formatFileReference("notes.txt", ingest),
    "[file: notes.txt — text, 523 chars extracted, ingestId: ing_abc123]",
  );
});

test("formatFileReference: pdf extraction maps to 'pdf' + kilo-char format + ingestId", () => {
  const ingest: UploadResponseIngest = {
    ok: true,
    id: "ing_pdf01",
    kind: "pdf",
    bytesExtracted: 12100,
  };
  assert.equal(
    formatFileReference("brief.pdf", ingest),
    "[file: brief.pdf — pdf, 12.1k chars extracted, ingestId: ing_pdf01]",
  );
});

test("formatFileReference: docx extraction maps to 'docx' + ingestId", () => {
  const ingest: UploadResponseIngest = {
    ok: true,
    id: "ing_docx1",
    kind: "docx",
    bytesExtracted: 890,
  };
  assert.equal(
    formatFileReference("letter.docx", ingest),
    "[file: letter.docx — docx, 890 chars extracted, ingestId: ing_docx1]",
  );
});

test("formatFileReference: massive file uses M-char format + ingestId", () => {
  const ingest: UploadResponseIngest = {
    ok: true,
    id: "ing_big",
    kind: "pdf",
    bytesExtracted: 2_500_000,
  };
  assert.equal(
    formatFileReference("report.pdf", ingest),
    "[file: report.pdf — pdf, 2.5M chars extracted, ingestId: ing_big]",
  );
});

test("formatFileReference: zero bytes reads naturally + ingestId", () => {
  const ingest: UploadResponseIngest = {
    ok: true,
    id: "ing_empty",
    kind: "text_plain",
    bytesExtracted: 0,
  };
  assert.equal(
    formatFileReference("empty.txt", ingest),
    "[file: empty.txt — text, 0 chars extracted, ingestId: ing_empty]",
  );
});

test("formatFileReference: unknown kind passes through verbatim (forward compat)", () => {
  const ingest: UploadResponseIngest = {
    ok: true,
    id: "ing_xml",
    kind: "xml" as string,
    bytesExtracted: 100,
  };
  assert.equal(
    formatFileReference("doc.xml", ingest),
    "[file: doc.xml — xml, 100 chars extracted, ingestId: ing_xml]",
  );
});

// --- formatFileReference: failure branch -------------------------

test("formatFileReference: extraction_failed with ingest.id surfaces reason + id", () => {
  const ingest: UploadResponseIngest = {
    ok: false,
    id: "ing_fail1",
    kind: "pdf",
    reason: "extraction_failed",
    error: "corrupt pdf",
  };
  assert.equal(
    formatFileReference("bad.pdf", ingest),
    "[file: bad.pdf — extraction_failed, ingestId: ing_fail1]",
  );
});

test("formatFileReference: unsupported reason with ingest.id surfaces as reason + id", () => {
  const ingest: UploadResponseIngest = {
    ok: false,
    id: "ing_png",
    kind: "unsupported",
    reason: "unsupported",
  };
  assert.equal(
    formatFileReference("logo.png", ingest),
    "[file: logo.png — unsupported, ingestId: ing_png]",
  );
});

test("formatFileReference: failure with null ingest.id falls back to id-less token", () => {
  // The only path to a null id is `upload_not_found` from the ingest
  // orchestrator — cannot happen for a just-stored upload, but the
  // shape allows it so the fallback stays defensive.
  const ingest: UploadResponseIngest = {
    ok: false,
    id: null,
    kind: "unsupported",
    reason: "upload_not_found",
  };
  assert.equal(
    formatFileReference("ghost.bin", ingest),
    "[file: ghost.bin — upload_not_found]",
  );
});

// --- appendReference ---------------------------------------------

test("appendReference: empty composer yields reference alone", () => {
  assert.equal(
    appendReference("", "[file: a.txt — text, 5 chars extracted, ingestId: ing_a]"),
    "[file: a.txt — text, 5 chars extracted, ingestId: ing_a]",
  );
});

test("appendReference: existing text gets a newline separator", () => {
  assert.equal(
    appendReference(
      "Summarize this please.",
      "[file: a.txt — text, 5 chars extracted, ingestId: ing_a]",
    ),
    "Summarize this please.\n[file: a.txt — text, 5 chars extracted, ingestId: ing_a]",
  );
});

test("appendReference: existing text already ending in newline doesn't double", () => {
  assert.equal(
    appendReference(
      "Draft:\n",
      "[file: a.txt — text, 5 chars extracted, ingestId: ing_a]",
    ),
    "Draft:\n[file: a.txt — text, 5 chars extracted, ingestId: ing_a]",
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
