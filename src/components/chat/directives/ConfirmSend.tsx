"use client";

import Link from "next/link";
import clsx from "clsx";
import type { FormatContext } from "./CampaignList";

// Renders the `confirm_send` directive emitted by `propose_send`.
// This is the confirmation GATE — the operator sees the resolved
// audience / template / count BEFORE any messages go out, then
// clicks Confirm to trigger the actual destructive send through
// `/api/chat/confirm/<messageId>` (Push 7).
//
// Design principles:
//   - Loudness scales with action severity. Unlike ConfirmDraft's
//     quiet emerald banner, this uses amber ("irreversible action
//     ahead") and the confirm button is sized prominently.
//   - Numbers first. The stats strip is the first thing below the
//     header — operator skim path is "what campaign, how many
//     recipients, click".
//   - Blockers are hard gates. If the preview found an empty
//     template, locked status, unsubscribed-only audience, etc.,
//     the button is disabled and the reasons are listed. The
//     operator clicks through to the edit page to fix.
//   - Template preview is expandable. Subject + short body
//     snippets are always visible; the full body lives on the
//     edit page — a preview card shouldn't ship 5k-char bodies
//     across the wire.
//
// Push 6c caveat: the confirm button is rendered but INERT. The
// click handler is a no-op and the button tooltip spells out
// that the wiring ships in Push 7. This keeps the review loop
// honest — GPT sees the shape of the directive + the disabled
// CTA without a backend route that 404s silently.

export type ConfirmSendProps = {
  campaign_id: string;
  name: string;
  status: string;
  venue: string | null;
  event_at: string | null;
  locale: string;
  channel: "email" | "sms" | "both";
  only_unsent: boolean;
  invitee_total: number;
  ready_total: number;
  by_channel: {
    email: {
      ready: number;
      skipped_already_sent: number;
      skipped_unsubscribed: number;
      no_contact: number;
    };
    sms: {
      ready: number;
      skipped_already_sent: number;
      skipped_unsubscribed: number;
      no_contact: number;
    };
  };
  template_preview: {
    subject_email: string | null;
    email_body: string | null;
    sms_body: string | null;
  };
  blockers: string[];
};

const BLOCKER_LABEL: Record<string, string> = {
  no_invitees: "No invitees on this campaign",
  no_ready_recipients:
    "No recipients are ready to send (all skipped or unsubscribed)",
  no_email_template: "Email template is empty",
  no_sms_template: "SMS template is empty",
};

function formatBlocker(raw: string): string {
  if (raw.startsWith("status_locked:")) {
    const status = raw.split(":")[1] ?? "unknown";
    return `Campaign status "${status}" cannot send (only draft or active can)`;
  }
  return BLOCKER_LABEL[raw] ?? raw;
}

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

export function ConfirmSend({
  props,
  fmt,
}: {
  props: ConfirmSendProps;
  fmt: FormatContext;
}) {
  const when = formatEventAt(props.event_at, fmt);
  const hasBlockers = props.blockers.length > 0;
  const canConfirm = !hasBlockers && props.ready_total > 0;
  const channelLabel =
    props.channel === "both" ? "email + SMS" : props.channel;
  const skippedTotal =
    props.by_channel.email.skipped_already_sent +
    props.by_channel.sms.skipped_already_sent;
  const unsubTotal =
    props.by_channel.email.skipped_unsubscribed +
    props.by_channel.sms.skipped_unsubscribed;
  const noContactTotal =
    props.by_channel.email.no_contact + props.by_channel.sms.no_contact;

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 overflow-hidden">
      <div className="px-3 py-1.5 text-[11px] font-medium text-amber-900 uppercase tracking-wide border-b border-amber-200 flex items-center justify-between">
        <span>Confirm send — destructive action</span>
        <span className="font-normal normal-case tracking-normal text-amber-700">
          channel: {channelLabel}
          {props.only_unsent ? "" : " · full re-send"}
        </span>
      </div>

      <div className="px-3 py-2 bg-white">
        <Link
          href={`/campaigns/${props.campaign_id}`}
          className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm hover:bg-slate-50 -mx-3 px-3 py-1 rounded"
        >
          <span className="font-medium text-slate-900 text-base">
            {props.name}
          </span>
          <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-slate-100 text-slate-700">
            {props.status}
          </span>
          {when && <span className="text-slate-500 tabular-nums">{when}</span>}
          {props.venue && (
            <span className="text-slate-500">@ {props.venue}</span>
          )}
        </Link>
      </div>

      <div className="px-3 py-2 border-t border-amber-100 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs bg-white">
        <div>
          <div className="text-slate-500">Invitees</div>
          <div className="tabular-nums text-slate-900">
            {props.invitee_total}
          </div>
        </div>
        <div>
          <div className="text-slate-500">Ready to send</div>
          <div className="tabular-nums text-slate-900 font-medium">
            {props.ready_total}
            {props.channel === "both" && (
              <span className="text-slate-400 font-normal">
                {" "}
                ({props.by_channel.email.ready}e / {props.by_channel.sms.ready}s)
              </span>
            )}
          </div>
        </div>
        <div>
          <div className="text-slate-500">Skipped</div>
          <div className="tabular-nums text-slate-900">
            {skippedTotal}
            {unsubTotal > 0 && (
              <span className="text-slate-400">
                {" "}
                + {unsubTotal} unsub
              </span>
            )}
          </div>
        </div>
        <div>
          <div className="text-slate-500">No contact</div>
          <div className="tabular-nums text-slate-900">{noContactTotal}</div>
        </div>
      </div>

      {(props.template_preview.subject_email ||
        props.template_preview.email_body ||
        props.template_preview.sms_body) && (
        <div className="px-3 py-2 border-t border-amber-100 bg-white text-xs space-y-1">
          {props.template_preview.subject_email && (
            <div>
              <span className="text-slate-500">Subject: </span>
              <span className="text-slate-900">
                {props.template_preview.subject_email}
              </span>
            </div>
          )}
          {props.template_preview.email_body && (
            <div className="text-slate-600 line-clamp-3 whitespace-pre-wrap">
              {props.template_preview.email_body}
            </div>
          )}
          {props.template_preview.sms_body && (
            <div className="text-slate-600 line-clamp-2 whitespace-pre-wrap">
              <span className="text-slate-500">SMS: </span>
              {props.template_preview.sms_body}
            </div>
          )}
        </div>
      )}

      {hasBlockers && (
        <div className="px-3 py-2 border-t border-amber-100 bg-rose-50 text-xs text-rose-900">
          <div className="font-medium mb-1">
            Cannot send — resolve these first:
          </div>
          <ul className="list-disc ms-4 space-y-0.5">
            {props.blockers.map((b) => (
              <li key={b}>{formatBlocker(b)}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="px-3 py-2 border-t border-amber-200 bg-amber-50 flex items-center justify-between gap-3">
        <div className="text-[11px] text-amber-800">
          {/* Push 6c: the click handler is intentionally a no-op.
              Wiring to /api/chat/confirm/<messageId> ships in
              Push 7. Rendering the CTA now lets GPT review the
              directive shape + disabled state without a 404. */}
          Confirmation endpoint lands in Push 7 — this button is
          inert for now.
        </div>
        <button
          type="button"
          disabled
          title={
            canConfirm
              ? "Confirmation endpoint not yet wired (Push 7)"
              : "Resolve blockers before confirming"
          }
          className={clsx(
            "rounded px-3 py-1.5 text-sm font-medium",
            canConfirm
              ? "bg-amber-200 text-amber-900 opacity-60 cursor-not-allowed"
              : "bg-slate-100 text-slate-400 cursor-not-allowed",
          )}
        >
          Confirm send ({props.ready_total})
        </button>
      </div>
    </div>
  );
}
