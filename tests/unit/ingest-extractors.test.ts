import { test } from "node:test";
import assert from "node:assert/strict";

import { textPlainExtractor } from "../../src/lib/ingest/text-plain";
import { pdfExtractor, _setPdfParseForTests } from "../../src/lib/ingest/pdf";
import { docxExtractor, _setMammothExtractForTests } from "../../src/lib/ingest/docx";
import { classify } from "../../src/lib/ingest/types";

// P5 — Ingest extractor unit tests.
//
// The three extractors are pure over (contents, contentType) → result.
// pdf.ts and docx.ts load their parser libs lazily and expose a
// setter we use to swap in fake parsers — that keeps pdf-parse and
// mammoth out of the unit test dependency surface. The real libs
// are exercised end-to-end in the P5-followup integration work.

// --- classify ------------------------------------------------------

test("classify: text/plain is text_plain", () => {
  assert.equal(classify("text/plain"), "text_plain");
  assert.equal(classify("text/plain; charset=utf-8"), "text_plain");
});

test("classify: csv-like text types are text_plain", () => {
  assert.equal(classify("text/csv"), "text_plain");
  assert.equal(classify("text/csv; charset=utf-8"), "text_plain");
  assert.equal(classify("application/csv"), "text_plain");
  assert.equal(classify("text/tab-separated-values"), "text_plain");
});

test("classify: application/pdf is pdf", () => {
  assert.equal(classify("application/pdf"), "pdf");
});

test("classify: .docx mime is docx", () => {
  assert.equal(
    classify("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    "docx",
  );
});

test("classify: images fall into unsupported", () => {
  assert.equal(classify("image/png"), "unsupported");
  assert.equal(classify("image/jpeg"), "unsupported");
});

test("classify: unknown content-types fall into unsupported", () => {
  assert.equal(classify("application/octet-stream"), "unsupported");
  assert.equal(classify(""), "unsupported");
});

test("classify: case-insensitive", () => {
  assert.equal(classify("APPLICATION/PDF"), "pdf");
  assert.equal(classify("Text/Plain"), "text_plain");
});

// --- text-plain ----------------------------------------------------

test("text-plain: decodes UTF-8 bytes", async () => {
  const buf = Buffer.from("Hello world — with an em dash.", "utf-8");
  const result = await textPlainExtractor.extract(buf);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.text, "Hello world — with an em dash.");
    assert.equal(result.kind, "text_plain");
    assert.equal(result.bytes, Buffer.byteLength(result.text, "utf8"));
  }
});

test("text-plain: empty buffer returns empty string, bytes=0", async () => {
  const result = await textPlainExtractor.extract(Buffer.alloc(0));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.text, "");
    assert.equal(result.bytes, 0);
  }
});

test("text-plain: Arabic UTF-8 round-trips", async () => {
  const arabic = "دعوة إلى الحدث";
  const buf = Buffer.from(arabic, "utf-8");
  const result = await textPlainExtractor.extract(buf);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.text, arabic);
  }
});

test("text-plain: invalid UTF-8 bytes degrade gracefully (U+FFFD)", async () => {
  // 0xC0 0xC0 is an invalid UTF-8 sequence.
  const buf = Buffer.from([0xc0, 0xc0, 0x41]);
  const result = await textPlainExtractor.extract(buf);
  // Non-fatal decoder: should still succeed, just with replacement chars.
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.text.includes("A"));
  }
});

// --- pdf (fake pdf-parse) -----------------------------------------

test("pdf: returns extracted text on success", async () => {
  _setPdfParseForTests(async (buf: Buffer) => ({
    text: `PDF contents (${buf.length} bytes)`,
  }));
  try {
    const result = await pdfExtractor.extract(Buffer.from([0x25, 0x50, 0x44, 0x46]));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.kind, "pdf");
      assert.ok(result.text.startsWith("PDF contents"));
      assert.equal(result.bytes, Buffer.byteLength(result.text, "utf8"));
    }
  } finally {
    _setPdfParseForTests(null);
  }
});

test("pdf: parser throw becomes structured failure", async () => {
  _setPdfParseForTests(async () => {
    throw new Error("invalid pdf header");
  });
  try {
    const result = await pdfExtractor.extract(Buffer.from("not a pdf"));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, "pdf");
      assert.match(result.error, /invalid pdf header/);
    }
  } finally {
    _setPdfParseForTests(null);
  }
});

test("pdf: empty text from parser still counts as ok", async () => {
  _setPdfParseForTests(async () => ({ text: "" }));
  try {
    const result = await pdfExtractor.extract(Buffer.from([0x25]));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.text, "");
      assert.equal(result.bytes, 0);
    }
  } finally {
    _setPdfParseForTests(null);
  }
});

test("pdf: non-string text field coerces to empty", async () => {
  // Some buggy PDFs make pdf-parse return an object without a text
  // property. Extractor must not crash; it should return ok=true
  // with empty text so the caller treats it as an empty document
  // rather than a transient failure that'll be retried.
  _setPdfParseForTests(async () => ({} as { text: string }));
  try {
    const result = await pdfExtractor.extract(Buffer.from([0x25]));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.text, "");
    }
  } finally {
    _setPdfParseForTests(null);
  }
});

// --- docx (fake mammoth) ------------------------------------------

test("docx: returns extracted text on success", async () => {
  _setMammothExtractForTests(async ({ buffer }: { buffer: Buffer }) => ({
    value: `DOCX contents (${buffer.length} bytes)`,
    messages: [{ type: "warning", message: "unknown style" }],
  }));
  try {
    const result = await docxExtractor.extract(Buffer.from([0x50, 0x4b]));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.kind, "docx");
      assert.ok(result.text.startsWith("DOCX contents"));
      assert.equal(result.bytes, Buffer.byteLength(result.text, "utf8"));
    }
  } finally {
    _setMammothExtractForTests(null);
  }
});

test("docx: parser throw becomes structured failure", async () => {
  _setMammothExtractForTests(async () => {
    throw new Error("not a zip archive");
  });
  try {
    const result = await docxExtractor.extract(Buffer.from("junk"));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, "docx");
      assert.match(result.error, /not a zip/);
    }
  } finally {
    _setMammothExtractForTests(null);
  }
});

test("docx: mammoth warnings are ignored (not fatal)", async () => {
  _setMammothExtractForTests(async () => ({
    value: "body text",
    messages: [
      { type: "warning", message: "style A" },
      { type: "warning", message: "style B" },
    ],
  }));
  try {
    const result = await docxExtractor.extract(Buffer.from([0x50, 0x4b]));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.text, "body text");
    }
  } finally {
    _setMammothExtractForTests(null);
  }
});

test("docx: missing value coerces to empty text", async () => {
  _setMammothExtractForTests(async () => ({ value: "" as string }));
  try {
    const result = await docxExtractor.extract(Buffer.from([0x50, 0x4b]));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.text, "");
      assert.equal(result.bytes, 0);
    }
  } finally {
    _setMammothExtractForTests(null);
  }
});
