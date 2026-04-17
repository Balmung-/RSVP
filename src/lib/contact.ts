import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { createHash, randomBytes } from "node:crypto";

// Pure functions. One dedup hash. One CSV parser. One CSV cell sanitizer.

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

export function normalizePhone(
  raw: string | null | undefined,
  defaultCountry: CountryCode = "SA",
): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d+]/g, "");
  const parsed = parsePhoneNumberFromString(cleaned, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number; // E.164
}

// One key per person. Missing both → random (CSPRNG, 96 bits).
export function dedupKey(email: string | null, phone: string | null): string {
  if (!email && !phone) return "none:" + randomBytes(12).toString("hex");
  const seed = (email ?? "") + "|" + (phone ?? "");
  return createHash("sha1").update(seed).digest("hex").slice(0, 24);
}

// Defuse CSV formula injection: cells starting with =, +, -, @, \t, \r get a
// leading apostrophe. Excel / Numbers / Sheets all respect this.
export function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  const needsEscape = /^[=+\-@\t\r]/.test(s);
  const safe = needsEscape ? "'" + s : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function csvRow(cells: readonly unknown[]): string {
  return cells.map(csvCell).join(",");
}

// Parse CSV/TSV with quoted fields, embedded newlines, doubled quotes, BOM.
// Returns an array of rows keyed by the lowercased header.
export function parseContactsText(text: string): Array<Record<string, string>> {
  const t = text.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let cur = "";
  let field: string[] = [];
  let inQuotes = false;
  let delim: "," | "\t" | null = null;

  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQuotes) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (!delim && (c === "," || c === "\t")) delim = c;
    if (delim && c === delim) {
      field.push(cur);
      cur = "";
      continue;
    }
    if (c === "\r") continue;
    if (c === "\n") {
      field.push(cur);
      cur = "";
      if (field.some((f) => f.length > 0)) rows.push(field);
      field = [];
      continue;
    }
    cur += c;
  }
  if (cur.length > 0 || field.length > 0) {
    field.push(cur);
    if (field.some((f) => f.length > 0)) rows.push(field);
  }

  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return rows.slice(1).map((cols) => {
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = (cols[i] ?? "").trim()));
    return row;
  });
}
