// P6 — ingest review: detect whether an extracted file looks like an
// importable list (contacts / invitees / campaign metadata), parse it,
// and match each sample row against the current DB so the operator can
// see "N rows new, M already exist" before P7's commit flow.
//
// Pure where possible:
//   - `detectDelimiter`, `parseCsvLike`, `parseCsvLine`, `detectHeader`,
//     `normalizeLabel`, `detectTarget`, `normalizeRow`,
//     `checkContactRowIssues` — all pure, no I/O, each unit-testable
//     in isolation.
//   - `reviewIngest` — the top-level orchestrator — takes a deps bag
//     (`matchContactsByEmail` / `matchContactsByPhone`) so tests can
//     feed in a fake match table without touching Prisma.
//
// Scope limits for P6 (deliberate; P7 widens them):
//   - CSV and TSV only. JSON / XLSX / PDF tables are out of scope.
//     A bounded preview of the extracted text already lives in the
//     `file_digest` widget for those.
//   - No multi-line quoted-field support. Rows that look split across
//     newlines get split here too — the operator will see obvious
//     garbage and can clean the file upstream.
//   - Matching by EMAIL (case-insensitive) and PHONE (digits-only).
//     No name-fuzzy match, no tag-based dedupe. The "conflict" row
//     status is reserved in the validator but never produced by this
//     module — P7 adds conflict detection once commit semantics exist.
//   - For `campaign_metadata` we do no matching at all; every sample
//     row lands as `rowStatus: "unknown"`. The metadata target exists
//     so the assistant can still render a review card when it sees
//     "one-row file with event_name / venue / event_at", rather than
//     forcing a summarize_file fallback.

export type ReviewTarget = "contacts" | "invitees" | "campaign_metadata";
export type RowStatus = "new" | "existing_match" | "conflict" | "unknown";

export type ReviewSampleRow = {
  fields: Record<string, string>;
  rowStatus: RowStatus;
  matchId?: string | null;
  issues?: string[];
};

export type ReviewTotals = {
  rows: number;
  sampled: number;
  new: number;
  existing_match: number;
  conflict: number;
  with_issues: number;
};

export type ReviewProfile = {
  target: ReviewTarget;
  columns: string[];
  sample: ReviewSampleRow[];
  totals: ReviewTotals;
  notes: string[];
};

export type ReviewDeps = {
  // Returns a map of lowercased-email -> contactId for emails that
  // match an existing Contact row. Callers pass only the subset of
  // sampled emails; unmatched emails are omitted from the map (not
  // mapped to null) so the caller-side lookup is a simple `.get`.
  matchContactsByEmail: (emails: string[]) => Promise<Map<string, string>>;
  // Returns a map of normalized-phone-digits -> contactId. "Normalized"
  // here means: leading + preserved if present, all other non-digits
  // stripped. That's what the caller feeds in; the matcher compares
  // against `Contact.phoneE164` normalized the same way.
  matchContactsByPhone: (phones: string[]) => Promise<Map<string, string>>;
};

export type ReviewInput = {
  text: string;
  // When the assistant is confident the file is a specific target
  // (from prose context) it passes a hint. Hint overrides auto-
  // detection — useful when the columns are ambiguous (e.g. a file
  // with only `email` could be either contacts or invitees).
  targetHint?: ReviewTarget;
  // Cap on how many rows to include in the `sample` preview. Defaults
  // to 20 so the widget stays compact; the tool handler can raise it
  // for a power-user review pass.
  sampleSize?: number;
};

// ---- label dictionaries -------------------------------------------

// Columns we recognise as "this is a header, not data". Drawn from the
// Contact / Invitee Prisma columns plus common alternate spellings
// operators use in source spreadsheets. All entries are normalized
// (lowercase, snake_case).
const LIKELY_HEADER_LABELS = new Set([
  "name",
  "full_name",
  "first_name",
  "last_name",
  "given_name",
  "family_name",
  "email",
  "email_address",
  "e_mail",
  "phone",
  "mobile",
  "phone_number",
  "mobile_number",
  "phone_e164",
  "organization",
  "company",
  "org",
  "title",
  "position",
  "role",
  "tier",
  "vip_tier",
  "vip",
  "rsvp_token",
  "token",
  "rsvp",
  "campaign",
  "campaign_id",
  "stage",
  "stage_id",
  "invitation_status",
  "invited_at",
  "notes",
  "tags",
  "event_name",
  "venue",
  "event_at",
  "locale",
  "description",
]);

// Contact-channel columns — the presence of at least one is the
// primary signal that a row is a contact/invitee listing rather than
// metadata. Any one of these is sufficient.
const CONTACT_COLUMNS = new Set([
  "email",
  "email_address",
  "e_mail",
  "phone",
  "mobile",
  "phone_number",
  "mobile_number",
  "phone_e164",
]);

// Invitee-specific columns — if a file has contact columns AND any of
// these, it's an invitee list (tied to a campaign) rather than a
// plain contacts import. The hint from the assistant can still
// override.
const INVITEE_MARKERS = new Set([
  "rsvp_token",
  "token",
  "rsvp",
  "campaign",
  "campaign_id",
  "stage",
  "stage_id",
  "invitation_status",
  "invited_at",
]);

// Campaign metadata markers — a one-to-few row file describing an
// event. No contact channels expected.
const METADATA_MARKERS = new Set([
  "event_name",
  "venue",
  "event_at",
  "locale",
  "description",
]);

const HEADER_ALIASES: Record<string, string> = {
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

// ---- delimiter + line parsing -------------------------------------

// Score each candidate delimiter by how many of the first N non-blank
// lines produce the SAME column count (the first line's count). A
// majority-agreement threshold (≥60%) filters noise — a plain-prose
// file won't beat the threshold because line column counts fluctuate
// wildly.
export function detectDelimiter(
  text: string,
  maxLines = 10,
): "," | "\t" | null {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(0, maxLines);
  if (lines.length < 2) return null;

  function score(delim: string): number {
    const counts = lines.map((l) => splitLine(l, delim).length);
    const first = counts[0];
    if (first < 2) return 0;
    return counts.filter((c) => c === first).length;
  }

  const tabScore = score("\t");
  const commaScore = score(",");
  const threshold = Math.ceil(lines.length * 0.6);

  // Tab wins ties — tab-separated exports from Excel / Numbers tend
  // to be cleaner (no embedded commas in free-text fields), so if
  // both delimiters produce consistent counts, prefer tab.
  if (tabScore >= threshold && tabScore >= commaScore) return "\t";
  if (commaScore >= threshold) return ",";
  return null;
}

// Wrapper around parseCsvLine so detectDelimiter can reuse the same
// quoting semantics when scoring (splitting on raw char misses quoted
// commas and under-counts columns).
function splitLine(line: string, delim: string): string[] {
  if (delim === ",") return parseCsvLine(line, ",");
  if (delim === "\t") return parseCsvLine(line, "\t");
  return [line];
}

export function parseCsvLike(
  text: string,
  delimiter: "," | "\t",
): string[][] {
  const out: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    out.push(parseCsvLine(line, delimiter));
  }
  return out;
}

// Single-line CSV parser. Handles double-quoted fields with "" escape
// for an embedded literal quote. Does NOT support multi-line quoted
// fields — if a field contains a raw newline, the caller already
// split on it before this runs. Documented constraint; the widget
// surfaces any resulting row garbage directly so the operator can
// fix the source file.
export function parseCsvLine(line: string, delimiter: "," | "\t"): string[] {
  const out: string[] = [];
  let i = 0;
  let field = "";
  let inQuotes = false;

  while (i < line.length) {
    const c = line[i];

    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === '"' && field.length === 0) {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (c === delimiter) {
      out.push(field);
      field = "";
      i += 1;
      continue;
    }

    field += c;
    i += 1;
  }

  out.push(field);
  return out;
}

// ---- header / row helpers -----------------------------------------

export function normalizeLabel(raw: string): string {
  const normalized = raw.toLowerCase().trim().replace(/[\s-]+/g, "_");
  return HEADER_ALIASES[normalized] ?? normalized;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function looksLikePhone(value: string): boolean {
  return /\+?\d{6,}/.test(value.replace(/[^\d+]/g, ""));
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

// Decide whether the first row is a header. Rules:
//   1. If ≥50% of cells are in LIKELY_HEADER_LABELS → header.
//   2. Otherwise, if the first row looks like DATA (any cell contains
//      an @-sign or a long digit run), treat it as data and synthesise
//      col_1..col_N column names so downstream code has a stable
//      addressing scheme.
//   3. Ambiguous files default to header — a missed header is harder
//      to recover from than a missed data row (losing one preview
//      row is fine; mis-addressing every column is not).
export function detectHeader(
  rows: string[][],
): { header: string[] | null; bodyRows: string[][] } {
  if (rows.length === 0) return { header: null, bodyRows: [] };

  const first = rows[0];
  const normalized = first.map(normalizeLabel);
  const labelHits = normalized.filter((n) => LIKELY_HEADER_LABELS.has(n))
    .length;
  const needed = Math.ceil(first.length / 2);

  if (labelHits >= needed) {
    return { header: normalized, bodyRows: rows.slice(1) };
  }

  const looksLikeData = first.some(
    (cell) => /@/.test(cell) || /\+?\d{6,}/.test(cell),
  );
  if (looksLikeData) {
    const inferred = inferHeaderFromFirstRow(first);
    return { header: inferred, bodyRows: rows };
  }

  return { header: normalized, bodyRows: rows.slice(1) };
}

export function detectTarget(columns: string[]): ReviewTarget | null {
  const cols = new Set(columns);
  const hasContactCol = [...CONTACT_COLUMNS].some((m) => cols.has(m));
  const hasInviteeMarker = [...INVITEE_MARKERS].some((m) => cols.has(m));
  const hasMetadataMarker = [...METADATA_MARKERS].some((m) => cols.has(m));

  if (hasContactCol && hasInviteeMarker) return "invitees";
  if (hasContactCol) return "contacts";
  if (hasMetadataMarker) return "campaign_metadata";
  return null;
}

// Map a parsed row against the detected header. Empty cells are
// OMITTED (not stored as empty strings) so `fields` only contains
// meaningful entries — simplifies issue detection (missing is
// missing, not present-but-empty).
export function normalizeRow(
  header: string[],
  row: string[],
): { fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  for (let i = 0; i < header.length; i += 1) {
    const raw = row[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      fields[header[i]] = trimmed;
    }
  }
  return { fields };
}

// Generous email regex — doesn't validate RFC 5322 fully but catches
// "obvious garbage" (missing @, missing TLD). An operator with a
// legitimate address that fails this will still see the row as
// `new` with a `bad_email` issue flag, so the false-negative cost
// is one soft warning, not a rejection.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_DIGITS_RE = /\d{6,}/;

export function checkContactRowIssues(fields: Record<string, string>): string[] {
  const issues: string[] = [];
  const emailVal = pickField(fields, ["email", "email_address", "e_mail"]);
  const phoneVal = pickField(fields, [
    "phone",
    "mobile",
    "phone_number",
    "mobile_number",
    "phone_e164",
  ]);
  const hasName = Boolean(
    fields.name ??
      fields.full_name ??
      fields.given_name ??
      fields.family_name ??
      (fields.first_name && fields.last_name),
  );
  if (!hasName) issues.push("missing_name");
  if (!emailVal && !phoneVal) issues.push("missing_contact");
  if (emailVal && !EMAIL_RE.test(emailVal)) issues.push("bad_email");
  if (phoneVal && !PHONE_DIGITS_RE.test(phoneVal)) issues.push("bad_phone");
  return issues;
}

function pickField(
  fields: Record<string, string>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    if (fields[k]) return fields[k];
  }
  return undefined;
}

// Digits-only normalization: preserve a leading `+`, strip every
// other non-digit. Matches how the handler feeds phones back to the
// matcher — if the matcher normalizes DB phones the same way, an E.164
// `+9665…` in the DB matches a raw `00 966 5…` in the file.
export function normalizePhoneDigits(raw: string): string {
  const trimmed = raw.trim();
  const plus = trimmed.startsWith("+") ? "+" : "";
  return plus + trimmed.replace(/[^\d]/g, "");
}

// ---- top-level orchestrator ---------------------------------------

export async function reviewIngest(
  input: ReviewInput,
  deps: ReviewDeps,
): Promise<ReviewProfile | null> {
  const sampleSize = input.sampleSize ?? 20;
  const notes: string[] = [];

  const delim = detectDelimiter(input.text);
  if (!delim) return null;
  notes.push(delim === "," ? "Detected CSV format." : "Detected TSV format.");

  const rawRows = parseCsvLike(input.text, delim);
  if (rawRows.length === 0) return null;

  const { header, bodyRows } = detectHeader(rawRows);
  if (!header) return null;

  const autoTarget = detectTarget(header);
  const target: ReviewTarget | null = input.targetHint ?? autoTarget;
  if (!target) {
    return null;
  }
  if (input.targetHint && autoTarget && autoTarget !== input.targetHint) {
    notes.push(
      `Target forced to ${target} (auto-detected ${autoTarget}).`,
    );
  } else if (input.targetHint) {
    notes.push(`Target forced to ${target} by caller.`);
  } else {
    notes.push(`Auto-detected target: ${target}.`);
  }

  const totalRows = bodyRows.length;
  const sampleRows = bodyRows.slice(0, sampleSize);

  let emailMatches = new Map<string, string>();
  let phoneMatches = new Map<string, string>();

  if (target === "contacts" || target === "invitees") {
    const emails: string[] = [];
    const phones: string[] = [];
    for (const row of sampleRows) {
      const { fields } = normalizeRow(header, row);
      const em = pickField(fields, ["email", "email_address", "e_mail"]);
      if (em && EMAIL_RE.test(em)) {
        emails.push(em.toLowerCase());
      }
      const ph = pickField(fields, [
        "phone",
        "mobile",
        "phone_number",
        "mobile_number",
        "phone_e164",
      ]);
      if (ph) {
        const digits = normalizePhoneDigits(ph);
        if (digits.replace("+", "").length >= 6) phones.push(digits);
      }
    }
    if (emails.length > 0) {
      emailMatches = await deps.matchContactsByEmail(Array.from(new Set(emails)));
    }
    if (phones.length > 0) {
      phoneMatches = await deps.matchContactsByPhone(Array.from(new Set(phones)));
    }
  }

  const sample: ReviewSampleRow[] = [];
  let newCount = 0;
  let existingCount = 0;
  let unknownCount = 0;
  let withIssuesCount = 0;

  for (const row of sampleRows) {
    const { fields } = normalizeRow(header, row);
    let rowStatus: RowStatus = "unknown";
    let matchId: string | null = null;
    let issues: string[] = [];

    if (target === "contacts" || target === "invitees") {
      issues = checkContactRowIssues(fields);
      const emRaw = pickField(fields, ["email", "email_address", "e_mail"]);
      const em = emRaw ? emRaw.toLowerCase() : null;
      const phRaw = pickField(fields, [
        "phone",
        "mobile",
        "phone_number",
        "mobile_number",
        "phone_e164",
      ]);
      const ph = phRaw ? normalizePhoneDigits(phRaw) : null;

      const emHit = em ? emailMatches.get(em) : undefined;
      const phHit = ph ? phoneMatches.get(ph) : undefined;

      if (emHit || phHit) {
        rowStatus = "existing_match";
        matchId = emHit ?? phHit ?? null;
        existingCount += 1;
      } else {
        rowStatus = "new";
        newCount += 1;
      }
      if (issues.length > 0) withIssuesCount += 1;
    } else {
      // campaign_metadata: no matching in P6, no per-row issue list.
      rowStatus = "unknown";
      unknownCount += 1;
    }

    const entry: ReviewSampleRow = { fields, rowStatus };
    if (matchId !== null) entry.matchId = matchId;
    if (issues.length > 0) entry.issues = issues;
    sample.push(entry);
  }

  if (target === "campaign_metadata") {
    notes.push("Metadata preview — no row matching performed in P6.");
  }

  return {
    target,
    columns: header,
    sample,
    totals: {
      rows: totalRows,
      sampled: sample.length,
      new: newCount,
      existing_match: existingCount,
      // P6 does not produce conflicts — always zero. Shape pinned for
      // P7's detection work to slot into.
      conflict: 0,
      with_issues: withIssuesCount,
    },
    notes,
  };
}
