import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSummarizeFileResult,
  formatBytes,
  PREVIEW_CHAR_CAP,
  type FileDigestIngestInput,
} from "../../src/lib/ai/tools/summarize_file";
import { fileDigestWidgetKey } from "../../src/lib/ai/widgetKeys";
import { validateWidgetProps } from "../../src/lib/ai/widget-validate";

// P6 — unit tests for the pure `buildSummarizeFileResult` helper. The
// full handler fetches from Prisma then calls this function; keeping
// the formatter pure means we can exercise every status / kind branch
// without mocking the DB.
//
// Each test also runs the emitted widget through `validateWidgetProps`
// so drift between this formatter and the registry validator fails
// the suite instead of lurking until runtime.

function baseIngest(
  overrides: Partial<FileDigestIngestInput> = {},
): FileDigestIngestInput {
  return {
    id: "ing_1",
    fileUploadId: "upload_1",
    status: "extracted",
    kind: "text_plain",
    extractedText: "Hello\nWorld",
    extractionError: null,
    bytesExtracted: 11,
    updatedAt: new Date("2026-04-19T10:00:00Z"),
    filename: "notes.txt",
    ...overrides,
  };
}

test("formatBytes: units", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
});

test("buildSummarizeFileResult: extracted text_plain emits widget + summary", () => {
  const result = buildSummarizeFileResult(baseIngest());
  assert.equal((result.output as { ok: boolean }).ok, true);
  assert.ok(result.widget);
  assert.equal(result.widget?.kind, "file_digest");
  assert.equal(result.widget?.slot, "secondary");
  assert.equal(result.widget?.widgetKey, fileDigestWidgetKey("ing_1"));

  // Validator drift guard — the formatter's props MUST pass the
  // closed validator. If the shapes ever diverge, this fails loudly.
  assert.ok(validateWidgetProps("file_digest", result.widget!.props));

  const props = result.widget!.props as Record<string, unknown>;
  assert.equal(props.filename, "notes.txt");
  assert.equal(props.kind, "text_plain");
  assert.equal(props.status, "extracted");
  assert.equal(props.preview, "Hello\nWorld");
  assert.equal(props.charCount, 11);
  assert.equal(props.lineCount, 2);
  assert.equal(props.previewTruncated, false);

  const summary = (result.output as { summary: string }).summary;
  assert.match(summary, /notes\.txt/);
  assert.match(summary, /text_plain/);
});

test("buildSummarizeFileResult: truncates preview at PREVIEW_CHAR_CAP", () => {
  const longText = "a".repeat(PREVIEW_CHAR_CAP + 500);
  const result = buildSummarizeFileResult(
    baseIngest({ extractedText: longText, bytesExtracted: longText.length }),
  );
  const props = result.widget!.props as Record<string, unknown>;
  assert.equal((props.preview as string).length, PREVIEW_CHAR_CAP);
  assert.equal(props.previewTruncated, true);
  assert.equal(props.charCount, longText.length);

  const summary = (result.output as { summary: string }).summary;
  assert.match(summary, /truncated/i);
});

test("buildSummarizeFileResult: failed status surfaces error, no preview", () => {
  const result = buildSummarizeFileResult(
    baseIngest({
      status: "failed",
      kind: "failed",
      extractedText: null,
      extractionError: "pdf parse boom",
      bytesExtracted: 0,
    }),
  );
  assert.ok(result.widget);
  assert.ok(validateWidgetProps("file_digest", result.widget!.props));
  const props = result.widget!.props as Record<string, unknown>;
  assert.equal(props.status, "failed");
  assert.equal(props.preview, null);
  assert.equal(props.extractionError, "pdf parse boom");

  const summary = (result.output as { summary: string }).summary;
  assert.match(summary, /failed/i);
  assert.match(summary, /pdf parse boom/);
});

test("buildSummarizeFileResult: unsupported kind produces advisory text", () => {
  const result = buildSummarizeFileResult(
    baseIngest({
      status: "unsupported",
      kind: "unsupported",
      extractedText: null,
      bytesExtracted: 0,
    }),
  );
  assert.ok(result.widget);
  assert.ok(validateWidgetProps("file_digest", result.widget!.props));
  const summary = (result.output as { summary: string }).summary;
  assert.match(summary, /unsupported/i);
});

test("buildSummarizeFileResult: pending ingest returns transient text, no widget", () => {
  const result = buildSummarizeFileResult(
    baseIngest({ status: "pending", extractedText: null }),
  );
  assert.equal((result.output as { ok: boolean }).ok, false);
  assert.equal(result.widget, undefined);
  const summary = (result.output as { summary: string }).summary;
  assert.match(summary, /pending/i);
});
