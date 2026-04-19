import { prisma } from "@/lib/db";
import {
  reviewIngest,
  type ReviewProfile,
  type ReviewTarget,
} from "@/lib/ingest/review";
import { importReviewWidgetKey } from "../widgetKeys";
import { buildIngestOwnershipWhere } from "./ingestAccess";
import type { ToolDef, ToolResult, ToolWidget } from "./types";

// P6 — review a file the assistant suspects is an importable list.
//
// Reads the FileIngest row, runs the `reviewIngest` parser/detector
// on its extracted text, and emits an `import_review` widget showing:
//   - detected target (contacts / invitees / campaign_metadata)
//   - columns and a bounded sample of rows
//   - per-row status (new / existing_match) against the current DB
//   - totals and human-readable notes
//
// P6 is READ-ONLY — no imports write to the DB here. The review gives
// the operator visibility before P7's commit flow lands. Matches the
// roadmap constraint "no automatic writes from a file parse without an
// explicit operator confirmation step".
//
// Widget key is `import.review.<target>.<ingestId>` so a single file
// can host coexisting contacts / invitees review cards if the operator
// pivots the target hint. Re-running with the same target replaces
// the card.
//
// Falls back to a plain text response (no widget) when the file
// doesn't look like a structured import — the assistant should then
// route the operator to `summarize_file` instead.

type Input = {
  ingestId: string;
  target?: ReviewTarget;
  sample_size?: number;
};

export const MAX_SAMPLE = 50;
export const DEFAULT_SAMPLE = 20;
const TARGETS: readonly ReviewTarget[] = [
  "contacts",
  "invitees",
  "campaign_metadata",
];

// The minimal ingest shape the pure formatter needs. Handler fetches
// this (flattening filename from the FileUpload join); tests pass a
// literal.
export type ReviewIngestInput = {
  id: string;
  fileUploadId: string;
  filename: string;
};

// Pure formatter — given the fetched ingest row (flattened with
// filename) and the review outcome (possibly null when the file
// doesn't look structured), produce the ToolResult.
//
// Kept side-effect-free so tests can cover the full matrix of profile
// shapes (null / contacts / invitees / campaign_metadata) without
// touching Prisma or the review library's async deps.
export function buildReviewFileImportResult(
  ingest: ReviewIngestInput,
  profile: ReviewProfile | null,
  now: Date = new Date(),
): ToolResult {
  const filename = ingest.filename;

  if (!profile) {
    return {
      output: {
        summary: `${filename}: does not look like a structured import (no CSV/TSV delimiter detected, or no recognised columns). Use summarize_file for a text preview instead.`,
        ok: false,
      },
    };
  }

  const detectedAt = now.toISOString();

  // Stringify sample fields defensively — the review library already
  // yields strings, but the validator requires every field value to
  // be a string, so coerce just in case a future detector tweak lets
  // a number through.
  const sample = profile.sample.map((row) => {
    const fields: Record<string, string> = {};
    for (const k of Object.keys(row.fields)) {
      fields[k] = String(row.fields[k]);
    }
    const entry: {
      fields: Record<string, string>;
      rowStatus: typeof row.rowStatus;
      matchId?: string | null;
      issues?: string[];
    } = { fields, rowStatus: row.rowStatus };
    if (row.matchId !== undefined) entry.matchId = row.matchId;
    if (row.issues !== undefined) entry.issues = row.issues;
    return entry;
  });

  const props = {
    fileUploadId: ingest.fileUploadId,
    ingestId: ingest.id,
    filename,
    target: profile.target,
    columns: profile.columns,
    sample,
    totals: profile.totals,
    detectedAt,
    notes: profile.notes,
  };

  const lines: string[] = [];
  const targetLabel = profile.target.replace("_", " ");
  lines.push(
    `${filename}: detected ${profile.totals.rows} ${targetLabel} row${profile.totals.rows === 1 ? "" : "s"}, ${profile.totals.sampled} shown.`,
  );
  if (profile.target === "contacts" || profile.target === "invitees") {
    lines.push(
      `${profile.totals.new} new · ${profile.totals.existing_match} already in contact book${profile.totals.with_issues > 0 ? ` · ${profile.totals.with_issues} with issues` : ""}.`,
    );
  }

  const widget: ToolWidget = {
    widgetKey: importReviewWidgetKey(profile.target, ingest.id),
    kind: "import_review",
    slot: "primary",
    props,
  };

  return {
    output: { summary: lines.join("\n"), ok: true },
    widget,
  };
}

export const reviewFileImportTool: ToolDef<Input> = {
  name: "review_file_import",
  description:
    "Parse an ingested file as a structured import preview (CSV / TSV). The ingest id is surfaced in the user's composer as a bracketed token of the form `[file: <filename> — <kind>, <size> extracted, ingestId: <cuid>]` (or `[file: <filename> — <reason>, ingestId: <cuid>]` when extraction failed but the ingest row exists) — extract the cuid from there. Auto-detects whether the file looks like contacts, invitees, or campaign metadata; pass `target` to override detection. Emits an import_review widget with columns, a sample of rows, and per-row match status against the current contact book. Returns a plain text note — no widget — when the file doesn't parse as a structured list. For unstructured documents prefer summarize_file instead.",
  scope: "read",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ingestId: {
        type: "string",
        description:
          "The FileIngest row id — the same id surfaced by `summarize_file` or returned by /api/uploads.",
      },
      target: {
        type: "string",
        enum: ["contacts", "invitees", "campaign_metadata"],
        description:
          "Optional override when auto-detection would pick the wrong target (e.g. a single-column email list should be forced to `invitees` for a specific campaign).",
      },
      sample_size: {
        type: "number",
        description: `Max rows to include in the widget preview (1–${MAX_SAMPLE}). Defaults to ${DEFAULT_SAMPLE}.`,
      },
    },
    required: ["ingestId"],
  },
  validate(raw): Input {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("expected_object");
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.ingestId !== "string" || r.ingestId.trim().length === 0) {
      throw new Error("ingestId_required");
    }
    const out: Input = { ingestId: r.ingestId.trim() };
    if (typeof r.target === "string" && (TARGETS as readonly string[]).includes(r.target)) {
      out.target = r.target as ReviewTarget;
    }
    if (typeof r.sample_size === "number" && Number.isFinite(r.sample_size)) {
      out.sample_size = Math.max(1, Math.min(MAX_SAMPLE, Math.floor(r.sample_size)));
    }
    return out;
  },
  async handler(input, ctx): Promise<ToolResult> {
    // Ownership gate — same policy as summarize_file. Non-admins can
    // only review ingests tied to FileUploads they uploaded. The
    // relation filter at the Prisma level means a wrong-owner hit
    // returns "not found" identically to a missing id — no side-
    // channel for probing other operators' ingest ids.
    const ingest = await prisma.fileIngest.findFirst({
      where: buildIngestOwnershipWhere(input.ingestId, ctx),
      select: {
        id: true,
        fileUploadId: true,
        status: true,
        extractedText: true,
        updatedAt: true,
        fileUpload: { select: { filename: true } },
      },
    });

    if (!ingest) {
      return {
        output: {
          summary: `No ingest record found for id ${input.ingestId}.`,
          ok: false,
        },
      };
    }

    if (ingest.status !== "extracted" || !ingest.extractedText) {
      return {
        output: {
          summary: `${ingest.fileUpload.filename}: no extracted text available (status=${ingest.status}). Cannot preview as import.`,
          ok: false,
        },
      };
    }

    const profile = await reviewIngest(
      {
        text: ingest.extractedText,
        targetHint: input.target,
        sampleSize: input.sample_size ?? DEFAULT_SAMPLE,
      },
      {
        matchContactsByEmail: async (emails) => {
          if (emails.length === 0) return new Map();
          const lowered = emails.map((e) => e.toLowerCase());
          const contacts = await prisma.contact.findMany({
            where: { email: { in: lowered, mode: "insensitive" } },
            select: { id: true, email: true },
          });
          const out = new Map<string, string>();
          for (const c of contacts) {
            if (!c.email) continue;
            out.set(c.email.toLowerCase(), c.id);
          }
          return out;
        },
        matchContactsByPhone: async (phones) => {
          if (phones.length === 0) return new Map();
          // Digits-only matching — tolerates format differences
          // between the file's raw phones and the DB's stored
          // E.164. Bounded contact book keeps the in-memory match
          // cheap; P7 can move this to a derived indexed column
          // if it becomes hot.
          const contacts = await prisma.contact.findMany({
            where: { phoneE164: { not: null } },
            select: { id: true, phoneE164: true },
          });
          const dbByDigits = new Map<string, string>();
          for (const c of contacts) {
            if (!c.phoneE164) continue;
            const digits = c.phoneE164.replace(/\D/g, "");
            if (digits.length > 0) dbByDigits.set(digits, c.id);
          }
          const out = new Map<string, string>();
          for (const ph of phones) {
            const digits = ph.replace(/\D/g, "");
            if (digits.length === 0) continue;
            const hit = dbByDigits.get(digits);
            if (hit) out.set(ph, hit);
          }
          return out;
        },
      },
    );

    return buildReviewFileImportResult(
      {
        id: ingest.id,
        fileUploadId: ingest.fileUploadId,
        filename: ingest.fileUpload.filename,
      },
      profile,
    );
  },
};
