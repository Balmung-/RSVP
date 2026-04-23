import type { Extractor, ExtractResult } from "./types";

type Workbook = {
  SheetNames?: string[];
  Sheets?: Record<string, unknown>;
};

type XlsxModuleShape = {
  read: (data: Buffer, opts: { type: "buffer" }) => Workbook;
  utils: {
    sheet_to_csv: (
      sheet: unknown,
      opts?: { FS?: string; RS?: string; blankrows?: boolean },
    ) => string;
  };
};

let cachedXlsx: XlsxModuleShape | null = null;

export function _setXlsxForTests(mod: XlsxModuleShape | null): void {
  cachedXlsx = mod;
}

async function getXlsx(): Promise<XlsxModuleShape> {
  if (cachedXlsx) return cachedXlsx;
  const mod = await import("xlsx");
  const value = mod as unknown as XlsxModuleShape;
  if (typeof value.read !== "function" || typeof value.utils?.sheet_to_csv !== "function") {
    throw new Error("xlsx module unavailable");
  }
  cachedXlsx = value;
  return value;
}

export const xlsxExtractor: Extractor = {
  kind: "xlsx",
  async extract(contents: Buffer): Promise<ExtractResult> {
    try {
      const xlsx = await getXlsx();
      const workbook = xlsx.read(contents, { type: "buffer" });
      const sheetName = workbook.SheetNames?.find((name) => {
        const sheet = workbook.Sheets?.[name];
        if (!sheet) return false;
        const csv = xlsx.utils.sheet_to_csv(sheet, {
          FS: ",",
          RS: "\n",
          blankrows: false,
        });
        return csv.trim().length > 0;
      }) ?? workbook.SheetNames?.[0];

      if (!sheetName || !workbook.Sheets?.[sheetName]) {
        return { ok: true, kind: "xlsx", text: "", bytes: 0 };
      }

      const text = xlsx.utils.sheet_to_csv(workbook.Sheets[sheetName], {
        FS: ",",
        RS: "\n",
        blankrows: false,
      });
      return {
        ok: true,
        kind: "xlsx",
        text,
        bytes: Buffer.byteLength(text, "utf8"),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, kind: "xlsx", error: message };
    }
  },
};
