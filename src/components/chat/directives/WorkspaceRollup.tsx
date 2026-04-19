"use client";

import type { FormatContext } from "./CampaignList";

// Workspace rollup renderer. Pinned to the `summary` slot via the
// stable `workspace.summary` widget key (see
// `src/lib/ai/widgetKeys.ts`). Purely presentational — all counters
// come from the server's `computeWorkspaceRollup` helper, which is
// the only producer of this kind.
//
// Layout: one thin strip with grouped counters. Stays compact so it
// never dominates the summary row; the numbers are tabular-nums so
// scaled typefaces don't shift digits as the rollup refreshes.

export type WorkspaceRollupProps = {
  campaigns: {
    draft: number;
    active: number;
    closed: number;
    archived: number;
    total: number;
  };
  invitees: { total: number };
  responses: {
    total: number;
    attending: number;
    declined: number;
    recent_24h: number;
  };
  invitations: { sent_24h: number };
  generated_at: string;
};

// Relative-time formatter for the "updated Xm ago" label. No external
// dep — Intl.RelativeTimeFormat is in Node 20 + every evergreen
// browser. Rounds to the closest unit so a 59-second refresh shows
// "just now", a 10-minute-old one shows "10m ago".
function formatAge(iso: string, locale: "en" | "ar"): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const diffSec = Math.max(0, Math.round(diffMs / 1000));
  if (diffSec < 30) return locale === "ar" ? "الآن" : "just now";
  const rtf = new Intl.RelativeTimeFormat(
    locale === "ar" ? "ar-SA" : "en-GB",
    { numeric: "auto" },
  );
  if (diffSec < 60 * 60) {
    const m = Math.max(1, Math.round(diffSec / 60));
    return rtf.format(-m, "minute");
  }
  if (diffSec < 60 * 60 * 24) {
    const h = Math.max(1, Math.round(diffSec / 3600));
    return rtf.format(-h, "hour");
  }
  const d = Math.max(1, Math.round(diffSec / 86400));
  return rtf.format(-d, "day");
}

function labels(locale: "en" | "ar") {
  if (locale === "ar") {
    return {
      campaigns: "الحملات",
      draft: "مسودة",
      active: "نشطة",
      closed: "مغلقة",
      archived: "مؤرشفة",
      invitees: "المدعوون",
      responses: "الردود",
      attending: "حضور",
      declined: "اعتذر",
      recent: "آخر 24 ساعة",
      sent: "أُرسل (24س)",
      updated: "تم التحديث",
    };
  }
  return {
    campaigns: "Campaigns",
    draft: "draft",
    active: "active",
    closed: "closed",
    archived: "archived",
    invitees: "Invitees",
    responses: "Responses",
    attending: "yes",
    declined: "no",
    recent: "last 24h",
    sent: "sent 24h",
    updated: "Updated",
  };
}

export function WorkspaceRollup({
  props,
  fmt,
}: {
  props: WorkspaceRollupProps;
  fmt: FormatContext;
}) {
  const l = labels(fmt.locale);
  const age = formatAge(props.generated_at, fmt.locale);

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm text-slate-700">
        <span className="font-medium text-slate-900 tabular-nums">
          {l.campaigns}: {props.campaigns.total}
        </span>
        <span className="text-slate-500 tabular-nums">
          {props.campaigns.draft} {l.draft} · {props.campaigns.active}{" "}
          {l.active} · {props.campaigns.closed} {l.closed} ·{" "}
          {props.campaigns.archived} {l.archived}
        </span>
        <span className="tabular-nums">
          {l.invitees}: {props.invitees.total}
        </span>
        <span className="tabular-nums">
          {l.responses}: {props.responses.total}
          <span className="text-slate-500">
            {" "}
            ({props.responses.attending} {l.attending} ·{" "}
            {props.responses.declined} {l.declined} ·{" "}
            {props.responses.recent_24h} {l.recent})
          </span>
        </span>
        <span className="tabular-nums">
          {l.sent}: {props.invitations.sent_24h}
        </span>
        {age && (
          <span className="ms-auto text-mini text-slate-400">
            {l.updated} {age}
          </span>
        )}
      </div>
    </div>
  );
}
