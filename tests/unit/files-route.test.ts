import test from "node:test";
import assert from "node:assert/strict";
import {
  canReadPrivateUpload,
  handleFileDownload,
  type FileDownloadDeps,
} from "@/app/api/files/[id]/handler";

function makeDeps(
  overrides: Partial<FileDownloadDeps & { row: Awaited<ReturnType<FileDownloadDeps["fetchUpload"]>> }> = {},
): FileDownloadDeps & { calls: { getCurrentUser: number; isPublicFile: number } } {
  const row = overrides.row ?? {
    filename: 'brief "final".pdf',
    contentType: "application/pdf",
    size: 3,
    contents: Buffer.from("pdf"),
    uploadedBy: "u1",
  };
  const calls = { getCurrentUser: 0, isPublicFile: 0 };
  return {
    calls,
    fetchUpload: overrides.fetchUpload ?? (async () => row),
    getCurrentUser:
      overrides.getCurrentUser ??
      (async () => {
        calls.getCurrentUser += 1;
        return { id: "u1", role: "editor" };
      }),
    isPublicFile:
      overrides.isPublicFile ??
      (async () => {
        calls.isPublicFile += 1;
        return false;
      }),
  };
}

test("canReadPrivateUpload: owner may read", () => {
  assert.equal(canReadPrivateUpload({ uploadedBy: "u1" }, { id: "u1", role: "editor" }), true);
});

test("canReadPrivateUpload: admin may read unowned file", () => {
  assert.equal(canReadPrivateUpload({ uploadedBy: null }, { id: "root", role: "admin" }), true);
});

test("canReadPrivateUpload: anonymous cannot read", () => {
  assert.equal(canReadPrivateUpload({ uploadedBy: "u1" }, null), false);
});

test("canReadPrivateUpload: non-owner editor cannot read", () => {
  assert.equal(canReadPrivateUpload({ uploadedBy: "u1" }, { id: "u2", role: "editor" }), false);
});

test("handleFileDownload: missing row -> 404", async () => {
  const deps = makeDeps({ fetchUpload: async () => null });
  const res = await handleFileDownload("f1", deps);
  assert.deepEqual(res, { status: 404 });
  assert.equal(deps.calls.isPublicFile, 0);
  assert.equal(deps.calls.getCurrentUser, 0);
});

test("handleFileDownload: public file serves without auth lookup", async () => {
  const deps = makeDeps({
    isPublicFile: async () => {
      deps.calls.isPublicFile += 1;
      return true;
    },
  });
  const res = await handleFileDownload("f1", deps);
  assert.equal(res.status, 200);
  if (res.status !== 200) return;
  assert.equal(res.headers["Cache-Control"], "public, max-age=31536000, immutable");
  assert.equal(res.headers["Content-Disposition"], 'inline; filename="brief final.pdf"');
  assert.equal(Buffer.from(res.body).toString("utf8"), "pdf");
  assert.equal(deps.calls.isPublicFile, 1);
  assert.equal(deps.calls.getCurrentUser, 0);
});

test("handleFileDownload: private file serves to uploader with private cache headers", async () => {
  const deps = makeDeps();
  const res = await handleFileDownload("f1", deps);
  assert.equal(res.status, 200);
  if (res.status !== 200) return;
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  assert.equal(deps.calls.isPublicFile, 1);
  assert.equal(deps.calls.getCurrentUser, 1);
});

test("handleFileDownload: private file hides foreign upload from non-owner", async () => {
  const deps = makeDeps({
    getCurrentUser: async () => {
      deps.calls.getCurrentUser += 1;
      return { id: "u2", role: "editor" };
    },
  });
  const res = await handleFileDownload("f1", deps);
  assert.deepEqual(res, { status: 404 });
});

test("handleFileDownload: private file hides unowned upload from non-admin when uploadedBy is null", async () => {
  const deps = makeDeps({
    row: {
      filename: "legacy.pdf",
      contentType: "application/pdf",
      size: 3,
      contents: Buffer.from("pdf"),
      uploadedBy: null,
    },
  });
  const res = await handleFileDownload("f1", deps);
  assert.deepEqual(res, { status: 404 });
});

test("handleFileDownload: private file allows admin even when uploadedBy is null", async () => {
  const deps = makeDeps({
    row: {
      filename: "legacy.pdf",
      contentType: "application/pdf",
      size: 3,
      contents: Buffer.from("pdf"),
      uploadedBy: null,
    },
    getCurrentUser: async () => {
      deps.calls.getCurrentUser += 1;
      return { id: "root", role: "admin" };
    },
  });
  const res = await handleFileDownload("f1", deps);
  assert.equal(res.status, 200);
  if (res.status !== 200) return;
  assert.equal(res.headers["Cache-Control"], "private, no-store");
});
