"use client";

import Link from "next/link";
import clsx from "clsx";
import type { FormatContext } from "./CampaignList";

// Deep-read card for a single campaign. Emitted by the
// `campaign_detail` tool as `kind: "campaign_card"`. Pure
// presentation — all data is in `props`. Dates format via
// the same client-side `Intl.DateTimeFormat` tag we use in
// `CampaignList` so hijri / Asia/Riyadh output stays
// consistent across the chat surface.
//
// Layout: a top row (name + status chip + event-at + venue
// link), a compact stats strip, an inline activity feed.
// Each activity row has a tone dot — same four tones the
// Overview page uses, same Tailwind palette.

export type CampaignCardProps = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  event_at: string | null;
  venue: string | null;
  locale: string | null;
  team_id: string | null;
  created_at: string;
  updated_at: string;
  stats: {
    total: number;
    responded: number;
    pending: number;
    attending: number;
    declined: number;
    guests: number;
    headcount: number;
    sentEmail: number;
    sentSms: number;
  };
  activity: Array<{
    id: string;
    created_at: string;
    kind: string;
    tone: "default" | "success" | "warn" | "fail";
    line: string;
  }>;
};

function formatEventAt(iso: string | null, fmt: FormatContext): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const base = fmt.locale === "ar" ? "ar-SA" : "en-GB";
  const tag =
    fmt.calendar === "hijri" ? `${base}-u-ca-islamic-umalqura` : base;
  try {
    return new Intl.DateTimeFormat(tag, {
      dateStyle: "full",
      timeStyle: "short",
      timeZone: fmt.tz,
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(d);
  }
}

const STATUS_CLASS: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  active: "bg-emerald-100 text-emerald-800",
  sending: "bg-amber-100 text-amber-800",
  closed: "bg-slate-200 text-slate-600",
  archived: "bg-slate-100 text-slate-500",
};

const TONE_DOT: Record<string, string> = {
  default: "bg-slate-400",
  success: "bg-emerald-500",
  warn: "bg-amber-500",
  fail: "bg-rose-500",
};

export function CampaignCard({
  props,
  fmt,
}: {
  props: CampaignCardProps;
  fmt: FormatContext;
}) {
  const when = formatEventAt(props.event_at, fmt);
  const s = props.stats;
  return (
    <div className="rounded-md border border-slate-200 bg-white overflow-hidden">
      <div className="px-3 py-2 border-b border-slate-100">
        <Link
          href={`/campaigns/${props.id}`}
          className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm hover:bg-slate-50 -mx-3 px-3 py-1 rounded"
        >
          <span className="font-medium text-slate-900 text-base">
            {props.name}
          </span>
          <span
            className={clsx(
              "rounded px-1.5 py-0.5 text-[11px] font-medium",
              STATUS_CLASS[props.status] ?? STATUS_CLASS.draft,
            )}
          >
            {props.status}
          </span>
          {when && <span className="text-slate-500 tabular-nums">{when}</span>}
          {props.venue && (
            <span className="text-slate-500">@ {props.venue}</span>
          )}
        </Link>
        {props.description && (
          <div className="text-xs text-slate-500 mt-1 line-clamp-2">
            {props.description}
          </div>
        )}
      </div>

      <div className="px-3 py-2 border-b border-slate-100 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div>
          <div className="text-slate-500">Responded</div>
          <div className="tabular-nums text-slate-900">
            {s.responded}/{s.total}
          </div>
        </div>
        <div>
          <div className="text-slate-500">Attending</div>
          <div className="tabular-nums text-slate-900">
            {s.attending} <span className="text-slate-400">+{s.guests}</span>
          </div>
        </div>
        <div>
          <div className="text-slate-500">Headcount</div>
          <div className="tabular-nums text-slate-900">{s.headcount}</div>
        </div>
        <div>
          <div className="text-slate-500">Delivered</div>
          <div className="tabular-nums text-slate-900">
            {s.sentEmail}e / {s.sentSms}s
          </div>
        </div>
      </div>

      {props.activity.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {props.activity.slice(0, 10).map((a) => (
            <li key={a.id} className="px-3 py-1.5 flex items-start gap-2 text-xs">
              <span
                className={clsx(
                  "inline-block w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0",
                  TONE_DOT[a.tone] ?? TONE_DOT.default,
                )}
              />
              <span className="text-slate-700">{a.line}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
