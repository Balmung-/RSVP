"use client";

import Link from "next/link";
import clsx from "clsx";

// Client-side renderer for the `campaign_list` directive emitted by
// the `list_campaigns` tool. Pure presentation — all data lives in
// `props` exactly as the handler returned it. Dates are formatted
// here with the admin locale/calendar/timezone passed in from the
// enclosing ChatPanel; the server sent ISO strings in `event_at`.
//
// Status chips + headcount numbers mirror the dashboard's conventions
// so a campaign block inside chat reads the same way it does on the
// Campaigns page. Each row is a link back to the detail page so the
// operator can move from "tell me about the calendar" to "open the
// one on Thursday" with a single click.

export type CampaignListProps = {
  items: Array<{
    id: string;
    name: string;
    status: string;
    event_at: string | null;
    venue: string | null;
    team_id: string | null;
    stats: { total: number; responded: number; headcount: number };
  }>;
  filters?: {
    status?: string[];
    upcoming_only?: boolean;
    limit?: number;
  };
};

export type FormatContext = {
  locale: "en" | "ar";
  calendar: "gregorian" | "hijri";
  tz: string;
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
      dateStyle: "medium",
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

// One visible chip per status. Keep the palette muted — this block
// will show up inside chat bubbles and shouldn't compete with the
// assistant's text for attention.
const STATUS_CLASS: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  active: "bg-emerald-100 text-emerald-800",
  sending: "bg-amber-100 text-amber-800",
  closed: "bg-slate-200 text-slate-600",
  archived: "bg-slate-100 text-slate-500",
};

export function CampaignList({
  props,
  fmt,
}: {
  props: CampaignListProps;
  fmt: FormatContext;
}) {
  const items = props.items ?? [];

  if (items.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-600">
        No campaigns matched.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <ul className="divide-y divide-slate-100">
        {items.map((c) => {
          const when = formatEventAt(c.event_at, fmt);
          return (
            <li key={c.id} className="px-3 py-2">
              <Link
                href={`/campaigns/${c.id}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm hover:bg-slate-50 -mx-3 px-3 py-1 rounded"
              >
                <span className="font-medium text-slate-900">{c.name}</span>
                <span
                  className={clsx(
                    "rounded px-1.5 py-0.5 text-[11px] font-medium",
                    STATUS_CLASS[c.status] ?? STATUS_CLASS.draft,
                  )}
                >
                  {c.status}
                </span>
                {when && (
                  <span className="text-slate-500 tabular-nums">{when}</span>
                )}
                {c.venue && (
                  <span className="text-slate-500">@ {c.venue}</span>
                )}
                <span className="ms-auto text-slate-500 tabular-nums">
                  {c.stats.responded}/{c.stats.total} · {c.stats.headcount} head
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
