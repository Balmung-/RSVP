// Pure helpers for the chat-side upload affordance.
//
// Builds the short reference token that gets appended to the
// composer input after a successful upload, and builds the error
// string surfaced to the operator when an upload fails. Both are
// pure over their inputs so the tests don't need a DOM.
//
// Reference-token design note: we intentionally do NOT inject the
// extracted text into the composer. P5's constraint is that file
// contents never go straight into a prompt; they pass through
// extraction + bounded summarization first. The token is just a
// human-visible anchor the operator can refer to in their prompt
// ("summarize the uploaded file") — the server-side tool that
// reads the ingest record is a P6 follow-up.

export type UploadResponseIngest =
  | { ok: true; kind: string; bytesExtracted: number }
  | { ok: false; kind: string; reason: string; error?: string };

export type UploadResponse =
  | { ok: true; id: string; url: string; filename: string; ingest: UploadResponseIngest }
  | { ok: false; error: string };

export function formatFileReference(filename: string, ingest: UploadResponseIngest): string {
  if (ingest.ok) {
    const kind = shortKind(ingest.kind);
    const size = formatBytes(ingest.bytesExtracted);
    return `[file: ${filename} — ${kind}, ${size} extracted]`;
  }
  // Upload succeeded, extraction did not — still tell the operator
  // the file exists. `reason` is one of the IngestOutcome reasons
  // (`extraction_failed`, `unsupported`); keep it verbatim so the
  // surface mirrors the server's vocabulary.
  return `[file: ${filename} — ${ingest.reason}]`;
}

export function appendReference(existing: string, reference: string): string {
  // If the composer already has content, put the reference on a new
  // line so it's clearly a separate token rather than running into
  // the operator's half-typed sentence. Empty composer: the token
  // becomes the whole line.
  if (existing.length === 0) return reference;
  if (existing.endsWith("\n")) return `${existing}${reference}`;
  return `${existing}\n${reference}`;
}

export function uploadErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "upload_error";
}

function shortKind(kind: string): string {
  switch (kind) {
    case "text_plain":
      return "text";
    case "pdf":
      return "pdf";
    case "docx":
      return "docx";
    default:
      return kind;
  }
}

function formatBytes(n: number): string {
  if (n < 1000) return `${n} chars`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k chars`;
  return `${(n / 1_000_000).toFixed(1)}M chars`;
}
