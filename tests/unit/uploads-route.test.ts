import { test } from "node:test";
import assert from "node:assert/strict";

import { uploadsHandler, type UploadsDeps } from "../../src/app/api/uploads/handler";
import type { IngestOutcome } from "../../src/lib/ingest";

// P5-followup — route-level pins for POST /api/uploads.
//
// The handler bakes three distinct behaviors into one code path:
//   1. Auth: requireEditor throws → 401.
//   2. Validation: bad mime/size → 400 with the existing message.
//   3. Storage + auto-extraction: the blob saves first, THEN
//      extraction runs. Extraction failure doesn't fail the upload
//      — the blob is already persisted, so we return 200 with
//      `ingest.ok=false` and let the UI decide.
//
// Each test builds a tiny deps bag that records calls. We use a
// real File/FormData so the handler exercises its own `file
// instanceof File` branch instead of a shape-fake that might lie.

type StoreCall = {
  filename: string;
  contentType: string;
  size: number;
  contents: Buffer;
  uploadedBy?: string | null;
};

function makeReq(file: File | null, kind: "image" | "doc" = "doc"): Request {
  const form = new FormData();
  if (file) form.append("file", file);
  form.append("kind", kind);
  return new Request("https://app.example.gov/api/uploads", {
    method: "POST",
    body: form,
  });
}

function txtFile(name: string, body: string, type = "text/plain"): File {
  return new File([body], name, { type });
}

function makeDeps(overrides: Partial<UploadsDeps> = {}): {
  deps: UploadsDeps;
  stores: StoreCall[];
  extracts: string[];
} {
  const stores: StoreCall[] = [];
  const extracts: string[] = [];
  const baseStore = overrides.storeUpload;
  const baseExtract = overrides.extractFromUpload;
  const deps: UploadsDeps = {
    requireEditor: overrides.requireEditor ?? (async () => ({ id: "user-editor-1" })),
    readFormData: overrides.readFormData ?? ((r) => r.formData()),
    validateUpload: overrides.validateUpload ?? (() => null),
    storeUpload: async (p) => {
      stores.push(p);
      if (baseStore) return baseStore(p);
      return { id: "up_abc", url: "/api/files/up_abc" };
    },
    extractFromUpload: async (id) => {
      extracts.push(id);
      if (baseExtract) return baseExtract(id);
      return { ok: true, id: "ingest_1", kind: "text_plain", bytesExtracted: 5 };
    },
  };
  return { deps, stores, extracts };
}

// --- auth ---------------------------------------------------------

test("uploads: requireEditor throw → 401; no store, no extract", async () => {
  const { deps, stores, extracts } = makeDeps({
    requireEditor: async () => {
      throw new Error("unauthorized");
    },
  });
  const res = await uploadsHandler(makeReq(txtFile("a.txt", "hi")), deps);
  assert.equal(res.status, 401);
  if (res.status === 401) {
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, "unauthorized");
  }
  assert.equal(stores.length, 0);
  assert.equal(extracts.length, 0);
});

// --- missing file ------------------------------------------------

test("uploads: no file in form → 400 no_file; no store, no extract", async () => {
  const { deps, stores, extracts } = makeDeps();
  const res = await uploadsHandler(makeReq(null), deps);
  assert.equal(res.status, 400);
  if (res.status === 400) {
    assert.equal(res.body.error, "no_file");
  }
  assert.equal(stores.length, 0);
  assert.equal(extracts.length, 0);
});

// --- validation ---------------------------------------------------

test("uploads: validateUpload rejection → 400 with returned message", async () => {
  const { deps, stores, extracts } = makeDeps({
    validateUpload: () => "File type not supported.",
  });
  const res = await uploadsHandler(makeReq(txtFile("a.bin", "xxx", "application/octet-stream")), deps);
  assert.equal(res.status, 400);
  if (res.status === 400) {
    assert.equal(res.body.error, "File type not supported.");
  }
  assert.equal(stores.length, 0);
  assert.equal(extracts.length, 0);
});

// --- happy: extraction success -----------------------------------

test("uploads: happy path stores, extracts, returns ok + ingest fields", async () => {
  const { deps, stores, extracts } = makeDeps();
  const res = await uploadsHandler(makeReq(txtFile("notes.txt", "hello", "text/plain"), "doc"), deps);
  assert.equal(res.status, 200);
  if (res.status === 200) {
    assert.equal(res.body.ok, true);
    assert.equal(res.body.id, "up_abc");
    assert.equal(res.body.url, "/api/files/up_abc");
    assert.equal(res.body.filename, "notes.txt");
    assert.equal(res.body.ingest.ok, true);
    if (res.body.ingest.ok) {
      // P6-fix — id is surfaced so the composer token can carry
      // `ingestId: <cuid>` and the model can resolve "the uploaded
      // file" to a real FileIngest row.
      assert.equal(res.body.ingest.id, "ingest_1");
      assert.equal(res.body.ingest.kind, "text_plain");
      assert.equal(res.body.ingest.bytesExtracted, 5);
    }
  }
  assert.equal(stores.length, 1);
  assert.equal(stores[0].filename, "notes.txt");
  assert.equal(stores[0].contentType, "text/plain");
  assert.equal(stores[0].uploadedBy, "user-editor-1");
  assert.equal(extracts.length, 1);
  assert.equal(extracts[0], "up_abc");
});

// --- happy: extraction failure does NOT fail the upload ----------

test("uploads: extraction failure returns 200 with ingest.ok=false + reason", async () => {
  const { deps, stores, extracts } = makeDeps({
    extractFromUpload: async (): Promise<IngestOutcome> => ({
      ok: false,
      id: "ingest_1",
      kind: "pdf",
      reason: "extraction_failed",
      error: "corrupt pdf",
    }),
  });
  const res = await uploadsHandler(makeReq(txtFile("bad.pdf", "junk", "application/pdf"), "doc"), deps);
  assert.equal(res.status, 200);
  if (res.status === 200) {
    assert.equal(res.body.ok, true);
    assert.equal(res.body.id, "up_abc");
    assert.equal(res.body.ingest.ok, false);
    if (!res.body.ingest.ok) {
      // P6-fix — failure branch still carries the ingest id so the
      // composer token can be `[file: … — extraction_failed,
      // ingestId: <cuid>]` and summarize_file can render a
      // structured failure widget rather than leaving the model
      // stuck.
      assert.equal(res.body.ingest.id, "ingest_1");
      assert.equal(res.body.ingest.kind, "pdf");
      assert.equal(res.body.ingest.reason, "extraction_failed");
      assert.equal(res.body.ingest.error, "corrupt pdf");
    }
  }
  assert.equal(stores.length, 1);
  assert.equal(extracts.length, 1);
});

// --- unsupported kind surfaces correctly ------------------------

test("uploads: unsupported extraction reports ingest.ok=false with reason=unsupported", async () => {
  const { deps, stores, extracts } = makeDeps({
    extractFromUpload: async (): Promise<IngestOutcome> => ({
      ok: false,
      id: "ingest_2",
      kind: "unsupported",
      reason: "unsupported",
    }),
  });
  const res = await uploadsHandler(makeReq(txtFile("img.png", "pngbytes", "image/png"), "image"), deps);
  assert.equal(res.status, 200);
  if (res.status === 200) {
    assert.equal(res.body.ingest.ok, false);
    if (!res.body.ingest.ok) {
      assert.equal(res.body.ingest.id, "ingest_2");
      assert.equal(res.body.ingest.kind, "unsupported");
      assert.equal(res.body.ingest.reason, "unsupported");
      // No error string on unsupported (it's a policy outcome, not a crash).
      assert.equal((res.body.ingest as { error?: string }).error, undefined);
    }
  }
  assert.equal(stores.length, 1);
  assert.equal(extracts.length, 1);
});

// --- upload_not_found: null id falls through ---------------------

test("uploads: extraction reports upload_not_found → ingest.id is null on response", async () => {
  // Path shouldn't occur in practice (we just stored the upload a
  // moment before calling extract), but the IngestOutcome union
  // allows id: null for this case so handler behavior must be
  // pinned. The response shape stays consistent — failure branch
  // with a nullable id — and the chat composer falls back to the
  // id-less token format.
  const { deps, stores, extracts } = makeDeps({
    extractFromUpload: async (): Promise<IngestOutcome> => ({
      ok: false,
      id: null,
      kind: "unsupported",
      reason: "upload_not_found",
    }),
  });
  const res = await uploadsHandler(makeReq(txtFile("ghost.txt", "x", "text/plain"), "doc"), deps);
  assert.equal(res.status, 200);
  if (res.status === 200) {
    assert.equal(res.body.ingest.ok, false);
    if (!res.body.ingest.ok) {
      assert.equal(res.body.ingest.id, null);
      assert.equal(res.body.ingest.reason, "upload_not_found");
    }
  }
  assert.equal(stores.length, 1);
  assert.equal(extracts.length, 1);
});

// --- wiring order: store must happen before extract -------------

test("uploads: store runs before extract (extract id matches store return)", async () => {
  const events: string[] = [];
  const { deps } = makeDeps({
    storeUpload: async (p) => {
      events.push(`store:${p.filename}`);
      return { id: "up_xyz", url: "/api/files/up_xyz" };
    },
    extractFromUpload: async (id) => {
      events.push(`extract:${id}`);
      return { ok: true, id: "ingest_x", kind: "text_plain", bytesExtracted: 0 };
    },
  });
  const res = await uploadsHandler(makeReq(txtFile("t.txt", "", "text/plain"), "doc"), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(events, ["store:t.txt", "extract:up_xyz"]);
});
