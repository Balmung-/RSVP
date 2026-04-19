import { prisma } from "../db";
import { textPlainExtractor } from "./text-plain";
import { pdfExtractor } from "./pdf";
import { docxExtractor } from "./docx";
import { classify, type ExtractKind, type Extractor } from "./types";

// Extractor registry. The orchestrator hits exactly one by looking
// up `classify(contentType)`. Adding a new format = one entry here +
// one classify() case + one extractor file.
const DEFAULT_EXTRACTORS: Record<Exclude<ExtractKind, "unsupported">, Extractor> = {
  text_plain: textPlainExtractor,
  pdf: pdfExtractor,
  docx: docxExtractor,
};

export type IngestOutcome =
  | { ok: true; id: string; kind: ExtractKind; bytesExtracted: number }
  | {
      ok: false;
      id: string | null;
      kind: ExtractKind;
      reason: "upload_not_found" | "extraction_failed" | "unsupported";
      error?: string;
    };

// Narrow DB surface the orchestrator needs. Tests substitute a fake
// implementation — production passes the real Prisma client via the
// default export wrapper below. Keeping this typed as the minimum
// shape lets the test fake be tiny instead of mirroring the full
// Prisma model.
export interface IngestDb {
  fileUpload: {
    findUnique(args: {
      where: { id: string };
      select: { id: true; contentType: true; contents: true };
    }): Promise<{ id: string; contentType: string; contents: Buffer } | null>;
  };
  fileIngest: {
    upsert(args: {
      where: { fileUploadId: string };
      create: {
        fileUploadId: string;
        status: string;
        kind: string;
        extractedText: string | null;
        extractionError: string | null;
        bytesExtracted: number;
      };
      update: {
        status: string;
        kind: string;
        extractedText: string | null;
        extractionError: string | null;
        bytesExtracted: number;
      };
      select: { id: true };
    }): Promise<{ id: string }>;
  };
}

export interface IngestDeps {
  db: IngestDb;
  extractors?: Partial<Record<Exclude<ExtractKind, "unsupported">, Extractor>>;
}

// Pure-ish orchestrator. Takes a FileUpload id and a deps bag, runs
// the matching extractor, and persists a FileIngest row. Idempotent
// via the UNIQUE(fileUploadId) constraint — re-running overwrites
// the prior outcome so a failed extraction can be retried cleanly.
// Returns a structured outcome instead of throwing; callers decide
// whether to surface the failure as an error or a soft warning.
export async function extractFromUploadWith(
  fileUploadId: string,
  deps: IngestDeps,
): Promise<IngestOutcome> {
  const upload = await deps.db.fileUpload.findUnique({
    where: { id: fileUploadId },
    select: { id: true, contentType: true, contents: true },
  });
  if (!upload) {
    return { ok: false, id: null, kind: "unsupported", reason: "upload_not_found" };
  }

  const kind = classify(upload.contentType);

  if (kind === "unsupported") {
    const row = await upsertIngest(deps.db, {
      fileUploadId,
      status: "unsupported",
      kind,
      extractedText: null,
      extractionError: null,
      bytesExtracted: 0,
    });
    return { ok: false, id: row.id, kind, reason: "unsupported" };
  }

  const extractor = deps.extractors?.[kind] ?? DEFAULT_EXTRACTORS[kind];
  const result = await extractor.extract(upload.contents);

  if (!result.ok) {
    const row = await upsertIngest(deps.db, {
      fileUploadId,
      status: "failed",
      kind,
      extractedText: null,
      extractionError: result.error,
      bytesExtracted: 0,
    });
    return { ok: false, id: row.id, kind, reason: "extraction_failed", error: result.error };
  }

  const row = await upsertIngest(deps.db, {
    fileUploadId,
    status: "extracted",
    kind,
    extractedText: result.text,
    extractionError: null,
    bytesExtracted: result.bytes,
  });
  return { ok: true, id: row.id, kind, bytesExtracted: result.bytes };
}

async function upsertIngest(
  db: IngestDb,
  params: {
    fileUploadId: string;
    status: string;
    kind: ExtractKind;
    extractedText: string | null;
    extractionError: string | null;
    bytesExtracted: number;
  },
): Promise<{ id: string }> {
  return db.fileIngest.upsert({
    where: { fileUploadId: params.fileUploadId },
    create: {
      fileUploadId: params.fileUploadId,
      status: params.status,
      kind: params.kind,
      extractedText: params.extractedText,
      extractionError: params.extractionError,
      bytesExtracted: params.bytesExtracted,
    },
    update: {
      status: params.status,
      kind: params.kind,
      extractedText: params.extractedText,
      extractionError: params.extractionError,
      bytesExtracted: params.bytesExtracted,
    },
    select: { id: true },
  });
}

// Production entry point — binds the real Prisma client. Route
// handlers and background workers call this directly; only tests
// use `extractFromUploadWith`.
export async function extractFromUpload(fileUploadId: string): Promise<IngestOutcome> {
  return extractFromUploadWith(fileUploadId, { db: prisma as unknown as IngestDb });
}

export { classify } from "./types";
export type { ExtractKind, ExtractResult, Extractor } from "./types";
