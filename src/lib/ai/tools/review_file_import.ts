import { prisma } from "@/lib/db";
import {
  reviewIngest,
  type ReviewProfile,
  type ReviewTarget,
} from "@/lib/ingest/review";
import { importReviewWidgetKey } from "../widgetKeys";
import { buildIngestOwnershipWhere } from "./ingestAccess";
import type { ToolDef, ToolResult, ToolWidget } from "./types";

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

export type ReviewIngestInput = {
  id: string;
  fileUploadId: string;
  filename: string;
};

export function buildReviewFileImportResult(
  ingest: ReviewIngestInput,
  profile: ReviewProfile | null,
  now: Date = new Date(),
): ToolResult {
  const filename = ingest.filename;

  if (!profile) {
    return {
      output: {
        summary: `${filename}: does not look like a structured import (no CSV/TSV/spreadsheet columns detected). Use summarize_file for a text preview instead.`,
        ok: false,
      },
    };
  }

  const detectedAt = now.toISOString();

  const sample = profile.sample.map((row) => {
    const fields: Record<string, string> = {};
    for (const key of Object.keys(row.fields)) {
      fields[key] = String(row.fields[key]);
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
    const issueTail =
      profile.totals.with_issues > 0
        ? `; ${profile.totals.with_issues} with issues`
        : "";
    lines.push(
      `${profile.totals.new} new; ${profile.totals.existing_match} already in contact book${issueTail}.`,
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
    "Parse an ingested file as a structured import preview (CSV / TSV / spreadsheet). The ingest id is surfaced in the user's composer as a bracketed token of the form `[file: <filename> - <kind>, <size> extracted, ingestId: <cuid>]` (or `[file: <filename> - <reason>, ingestId: <cuid>]` when extraction failed but the ingest row exists) - extract the cuid from there. Auto-detects whether the file looks like contacts, invitees, or campaign metadata; pass `target` to override detection. Emits an import_review widget with columns, a sample of rows, and per-row match status against the current contact book. Returns a plain text note - no widget - when the file doesn't parse as a structured list. For unstructured documents prefer summarize_file instead.",
  scope: "read",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ingestId: {
        type: "string",
        description:
          "The FileIngest row id - the same id surfaced by summarize_file or returned by /api/uploads.",
      },
      target: {
        type: "string",
        enum: ["contacts", "invitees", "campaign_metadata"],
        description:
          "Optional override when auto-detection would pick the wrong target (for example, forcing a single-column email list to invitees for a specific campaign).",
      },
      sample_size: {
        type: "number",
        description: `Max rows to include in the widget preview (1-${MAX_SAMPLE}). Defaults to ${DEFAULT_SAMPLE}.`,
      },
    },
    required: ["ingestId"],
  },
  validate(raw): Input {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("expected_object");
    }

    const record = raw as Record<string, unknown>;
    if (typeof record.ingestId !== "string" || record.ingestId.trim().length === 0) {
      throw new Error("ingestId_required");
    }

    const out: Input = { ingestId: record.ingestId.trim() };

    if (
      typeof record.target === "string" &&
      (TARGETS as readonly string[]).includes(record.target)
    ) {
      out.target = record.target as ReviewTarget;
    }

    if (typeof record.sample_size === "number" && Number.isFinite(record.sample_size)) {
      out.sample_size = Math.max(1, Math.min(MAX_SAMPLE, Math.floor(record.sample_size)));
    }

    return out;
  },
  async handler(input, ctx): Promise<ToolResult> {
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
          const lowered = emails.map((email) => email.toLowerCase());
          const contacts = await prisma.contact.findMany({
            where: { email: { in: lowered, mode: "insensitive" } },
            select: { id: true, email: true },
          });
          const out = new Map<string, string>();
          for (const contact of contacts) {
            if (!contact.email) continue;
            out.set(contact.email.toLowerCase(), contact.id);
          }
          return out;
        },
        matchContactsByPhone: async (phones) => {
          if (phones.length === 0) return new Map();

          const contacts = await prisma.contact.findMany({
            where: { phoneE164: { not: null } },
            select: { id: true, phoneE164: true },
          });

          const dbByDigits = new Map<string, string>();
          for (const contact of contacts) {
            if (!contact.phoneE164) continue;
            const digits = contact.phoneE164.replace(/\D/g, "");
            if (digits.length > 0) dbByDigits.set(digits, contact.id);
          }

          const out = new Map<string, string>();
          for (const phone of phones) {
            const digits = phone.replace(/\D/g, "");
            if (digits.length === 0) continue;
            const hit = dbByDigits.get(digits);
            if (hit) out.set(phone, hit);
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
