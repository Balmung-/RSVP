// Kinds the ingest pipeline knows about. The string domain is
// deliberately narrow — a new format must opt in by adding a case to
// `classify()` AND an extractor. Anything else falls into
// `unsupported` (image/binary/etc.) — it still gets a FileIngest row
// so callers can tell "we looked at it" from "we never processed it".
export type ExtractKind = "text_plain" | "pdf" | "docx" | "unsupported";

export type ExtractResult =
  | { ok: true; kind: ExtractKind; text: string; bytes: number }
  | { ok: false; kind: ExtractKind; error: string };

// An Extractor is a pure function from (bytes, contentType) → text.
// It never touches Prisma — the orchestrator persists the outcome.
// Keeping extractors pure is what makes them trivially testable with
// fixture bytes.
export interface Extractor {
  readonly kind: ExtractKind;
  extract(contents: Buffer): Promise<ExtractResult>;
}

// Classify an incoming content-type to one of the known kinds.
// Falls back to `unsupported` when we don't have an extractor — the
// pipeline still records the row so we don't silently ignore files.
export function classify(contentType: string): ExtractKind {
  const ct = contentType.toLowerCase();
  if (ct.startsWith("text/plain")) return "text_plain";
  if (ct === "application/pdf") return "pdf";
  if (ct === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  return "unsupported";
}
