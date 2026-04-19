import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractFromUploadWith,
  type IngestDb,
  type IngestDeps,
} from "../../src/lib/ingest";
import type { Extractor, ExtractResult } from "../../src/lib/ingest/types";

// P5 — Orchestrator tests. `extractFromUploadWith` is the pure
// form: it takes a db + extractor bag and returns a structured
// outcome. The production `extractFromUpload` just binds Prisma.
//
// Each test builds a tiny fake db that records upsert calls so we
// can pin the exact (status, kind, bytesExtracted, extractedText)
// combination the orchestrator persists in every branch. The fakes
// deliberately do NOT validate the full Prisma type surface — the
// orchestrator only uses the subset defined on `IngestDb`.

type UpsertCall = {
  fileUploadId: string;
  status: string;
  kind: string;
  extractedText: string | null;
  extractionError: string | null;
  bytesExtracted: number;
};

type UploadRow = { id: string; contentType: string; contents: Buffer };

function fakeDeps(opts: {
  upload?: UploadRow | null;
  extractors?: Partial<Record<"text_plain" | "pdf" | "docx", Extractor>>;
}): { deps: IngestDeps; upserts: UpsertCall[] } {
  const upserts: UpsertCall[] = [];
  const db: IngestDb = {
    fileUpload: {
      async findUnique({ where }) {
        if (!opts.upload || opts.upload.id !== where.id) return null;
        return opts.upload;
      },
    },
    fileIngest: {
      async upsert({ create }) {
        upserts.push({
          fileUploadId: create.fileUploadId,
          status: create.status,
          kind: create.kind,
          extractedText: create.extractedText,
          extractionError: create.extractionError,
          bytesExtracted: create.bytesExtracted,
        });
        return { id: `ingest_${upserts.length}` };
      },
    },
  };
  return { deps: { db, extractors: opts.extractors }, upserts };
}

function stubExtractor(kind: "text_plain" | "pdf" | "docx", result: ExtractResult): Extractor {
  return {
    kind,
    async extract() {
      return result;
    },
  };
}

// --- missing upload -----------------------------------------------

test("orchestrator: missing upload returns upload_not_found; no ingest row persisted", async () => {
  const { deps, upserts } = fakeDeps({ upload: null });
  const result = await extractFromUploadWith("missing-id", deps);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "upload_not_found");
    assert.equal(result.id, null);
    assert.equal(result.kind, "unsupported");
  }
  assert.equal(upserts.length, 0);
});

// --- unsupported kind ---------------------------------------------

test("orchestrator: unsupported content-type persists status=unsupported, no extractor run", async () => {
  let extractorCalled = false;
  const { deps, upserts } = fakeDeps({
    upload: { id: "up_1", contentType: "image/png", contents: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    extractors: {
      text_plain: {
        kind: "text_plain",
        async extract() {
          extractorCalled = true;
          return { ok: true, kind: "text_plain", text: "should not run", bytes: 0 };
        },
      },
    },
  });
  const result = await extractFromUploadWith("up_1", deps);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "unsupported");
    assert.equal(result.kind, "unsupported");
  }
  assert.equal(extractorCalled, false);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].status, "unsupported");
  assert.equal(upserts[0].kind, "unsupported");
  assert.equal(upserts[0].extractedText, null);
  assert.equal(upserts[0].bytesExtracted, 0);
});

// --- happy: text/plain --------------------------------------------

test("orchestrator: text/plain success persists status=extracted with text + byte count", async () => {
  const { deps, upserts } = fakeDeps({
    upload: { id: "up_2", contentType: "text/plain", contents: Buffer.from("hello") },
    extractors: {
      text_plain: stubExtractor("text_plain", { ok: true, kind: "text_plain", text: "hello", bytes: 5 }),
    },
  });
  const result = await extractFromUploadWith("up_2", deps);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.kind, "text_plain");
    assert.equal(result.bytesExtracted, 5);
  }
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].status, "extracted");
  assert.equal(upserts[0].kind, "text_plain");
  assert.equal(upserts[0].extractedText, "hello");
  assert.equal(upserts[0].extractionError, null);
  assert.equal(upserts[0].bytesExtracted, 5);
});

// --- happy: pdf ---------------------------------------------------

test("orchestrator: PDF success persists status=extracted with pdf kind", async () => {
  const { deps, upserts } = fakeDeps({
    upload: { id: "up_3", contentType: "application/pdf", contents: Buffer.from([0x25, 0x50, 0x44, 0x46]) },
    extractors: {
      pdf: stubExtractor("pdf", { ok: true, kind: "pdf", text: "pdf body", bytes: 8 }),
    },
  });
  const result = await extractFromUploadWith("up_3", deps);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.kind, "pdf");
  assert.equal(upserts[0].status, "extracted");
  assert.equal(upserts[0].kind, "pdf");
  assert.equal(upserts[0].extractedText, "pdf body");
});

// --- happy: docx --------------------------------------------------

test("orchestrator: DOCX success persists status=extracted with docx kind", async () => {
  const { deps, upserts } = fakeDeps({
    upload: {
      id: "up_4",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      contents: Buffer.from([0x50, 0x4b]),
    },
    extractors: {
      docx: stubExtractor("docx", { ok: true, kind: "docx", text: "docx body", bytes: 9 }),
    },
  });
  const result = await extractFromUploadWith("up_4", deps);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.kind, "docx");
  assert.equal(upserts[0].status, "extracted");
  assert.equal(upserts[0].kind, "docx");
  assert.equal(upserts[0].extractedText, "docx body");
});

// --- failure branch ------------------------------------------------

test("orchestrator: extractor failure persists status=failed with extractionError; text is null", async () => {
  const { deps, upserts } = fakeDeps({
    upload: { id: "up_5", contentType: "application/pdf", contents: Buffer.from([0x25]) },
    extractors: {
      pdf: stubExtractor("pdf", { ok: false, kind: "pdf", error: "corrupt pdf" }),
    },
  });
  const result = await extractFromUploadWith("up_5", deps);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "extraction_failed");
    assert.equal(result.kind, "pdf");
    assert.equal(result.error, "corrupt pdf");
  }
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].status, "failed");
  assert.equal(upserts[0].kind, "pdf");
  assert.equal(upserts[0].extractedText, null);
  assert.equal(upserts[0].extractionError, "corrupt pdf");
  assert.equal(upserts[0].bytesExtracted, 0);
});

// --- passthrough / isolation --------------------------------------

test("orchestrator: returns ingest row id from upsert", async () => {
  const { deps } = fakeDeps({
    upload: { id: "up_6", contentType: "text/plain", contents: Buffer.from("x") },
    extractors: {
      text_plain: stubExtractor("text_plain", { ok: true, kind: "text_plain", text: "x", bytes: 1 }),
    },
  });
  const result = await extractFromUploadWith("up_6", deps);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.id, "ingest_1");
  }
});

test("orchestrator: zero-byte text/plain yields status=extracted with empty text", async () => {
  const { deps, upserts } = fakeDeps({
    upload: { id: "up_7", contentType: "text/plain", contents: Buffer.alloc(0) },
    extractors: {
      text_plain: stubExtractor("text_plain", { ok: true, kind: "text_plain", text: "", bytes: 0 }),
    },
  });
  const result = await extractFromUploadWith("up_7", deps);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.bytesExtracted, 0);
  }
  assert.equal(upserts[0].status, "extracted");
  assert.equal(upserts[0].extractedText, "");
  assert.equal(upserts[0].bytesExtracted, 0);
});
