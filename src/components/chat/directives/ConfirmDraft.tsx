"use client";

import Link from "next/link";
import type { FormatContext } from "./CampaignList";

// Renders the `confirm_draft` directive emitted by `draft_campaign`.
// Purpose: tell the operator "yes, the draft exists — here's the
// row, click through to fill in templates/stages". Deliberately
// small — there are no stats yet (brand-new draft), no activity
// feed. One primary link to `/campaigns/<id>` (same target as the
// CampaignList/CampaignCard rows — the campaign detail page is the
// hub with tabs for edit, stages, invitees, etc.), a subdued
// emerald bar to mark "new row created".
//
// Dates format via the same client-side `Intl.DateTimeFormat` tag
// we use in CampaignList/CampaignCard so hijri / Asia/Riyadh
// output stays consistent across chat surfaces.
//
// `event_at_ignored: true` — when the model passed a malformed
// event_at string, we still created the draft but dropped the
// date. Surface a small amber warning so the operator knows to
// set it on the edit page.

export type ConfirmDraftProps = {
  id: string;
  name: string;
  description: string | null;
  venue: string | null;
  event_at: string | null;
  locale: string;
  status: string;
  team_id: string | null;
  created_at: string;
  event_at_ignored?: boolean;
  // W5 — drafts are terminal-on-creation (the row is written before
  // this widget emits), so the state field is always "done". Kept on
  // the type to match the shared CONFIRM_STATES enum in the
  // server-side validator — if the state machine ever gains a
  // pre-terminal draft flow, the renderer needs to fork here and
  // leaving the field off the type would hide that requirement.
  state: "done";
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

export function ConfirmDraft({
  props,
  fmt,
}: {
  props: ConfirmDraftProps;
  fmt: FormatContext;
}) {
  const when = formatEventAt(props.event_at, fmt);
  return (
    <div className="rounded-md border border-emerald-200 bg-emerald-50 overflow-hidden">
      <div className="px-3 py-1.5 text-[11px] font-medium text-emerald-800 uppercase tracking-wide border-b border-emerald-100">
        Draft created
      </div>
      <div className="px-3 py-2 bg-white">
        <Link
          href={`/campaigns/${props.id}`}
          className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm hover:bg-slate-50 -mx-3 px-3 py-1 rounded"
        >
          <span className="font-medium text-slate-900 text-base">
            {props.name}
          </span>
          <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-slate-100 text-slate-700">
            draft
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
        <div className="text-xs text-slate-500 mt-2">
          Next: open the draft to set templates, schedule stages, and
          import invitees.
        </div>
        {props.event_at_ignored && (
          // Same tone as the canonical activity "warn" — amber.
          // Tells the operator the date we got couldn't be parsed,
          // without punishing the whole creation.
          <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
            Event date could not be parsed and was left unset. Edit
            the draft to pick a date from the calendar.
          </div>
        )}
      </div>
    </div>
  );
}
