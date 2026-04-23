import { prisma } from "@/lib/db";
import { fileDigestWidgetKey } from "../widgetKeys";
import { buildIngestOwnershipWhere } from "./ingestAccess";
import type { ToolDef, ToolResult, ToolWidget } from "./types";

type Input = {
  ingestId: string;
};

export const PREVIEW_CHAR_CAP = 1200;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

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
    | "xlsx"
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
      `${filename} (${kind}): ${sizeLabel} of extracted text${lineLabel ? `, ${lineLabel}` : ""}.`,
    );

    if (previewTruncated) {
      lines.push(
        `Preview truncated at ${PREVIEW_CHAR_CAP} chars; full content is available via subsequent tool calls.`,
      );
    }
  } else if (status === "failed") {
    lines.push(
      `${filename} (${kind}): extraction failed - ${ingest.extractionError ?? "no detail"}.`,
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
    "Summarise a file the operator has uploaded. The ingest id is surfaced in the user's composer as a bracketed token of the form `[file: <filename> - <kind>, <size> extracted, ingestId: <cuid>]` (or `[file: <filename> - <reason>, ingestId: <cuid>]` when extraction failed but the ingest row exists) - extract the cuid from there. Renders a file_digest workspace widget with filename, format, extracted size, and a bounded preview of the extracted text. For structured imports (CSV, TSV, or spreadsheet contact/invitee lists), prefer review_file_import instead.",
  scope: "read",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ingestId: {
        type: "string",
        description:
          "The FileIngest row id - returned by /api/uploads as ingest.id on a successful upload, or visible on prior file_digest/import_review cards.",
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

    return { ingestId: record.ingestId.trim() };
  },
  async handler(input, ctx): Promise<ToolResult> {
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
