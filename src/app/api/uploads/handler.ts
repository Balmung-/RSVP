import type { IngestOutcome } from "@/lib/ingest";
import type { UploadKind } from "@/lib/uploads";

// Pure handler for POST /api/uploads. All side effects are funneled
// through the `UploadsDeps` bag so tests can substitute fakes without
// a Next runtime or real Prisma.
//
// The auto-extract step is fire-and-keep: if extraction fails, we
// still return 200 with the stored upload id + url, and surface the
// failure as `ingest.ok = false` in the response body. The blob is
// already persisted; extraction can be re-driven later by calling
// extractFromUpload(id) again (the orchestrator is idempotent).

export type UploadsUser = { id: string };

export interface UploadsDeps {
  requireEditor: () => Promise<UploadsUser>;
  readFormData: (req: Request) => Promise<FormData>;
  validateUpload: (file: { type: string; size: number }, kind: UploadKind) => string | null;
  storeUpload: (params: {
    filename: string;
    contentType: string;
    size: number;
    contents: Buffer;
    uploadedBy?: string | null;
  }) => Promise<{ id: string; url: string }>;
  extractFromUpload: (fileUploadId: string) => Promise<IngestOutcome>;
}

export type UploadsIngestResult =
  | { ok: true; kind: string; bytesExtracted: number }
  | { ok: false; kind: string; reason: string; error?: string };

export type UploadsResult =
  | {
      status: 200;
      body: {
        ok: true;
        id: string;
        url: string;
        filename: string;
        ingest: UploadsIngestResult;
      };
    }
  | {
      status: 400 | 401 | 403 | 500;
      body: { ok: false; error: string };
    };

export async function uploadsHandler(req: Request, deps: UploadsDeps): Promise<UploadsResult> {
  let me: UploadsUser;
  try {
    me = await deps.requireEditor();
  } catch (err) {
    // requireRole throws a redirect response object on auth failure.
    // For the JSON API surface we translate it to a 401; everything
    // the route wrapper previously accepted here remains accepted.
    const msg = err instanceof Error ? err.message : "unauthorized";
    return { status: 401, body: { ok: false, error: msg } };
  }

  const form = await deps.readFormData(req);
  const file = form.get("file");
  const kindRaw = String(form.get("kind") ?? "image");
  const kind: UploadKind = kindRaw === "doc" ? "doc" : "image";

  if (!(file instanceof File)) {
    return { status: 400, body: { ok: false, error: "no_file" } };
  }

  const err = deps.validateUpload({ type: file.type, size: file.size }, kind);
  if (err) return { status: 400, body: { ok: false, error: err } };

  const buf = Buffer.from(await file.arrayBuffer());
  const saved = await deps.storeUpload({
    filename: file.name || "upload",
    contentType: file.type,
    size: file.size,
    contents: buf,
    uploadedBy: me.id,
  });

  // Best-effort extraction. A failure here is not a failure of the
  // upload itself — the blob is already persisted. The caller sees
  // ingest.ok=false and can decide whether to retry or prompt the
  // operator for a different file.
  const outcome = await deps.extractFromUpload(saved.id);
  const ingest: UploadsIngestResult = outcome.ok
    ? { ok: true, kind: outcome.kind, bytesExtracted: outcome.bytesExtracted }
    : {
        ok: false,
        kind: outcome.kind,
        reason: outcome.reason,
        ...(outcome.error ? { error: outcome.error } : {}),
      };

  return {
    status: 200,
    body: {
      ok: true,
      id: saved.id,
      url: saved.url,
      filename: file.name || "upload",
      ingest,
    },
  };
}
