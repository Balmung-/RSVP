"use client";

import clsx from "clsx";
import type { FormatContext } from "./CampaignList";

// P6 — `file_digest` renderer. A compact summary card for an ingested
// file: filename, format badge, extracted size, and a bounded preview
// of the first N chars of extracted text.
//
// Presentational only. All state comes from the `summarize_file` tool
// handler — the card has no interactive actions for P6 (dismiss is
// reserved for terminal confirm widgets; a file digest stays until
// replaced by a re-run of summarize_file with the same ingestId).

export type FileDigestProps = {
  fileUploadId: string;
  ingestId: string;
  filename: string;
  kind: "text_plain" | "pdf" | "docx" | "unsupported" | "failed";
  status: "extracted" | "failed" | "unsupported";
  bytesExtracted: number;
  preview: string | null;
  charCount: number | null;
  lineCount: number | null;
  extractedAt: string;
  extractionError: string | null;
  previewTruncated?: boolean;
};

const KIND_LABEL: Record<FileDigestProps["kind"], string> = {
  text_plain: "TXT",
  pdf: "PDF",
  docx: "DOCX",
  unsupported: "UNSUP",
  failed: "FAIL",
};

const KIND_CLASS: Record<FileDigestProps["kind"], string> = {
  text_plain: "bg-slate-100 text-slate-700",
  pdf: "bg-rose-100 text-rose-800",
  docx: "bg-sky-100 text-sky-800",
  unsupported: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-800",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function labels(locale: "en" | "ar") {
  if (locale === "ar") {
    return {
      extracted: "مستخرج",
      chars: "حرف",
      lines: "سطر",
      unsupported: "نوع الملف غير مدعوم للاستخراج النصي.",
      failedPrefix: "فشل الاستخراج",
      previewHeading: "معاينة",
      previewTruncated: "تم اقتطاع المعاينة",
      sourceLabel: "الملف الأصلي",
    };
  }
  return {
    extracted: "extracted",
    chars: "chars",
    lines: "lines",
    unsupported: "File kind not supported for text extraction.",
    failedPrefix: "Extraction failed",
    previewHeading: "Preview",
    previewTruncated: "preview truncated",
    sourceLabel: "Source file",
  };
}

export function FileDigest({
  props,
  fmt,
}: {
  props: FileDigestProps;
  fmt: FormatContext;
}) {
  const l = labels(fmt.locale);

  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 border-b border-slate-100">
        <span
          className={clsx(
            "rounded px-1.5 py-0.5 text-[11px] font-medium",
            KIND_CLASS[props.kind],
          )}
        >
          {KIND_LABEL[props.kind]}
        </span>
        <span className="text-sm font-medium text-slate-900 break-all">
          {props.filename}
        </span>
        {props.status === "extracted" && (
          <span className="text-xs text-slate-500 tabular-nums ms-auto">
            {formatBytes(props.bytesExtracted)} {l.extracted}
            {typeof props.charCount === "number" && (
              <>
                {" · "}
                {props.charCount.toLocaleString()} {l.chars}
              </>
            )}
            {typeof props.lineCount === "number" && (
              <>
                {" · "}
                {props.lineCount.toLocaleString()} {l.lines}
              </>
            )}
          </span>
        )}
      </div>

      {props.status === "failed" && (
        <div className="px-3 py-2 text-sm text-red-800 bg-red-50">
          {l.failedPrefix}
          {props.extractionError ? `: ${props.extractionError}` : ""}.
        </div>
      )}

      {props.status === "unsupported" && (
        <div className="px-3 py-2 text-sm text-amber-800 bg-amber-50">
          {l.unsupported}
        </div>
      )}

      {props.status === "extracted" && props.preview && (
        <div className="px-3 py-2">
          <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">
            {l.previewHeading}
            {props.previewTruncated && (
              <span className="ms-2 normal-case text-slate-400">
                — {l.previewTruncated}
              </span>
            )}
          </div>
          <pre className="text-xs text-slate-700 whitespace-pre-wrap break-words font-sans max-h-48 overflow-y-auto">
            {props.preview}
          </pre>
        </div>
      )}

      <div className="px-3 py-1.5 text-[11px] text-slate-400 border-t border-slate-100">
        {l.sourceLabel}: {props.fileUploadId}
      </div>
    </div>
  );
}
