import type { Extractor, ExtractResult } from "./types";

// pdf-parse is imported lazily so test runs that never touch PDFs
// don't pay its (non-trivial) startup cost. Typed as `unknown` then
// narrowed — pdf-parse's type export is a default callable, but
// `require` returns the runtime value; the narrowing below is what
// actually matters at run time.
type PdfParseFn = (data: Buffer) => Promise<{ text: string }>;

let cachedPdfParse: PdfParseFn | null = null;

// Test seam: letting a suite swap in a fake parser keeps pdf-parse
// out of the unit test dependency tree. Production callers never
// touch this — they hit `extract()` and get the real library.
export function _setPdfParseForTests(fn: PdfParseFn | null): void {
  cachedPdfParse = fn;
}

async function getPdfParse(): Promise<PdfParseFn> {
  if (cachedPdfParse) return cachedPdfParse;
  const mod = await import("pdf-parse");
  const fn = (mod as unknown as { default?: PdfParseFn }).default ?? (mod as unknown as PdfParseFn);
  cachedPdfParse = fn;
  return fn;
}

// PDF extractor. pdf-parse returns one big text blob — we preserve
// it verbatim. Any throw becomes a structured failure; the
// orchestrator will persist `status=failed` with the error message.
// We do NOT fall back to returning a partial result on error: if
// extraction failed, the extractedText should be null so downstream
// consumers can't confuse "we got nothing" with "file was empty".
export const pdfExtractor: Extractor = {
  kind: "pdf",
  async extract(contents: Buffer): Promise<ExtractResult> {
    try {
      const parse = await getPdfParse();
      const result = await parse(contents);
      const text = typeof result?.text === "string" ? result.text : "";
      return { ok: true, kind: "pdf", text, bytes: Buffer.byteLength(text, "utf8") };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, kind: "pdf", error: message };
    }
  },
};
