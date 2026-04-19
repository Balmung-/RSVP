"use client";

import clsx from "clsx";
import type { FormatContext } from "./CampaignList";

// P6 — `import_review` renderer. Structured preview of a file the
// assistant has parsed as a candidate import. Read-only in P6; the
// commit action lands with P7 as a separate confirm widget.
//
// Layout:
//   - Header: filename + detected target badge + totals strip
//   - Notes: heuristic decisions from the parser (delimiter, header
//     handling, target inference)
//   - Sample table: columns + bounded row preview, each row tagged
//     with its match status and any field-level issues
//   - Source footer: fileUploadId for trace-back

export type ImportReviewRowStatus =
  | "new"
  | "existing_match"
  | "conflict"
  | "unknown";

export type ImportReviewProps = {
  fileUploadId: string;
  ingestId: string;
  filename: string;
  target: "contacts" | "invitees" | "campaign_metadata";
  columns: string[];
  sample: Array<{
    fields: Record<string, string>;
    rowStatus: ImportReviewRowStatus;
    matchId?: string | null;
    issues?: string[];
  }>;
  totals: {
    rows: number;
    sampled: number;
    new: number;
    existing_match: number;
    conflict: number;
    with_issues: number;
  };
  detectedAt: string;
  notes: string[];
};

const STATUS_CLASS: Record<ImportReviewRowStatus, string> = {
  new: "bg-emerald-100 text-emerald-800",
  existing_match: "bg-slate-100 text-slate-700",
  conflict: "bg-amber-100 text-amber-800",
  unknown: "bg-slate-50 text-slate-500",
};

function targetLabel(
  target: ImportReviewProps["target"],
  locale: "en" | "ar",
): string {
  if (locale === "ar") {
    switch (target) {
      case "contacts":
        return "جهات الاتصال";
      case "invitees":
        return "المدعوون";
      case "campaign_metadata":
        return "بيانات الحملة";
    }
  }
  switch (target) {
    case "contacts":
      return "Contacts";
    case "invitees":
      return "Invitees";
    case "campaign_metadata":
      return "Campaign metadata";
  }
}

function statusLabel(
  status: ImportReviewRowStatus,
  locale: "en" | "ar",
): string {
  if (locale === "ar") {
    switch (status) {
      case "new":
        return "جديد";
      case "existing_match":
        return "موجود";
      case "conflict":
        return "تعارض";
      case "unknown":
        return "—";
    }
  }
  switch (status) {
    case "new":
      return "new";
    case "existing_match":
      return "exists";
    case "conflict":
      return "conflict";
    case "unknown":
      return "—";
  }
}

function labels(locale: "en" | "ar") {
  if (locale === "ar") {
    return {
      rowsTotal: "الإجمالي",
      new: "جديد",
      exists: "موجود",
      issues: "ملاحظات",
      sampled: "معروض",
      noSample: "لم يتم استخراج أي صف.",
      sourceLabel: "الملف الأصلي",
      detectedAt: "تم التحليل",
      notesHeading: "ملاحظات التحليل",
      columnsHeading: "الأعمدة",
    };
  }
  return {
    rowsTotal: "rows",
    new: "new",
    exists: "exists",
    issues: "issues",
    sampled: "shown",
    noSample: "No rows extracted from preview.",
    sourceLabel: "Source file",
    detectedAt: "Detected at",
    notesHeading: "Parser notes",
    columnsHeading: "Columns",
  };
}

export function ImportReview({
  props,
  fmt,
}: {
  props: ImportReviewProps;
  fmt: FormatContext;
}) {
  const l = labels(fmt.locale);
  const targetName = targetLabel(props.target, fmt.locale);

  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 border-b border-slate-100">
        <span className="rounded bg-indigo-100 text-indigo-800 px-1.5 py-0.5 text-[11px] font-medium">
          {targetName}
        </span>
        <span className="text-sm font-medium text-slate-900 break-all">
          {props.filename}
        </span>
        <span className="text-xs text-slate-500 tabular-nums ms-auto">
          {props.totals.rows.toLocaleString()} {l.rowsTotal} ·{" "}
          {props.totals.sampled} {l.sampled}
          {(props.target === "contacts" || props.target === "invitees") && (
            <>
              {" · "}
              <span className="text-emerald-700">
                {props.totals.new} {l.new}
              </span>
              {" · "}
              <span className="text-slate-600">
                {props.totals.existing_match} {l.exists}
              </span>
              {props.totals.with_issues > 0 && (
                <>
                  {" · "}
                  <span className="text-amber-700">
                    {props.totals.with_issues} {l.issues}
                  </span>
                </>
              )}
            </>
          )}
        </span>
      </div>

      {props.notes.length > 0 && (
        <div className="px-3 py-1.5 border-b border-slate-100 bg-slate-50">
          <div className="text-[11px] uppercase tracking-wide text-slate-400">
            {l.notesHeading}
          </div>
          <ul className="text-xs text-slate-600 list-disc ms-4">
            {props.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </div>
      )}

      {props.sample.length === 0 ? (
        <div className="px-3 py-2 text-sm text-slate-500">{l.noSample}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="px-2 py-1.5 text-start text-[11px] uppercase tracking-wide text-slate-400">
                  #
                </th>
                {props.columns.map((col) => (
                  <th
                    key={col}
                    className="px-2 py-1.5 text-start text-[11px] uppercase tracking-wide text-slate-500 font-medium"
                  >
                    {col}
                  </th>
                ))}
                <th className="px-2 py-1.5 text-start text-[11px] uppercase tracking-wide text-slate-400">
                  {l.new}/{l.exists}
                </th>
              </tr>
            </thead>
            <tbody>
              {props.sample.map((row, i) => (
                <tr key={i} className="border-b border-slate-100 last:border-0">
                  <td className="px-2 py-1.5 text-slate-400 tabular-nums">
                    {i + 1}
                  </td>
                  {props.columns.map((col) => (
                    <td
                      key={col}
                      className="px-2 py-1.5 text-slate-700 break-all"
                    >
                      {row.fields[col] ?? ""}
                    </td>
                  ))}
                  <td className="px-2 py-1.5">
                    <span
                      className={clsx(
                        "rounded px-1.5 py-0.5 text-[10px] font-medium",
                        STATUS_CLASS[row.rowStatus],
                      )}
                    >
                      {statusLabel(row.rowStatus, fmt.locale)}
                    </span>
                    {row.issues && row.issues.length > 0 && (
                      <div className="mt-1 text-[10px] text-amber-700">
                        {row.issues.join(", ")}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="px-3 py-1.5 text-[11px] text-slate-400 border-t border-slate-100">
        {l.sourceLabel}: {props.fileUploadId}
      </div>
    </div>
  );
}
