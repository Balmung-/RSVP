import type { Extractor, ExtractResult } from "./types";

// text/plain extractor. Directly decodes the buffer as UTF-8 and
// accepts whatever comes out — invalid sequences become U+FFFD, not
// an error, because an editor pasting a log fragment with one bad
// byte shouldn't lose the whole file. If we need strict decoding
// later, swap the `fatal: true` flag in and return an error on throw.
export const textPlainExtractor: Extractor = {
  kind: "text_plain",
  async extract(contents: Buffer): Promise<ExtractResult> {
    try {
      const text = new TextDecoder("utf-8").decode(contents);
      return { ok: true, kind: "text_plain", text, bytes: Buffer.byteLength(text, "utf8") };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, kind: "text_plain", error: message };
    }
  },
};
