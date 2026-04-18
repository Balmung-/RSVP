"use client";

import clsx from "clsx";
import type { FormatContext } from "./CampaignList";

// Renders the `activity_stream` directive emitted by
// `recent_activity`. One row per EventLog entry. The `line` is
// server-rendered via the shared `phrase()` helper, so
// bilingual phrasing matches what the Overview page shows —
// we just attach the tone dot + timestamp here.

export type ActivityStreamProps = {
  items: Array<{
    id: string;
    created_at: string;
    kind: string;
    ref_type: string | null;
    ref_id: string | null;
    tone: "default" | "success" | "warn" | "fail";
    line: string;
    actor: { email: string; full_name: string | null } | null;
  }>;
  filters?: {
    days: number;
    limit: number;
  };
};

const TONE_DOT: Record<string, string> = {
  default: "bg-slate-400",
  success: "bg-emerald-500",
  warn: "bg-amber-500",
  fail: "bg-rose-500",
};

function formatStamp(iso: string, fmt: FormatContext): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const base = fmt.locale === "ar" ? "ar-SA" : "en-GB";
  const tag =
    fmt.calendar === "hijri" ? `${base}-u-ca-islamic-umalqura` : base;
  try {
    return new Intl.DateTimeFormat(tag, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: fmt.tz,
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-GB", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  }
}

export function ActivityStream({
  props,
  fmt,
}: {
  props: ActivityStreamProps;
  fmt: FormatContext;
}) {
  const items = props.items ?? [];
  if (items.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-600">
        No recent activity in this window.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <ul className="divide-y divide-slate-100">
        {items.map((a) => (
          <li
            key={a.id}
            className="px-3 py-2 flex items-start gap-2 text-xs"
          >
            <span
              className={clsx(
                "inline-block w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0",
                TONE_DOT[a.tone] ?? TONE_DOT.default,
              )}
            />
            <span className="flex-1 text-slate-700">{a.line}</span>
            <span className="text-slate-400 tabular-nums whitespace-nowrap">
              {formatStamp(a.created_at, fmt)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
