import type { Extractor, ExtractResult } from "./types";

// mammoth has its own Buffer-taking API (extractRawText). The lazy
// import mirrors pdf.ts — we don't pay the cost unless a docx
// actually hits the pipeline.
type MammothExtractFn = (input: { buffer: Buffer }) => Promise<{ value: string; messages?: unknown[] }>;

let cachedMammothExtract: MammothExtractFn | null = null;

// Test seam — same story as pdf.ts. Keeps mammoth out of the unit
// test dependency tree.
export function _setMammothExtractForTests(fn: MammothExtractFn | null): void {
  cachedMammothExtract = fn;
}

async function getMammothExtract(): Promise<MammothExtractFn> {
  if (cachedMammothExtract) return cachedMammothExtract;
  const mod = await import("mammoth");
  const fn = (mod as unknown as { extractRawText?: MammothExtractFn }).extractRawText
    ?? ((mod as unknown as { default?: { extractRawText?: MammothExtractFn } }).default?.extractRawText);
  if (!fn) throw new Error("mammoth.extractRawText not available");
  cachedMammothExtract = fn;
  return fn;
}

// .docx extractor via mammoth's raw-text mode — we deliberately
// don't want the HTML mode; the agent sees plain text, not markup.
// mammoth returns warnings on the `messages` array for things like
// unrecognised styles; we ignore them because they're not fatal.
export const docxExtractor: Extractor = {
  kind: "docx",
  async extract(contents: Buffer): Promise<ExtractResult> {
    try {
      const extract = await getMammothExtract();
      const result = await extract({ buffer: contents });
      const text = typeof result?.value === "string" ? result.value : "";
      return { ok: true, kind: "docx", text, bytes: Buffer.byteLength(text, "utf8") };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, kind: "docx", error: message };
    }
  },
};
