import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { createHash } from "node:crypto";

// Low surface. Five pure functions. One dedup hash. No class ceremony.

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
  // strip common local formats before parsing
  const cleaned = raw.replace(/[^\d+]/g, "");
  const parsed = parsePhoneNumberFromString(cleaned, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number; // E.164
}

// One key per person: email OR phone — normalized, hashed. Missing → random (no collision).
export function dedupKey(email: string | null, phone: string | null): string {
  const seed = (email ?? "") + "|" + (phone ?? "");
  if (!email && !phone) return "none:" + createHash("sha1").update(Math.random().toString()).digest("hex").slice(0, 12);
  return createHash("sha1").update(seed).digest("hex").slice(0, 24);
}

// Parse CSV/TSV — forgiving of delimiters, quoted fields, BOM.
export function parseContactsText(text: string): Array<Record<string, string>> {
  const t = text.replace(/^\uFEFF/, "");
  const lines = t.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const delim = lines[0].includes("\t") ? "\t" : ",";
  const split = (line: string) => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (q && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = !q;
      } else if (c === delim && !q) {
        out.push(cur);
        cur = "";
      } else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const header = split(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  return lines.slice(1).map((line) => {
    const cols = split(line);
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cols[i] ?? ""));
    return row;
  });
}
