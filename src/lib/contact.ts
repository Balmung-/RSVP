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
  try {
    const parsed = parsePhoneNumberFromString(cleaned, defaultCountry);
    if (parsed && parsed.isValid()) {
      return parsed.number; // E.164
    }
  } catch {
    // Fall through to the narrow Saudi fallback below.
  }
  return fallbackNormalizePhone(cleaned, defaultCountry);
}

function fallbackNormalizePhone(
  cleaned: string,
  defaultCountry: CountryCode,
): string | null {
  if (defaultCountry !== "SA") return null;
  const digits = cleaned.replace(/[^\d]/g, "");
  if (digits.length === 9 && digits.startsWith("5")) return `+966${digits}`;
  if (digits.length === 10 && digits.startsWith("05")) return `+966${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith("966")) return `+${digits}`;
  return null;
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

const IMPORT_HEADER_ALIASES: Record<string, string> = {
  "الاسم": "name",
  "الاسم_الكامل": "full_name",
  "البريد_الالكتروني": "email",
  "البريد_الإلكتروني": "email",
  "الايميل": "email",
  "الإيميل": "email",
  "الجوال": "phone",
  "رقم_الجوال": "phone",
  "الهاتف": "phone",
  "رقم_الهاتف": "phone",
  "الموبايل": "phone",
  "رقم_الموبايل": "phone",
  "المنظمة": "organization",
  "الجهة": "organization",
  "الشركة": "organization",
  "المسمى_الوظيفي": "title",
  "المنصب": "title",
  "الوظيفة": "title",
  "ملاحظات": "notes",
  "الملاحظات": "notes",
  "اللغة": "locale",
  "ضيوف": "guests",
  "عدد_الضيوف": "guests",
  "الفئة": "tier",
};

const KNOWN_IMPORT_HEADERS = new Set([
  "name",
  "full_name",
  "email",
  "phone",
  "organization",
  "title",
  "notes",
  "locale",
  "guests",
  "tier",
]);

function normalizeImportHeader(raw: string): string {
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return IMPORT_HEADER_ALIASES[normalized] ?? normalized;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function looksLikePhone(value: string): boolean {
  const digits = value.replace(/[^\d]/g, "");
  return digits.length >= 6;
}

function inferHeaderFromFirstRow(first: string[]): string[] {
  const inferred = first.map((_, i) => `col_${i + 1}`);
  let sawTextCandidate = false;

  for (let i = 0; i < first.length; i += 1) {
    const value = first[i]!.trim();
    if (value.length === 0) continue;

    if (looksLikeEmail(value) && !inferred.includes("email")) {
      inferred[i] = "email";
      continue;
    }
    if (looksLikePhone(value) && !inferred.includes("phone")) {
      inferred[i] = "phone";
      continue;
    }

    if (!inferred.includes("name")) {
      inferred[i] = "name";
      sawTextCandidate = true;
    }
  }

  const hasContact = inferred.includes("email") || inferred.includes("phone");
  return hasContact && sawTextCandidate ? inferred : first.map((_, i) => `col_${i + 1}`);
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
  const first = rows[0].map((h) => h.trim());
  const normalizedFirst = first.map(normalizeImportHeader);
  const headerHits = normalizedFirst.filter((h) => KNOWN_IMPORT_HEADERS.has(h)).length;
  const firstLooksLikeData = first.some((cell) => looksLikeEmail(cell) || looksLikePhone(cell));
  const header = firstLooksLikeData && headerHits === 0
    ? inferHeaderFromFirstRow(first)
    : normalizedFirst;
  const inferredDataHeader =
    header.includes("name") && (header.includes("email") || header.includes("phone"));
  const bodyRows = firstLooksLikeData && inferredDataHeader
    ? rows
    : rows.slice(1);

  return bodyRows.map((cols) => {
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = (cols[i] ?? "").trim()));
    return row;
  });
}
