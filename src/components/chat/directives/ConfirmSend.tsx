"use client";

import { useEffect, useState } from "react";
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
// Wiring (Push 7): the Confirm button POSTs to
// `/api/chat/confirm/<messageId>` with no body. The server reads
// the stored propose_send input, re-dispatches `send_campaign`
// with `allowDestructive: true`, persists a synthetic assistant
// turn with the result summary, and returns JSON. On success we
// morph the footer in-place to a success pill (button hidden) so
// a second click can't re-send; on failure we surface an inline
// error and keep the button live for retry. `messageId` absent is
// treated as a hard disable — it's only missing on legacy/stale
// re-hydrations where there's no coherent row to confirm against.

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
  // Job count (one `(invitee, channel)` pair = one message), NOT a
  // recipient count. An invitee with both email and SMS on
  // channel=both contributes 2 here, not 1. The copy below reflects
  // that — "Messages ready", not "Recipients ready" — so the
  // operator confirms the number of sends they're authorizing.
  ready_messages: number;
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
  // W5 — persisted state of the confirm flow. See `CONFIRM_STATES`
  // in `widget-validate.ts` for the full state machine. On the
  // client:
  //   ready / blocked  — render the preview + enabled/disabled CTA
  //   submitting       — never written by the server; client-local
  //                      transient during the POST window
  //   done             — render the emerald "Sent" morph, carrying
  //                      `result` + optional `summary`
  //   error            — render the inline error, carrying `error` +
  //                      optional `summary`, button reverts to Retry
  // The reload path feeds this straight from the DB so the operator
  // sees the final state without having to re-click.
  state: "ready" | "blocked" | "submitting" | "done" | "error";
  result?: { email: number; sms: number; skipped: number; failed: number };
  error?: string;
  summary?: string;
};

const BLOCKER_LABEL: Record<string, string> = {
  no_invitees: "No invitees on this campaign",
  no_ready_messages:
    "No messages are ready to send (every contact is already sent, unsubscribed, or missing on the chosen channel)",
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

type SendState =
  | { phase: "idle" }
  | { phase: "sending" }
  | {
      phase: "sent";
      summary: string;
      email: number;
      sms: number;
      skipped: number;
      failed: number;
    }
  | { phase: "error"; error: string };

// W5 — project persisted widget state into the local SendState that
// drives the render. `ready`/`blocked`/`submitting` all map to idle
// on the client — the preview is still actionable (or hard-gated by
// blockers, which is a separate render branch). `done` and `error`
// are terminal and carry their payload. Used both for the useState
// initial AND for the props-change sync below, so a reload lands on
// the right terminal morph without the operator clicking anything.
function deriveSendState(props: ConfirmSendProps): SendState {
  if (props.state === "done" && props.result) {
    return {
      phase: "sent",
      summary: props.summary ?? "Send complete.",
      email: props.result.email,
      sms: props.result.sms,
      skipped: props.result.skipped,
      failed: props.result.failed,
    };
  }
  if (props.state === "error") {
    return { phase: "error", error: props.error ?? "unknown" };
  }
  return { phase: "idle" };
}

export function ConfirmSend({
  props,
  fmt,
  messageId,
}: {
  props: ConfirmSendProps;
  fmt: FormatContext;
  messageId?: string;
}) {
  const [state, setState] = useState<SendState>(() => deriveSendState(props));
  // Sync local SendState when the persisted state on props changes —
  // e.g. the operator asked for a fresh preview (server emits a new
  // widget_upsert with state back to "ready"), so the button should
  // re-enable. We watch the small set of terminal-affecting fields
  // rather than the whole props object so a harmless re-render (a
  // parent ref change, say) doesn't clobber client-local `sending`.
  // Dep list is the same set `deriveSendState` inspects.
  useEffect(() => {
    setState(deriveSendState(props));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.state, props.error, props.summary, props.result?.email, props.result?.sms, props.result?.skipped, props.result?.failed]);
  const when = formatEventAt(props.event_at, fmt);
  const hasBlockers = props.blockers.length > 0;
  // `canConfirm` now also requires a messageId — without one the
  // POST has no authorization anchor, so the button has nowhere to
  // go. See the file-top wiring comment.
  const hasAnchor = typeof messageId === "string" && messageId.length > 0;
  const canConfirm =
    !hasBlockers && props.ready_messages > 0 && hasAnchor && state.phase === "idle";
  const channelLabel =
    props.channel === "both" ? "email + SMS" : props.channel;

  async function onConfirm() {
    if (!hasAnchor) return;
    setState({ phase: "sending" });
    try {
      const res = await fetch(`/api/chat/confirm/${messageId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      // Read body defensively — a proxy or route-level 500 may
      // return non-JSON. We surface the HTTP code in that case so
      // the operator has something actionable.
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (!res.ok) {
        const err =
          (body && typeof body === "object" && "error" in body
            ? String((body as Record<string, unknown>).error)
            : null) ?? `http_${res.status}`;
        setState({ phase: "error", error: err });
        return;
      }
      const b = (body ?? {}) as {
        ok?: boolean;
        summary?: string;
        result?: {
          email?: number;
          sms?: number;
          skipped?: number;
          failed?: number;
          error?: string;
        };
        error?: string;
      };
      if (b.ok === false) {
        // Handler-level refusal — shape matches the tool's output:
        // `{error, reason?, summary?}`. Prefer the summary if the
        // handler supplied one.
        const err =
          (b.result && typeof b.result.error === "string"
            ? b.result.error
            : null) ??
          (typeof b.error === "string" ? b.error : "send_failed");
        setState({ phase: "error", error: err });
        return;
      }
      const r = b.result ?? {};
      setState({
        phase: "sent",
        summary: typeof b.summary === "string" ? b.summary : "Send complete.",
        email: typeof r.email === "number" ? r.email : 0,
        sms: typeof r.sms === "number" ? r.sms : 0,
        skipped: typeof r.skipped === "number" ? r.skipped : 0,
        failed: typeof r.failed === "number" ? r.failed : 0,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "network_error";
      setState({ phase: "error", error: msg });
    }
  }
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
          <div className="text-slate-500">Messages ready</div>
          <div className="tabular-nums text-slate-900 font-medium">
            {props.ready_messages}
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

      {state.phase === "sent" ? (
        // Success morph. Button is gone — a second click is a
        // footgun (duplicates the send). The amber "destructive
        // ahead" framing is replaced with an emerald "done" chip
        // so the operator's eye registers the state change even
        // on a quick glance back through the scrollback.
        <div className="px-3 py-2 border-t border-emerald-200 bg-emerald-50 text-xs text-emerald-900 space-y-0.5">
          <div className="font-medium">Sent.</div>
          <div className="text-emerald-800">{state.summary}</div>
        </div>
      ) : (
        <div className="px-3 py-2 border-t border-amber-200 bg-amber-50 flex items-center justify-between gap-3">
          <div className="text-[11px] text-amber-800 min-w-0 flex-1">
            {state.phase === "error" ? (
              // Inline error leaves the button live so the operator
              // can retry. Show the raw error code — it maps to
              // handler outputs the operator's probably seen
              // elsewhere (status_not_sendable, send_in_flight,
              // etc.) and is actionable on its face.
              <span className="text-rose-700">
                Error: {state.error}. Try again or refresh the card.
              </span>
            ) : !hasAnchor ? (
              <span>
                Missing confirmation anchor — refresh to reload the card.
              </span>
            ) : hasBlockers ? (
              <span>Resolve blockers before confirming.</span>
            ) : (
              <span>
                Click Confirm to send. This action cannot be undone.
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              void onConfirm();
            }}
            disabled={!canConfirm && state.phase !== "error"}
            title={
              !hasAnchor
                ? "Missing confirmation anchor"
                : hasBlockers
                  ? "Resolve blockers before confirming"
                  : state.phase === "sending"
                    ? "Sending…"
                    : "Send now"
            }
            className={clsx(
              "rounded px-3 py-1.5 text-sm font-medium whitespace-nowrap",
              canConfirm
                ? "bg-amber-600 text-white hover:bg-amber-700"
                : state.phase === "error" && hasAnchor && !hasBlockers
                  ? "bg-amber-600 text-white hover:bg-amber-700"
                  : state.phase === "sending"
                    ? "bg-amber-200 text-amber-900 opacity-80 cursor-wait"
                    : "bg-slate-100 text-slate-400 cursor-not-allowed",
            )}
          >
            {state.phase === "sending"
              ? "Sending…"
              : state.phase === "error"
                ? "Retry"
                : `Send ${props.ready_messages} message${props.ready_messages === 1 ? "" : "s"}`}
          </button>
        </div>
      )}
    </div>
  );
}
