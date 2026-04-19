import { prisma } from "@/lib/db";
import { fileDigestWidgetKey } from "../widgetKeys";
import { buildIngestOwnershipWhere } from "./ingestAccess";
import type { ToolDef, ToolResult } from "./types";
import type { ToolWidget } from "./types";

// P6 — summarise an ingested file.
//
// Reads a FileIngest row (joined with its FileUpload for filename +
// uploadId) and emits a `file_digest` workspace widget so the operator
// sees a structured reference card rather than a prose dump.
//
// Every prop points back at the source via `fileUploadId` / `ingestId`
// — this is the P6 "facts must trace back to the file/job" constraint.
// The card carries a BOUNDED preview (first PREVIEW_CHAR_CAP chars of
// extracted text) rather than the full body, because:
//   (a) the full text can exceed MAX_PROPS_JSON_BYTES for large
//       documents, and
//   (b) piping raw extracted text into the dashboard would defeat
//       P5's "don't inject file text into prompts/UI" stance. The
//       operator wanted a summary, not a transcript of the file.
//
// The widget is upserted by `fileDigestWidgetKey(ingestId)`, so a
// re-run for the same ingest REPLACES the prior card — matches the
// "same reference, same card" invariant every other per-entity widget
// follows.

type Input = {
  ingestId: string;
};

export const PREVIEW_CHAR_CAP = 1200;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// The minimal ingest shape the pure formatter needs. Handler fetches
// this; tests pass a literal.
export type FileDigestIngestInput = {
  id: string;
  fileUploadId: string;
  status: string;
  kind: string;
  extractedText: string | null;
  extractionError: string | null;
  bytesExtracted: number;
  updatedAt: Date;
  filename: string;
};

// Pure formatter — takes a fetched ingest row (flattened with filename)
// and returns the tool result. No Prisma, no I/O. Handler delegates
// here after the DB fetch; tests exercise this directly.
export function buildSummarizeFileResult(
  ingest: FileDigestIngestInput,
): ToolResult {
  const filename = ingest.filename;
  const extractedAt = ingest.updatedAt.toISOString();

  if (ingest.status === "pending") {
    return {
      output: {
        summary: `${filename}: extraction is still pending. Try again shortly.`,
        ok: false,
      },
    };
  }

  const status = ingest.status as "extracted" | "failed" | "unsupported";
  const kind = ingest.kind as
    | "text_plain"
    | "pdf"
    | "docx"
    | "unsupported"
    | "failed";

  const extractedText = ingest.extractedText ?? null;
  const previewText = extractedText
    ? extractedText.slice(0, PREVIEW_CHAR_CAP)
    : null;
  const previewTruncated = Boolean(
    extractedText && extractedText.length > PREVIEW_CHAR_CAP,
  );
  const charCount = extractedText ? extractedText.length : null;
  const lineCount = extractedText ? extractedText.split(/\r?\n/).length : null;

  const props = {
    fileUploadId: ingest.fileUploadId,
    ingestId: ingest.id,
    filename,
    kind,
    status,
    bytesExtracted: ingest.bytesExtracted,
    preview: previewText,
    charCount,
    lineCount,
    extractedAt,
    extractionError: ingest.extractionError ?? null,
    previewTruncated,
  };

  const lines: string[] = [];
  if (status === "extracted") {
    const sizeLabel = formatBytes(ingest.bytesExtracted);
    const lineLabel =
      lineCount !== null
        ? `${lineCount} line${lineCount === 1 ? "" : "s"}`
        : "";
    lines.push(
      `${filename} (${kind}): ${sizeLabel} of extracted text${lineLabel ? ", " + lineLabel : ""}.`,
    );
    if (previewTruncated) {
      lines.push(
        `Preview truncated at ${PREVIEW_CHAR_CAP} chars; full content is available via subsequent tool calls.`,
      );
    }
  } else if (status === "failed") {
    lines.push(
      `${filename} (${kind}): extraction failed — ${ingest.extractionError ?? "no detail"}.`,
    );
  } else {
    lines.push(
      `${filename}: file kind is unsupported for text extraction (${kind}). Consider converting to PDF or DOCX.`,
    );
  }

  const widget: ToolWidget = {
    widgetKey: fileDigestWidgetKey(ingest.id),
    kind: "file_digest",
    slot: "secondary",
    props,
  };

  return {
    output: { summary: lines.join("\n"), ok: true },
    widget,
  };
}

export const summarizeFileTool: ToolDef<Input> = {
  name: "summarize_file",
  description:
    "Summarise a file the operator has uploaded. The ingest id is surfaced in the user's composer as a bracketed token of the form `[file: <filename> — <kind>, <size> extracted, ingestId: <cuid>]` (or `[file: <filename> — <reason>, ingestId: <cuid>]` when extraction failed but the ingest row exists) — extract the cuid from there. Renders a file_digest workspace widget with filename, format, extracted size, and a bounded preview of the extracted text. For structured imports (CSV contacts / invitee lists), prefer review_file_import instead.",
  scope: "read",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ingestId: {
        type: "string",
        description:
          "The FileIngest row id — returned by /api/uploads as `ingest.id` on a successful upload, or visible on prior file_digest / import_review cards.",
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
    return { ingestId: r.ingestId.trim() };
  },
  async handler(input, ctx): Promise<ToolResult> {
    // Ownership gate — non-admins can only read ingests tied to
    // FileUpload rows they themselves uploaded. Admins see everything.
    // Filtering at the Prisma level means a mismatched-owner lookup
    // returns the same "not found" response as a genuinely-missing id,
    // so the tool never leaks whether an id exists under another user.
    const ingest = await prisma.fileIngest.findFirst({
      where: buildIngestOwnershipWhere(input.ingestId, ctx),
      select: {
        id: true,
        fileUploadId: true,
        status: true,
        kind: true,
        extractedText: true,
        extractionError: true,
        bytesExtracted: true,
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

    return buildSummarizeFileResult({
      id: ingest.id,
      fileUploadId: ingest.fileUploadId,
      status: ingest.status,
      kind: ingest.kind,
      extractedText: ingest.extractedText,
      extractionError: ingest.extractionError,
      bytesExtracted: ingest.bytesExtracted,
      updatedAt: ingest.updatedAt,
      filename: ingest.fileUpload.filename,
    });
  },
};
