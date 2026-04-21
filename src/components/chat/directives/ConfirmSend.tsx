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

// Per-channel breakdown bucket. Extracted as a named type because
// the props now carry three (email / sms / whatsapp); duplicating
// the inline shape at every callsite got noisy.
type ChannelBucket = {
  ready: number;
  skipped_already_sent: number;
  skipped_unsubscribed: number;
  no_contact: number;
};

export type ConfirmSendProps = {
  campaign_id: string;
  name: string;
  status: string;
  venue: string | null;
  event_at: string | null;
  locale: string;
  // P13-D.2 — channel vocabulary widened. `"both"` preserves pre-P13
  // semantics (email + SMS only) — every legacy caller targeting
  // "both" has email+SMS-only expectations and cannot silently start
  // sending Meta-brokered messages. `"all"` is the new umbrella that
  // adds WhatsApp; scalars pick a single channel.
  channel: "email" | "sms" | "whatsapp" | "both" | "all";
  only_unsent: boolean;
  invitee_total: number;
  // Job count (one `(invitee, channel)` pair = one message), NOT a
  // recipient count. An invitee with email + phone on channel=all
  // contributes 3 here (email, sms, whatsapp), not 1. The copy below
  // reflects that — "Messages ready", not "Recipients ready" — so
  // the operator confirms the number of sends they're authorizing.
  ready_messages: number;
  by_channel: {
    email: ChannelBucket;
    sms: ChannelBucket;
    // P13-D.2 — WhatsApp bucket is populated identically to SMS (same
    // `phoneE164` contact field, shared `unsubPhones` set) but keyed
    // off `invitations.channel === "whatsapp"` for already-sent
    // detection. Required on every blob so the renderer never has to
    // branch on "is this a pre-P13 payload?".
    whatsapp: ChannelBucket;
  };
  template_preview: {
    subject_email: string | null;
    email_body: string | null;
    sms_body: string | null;
    // P13-D.2 — WhatsApp template identity. Meta identifies approved
    // templates by the (name, language) pair and the body lives on
    // their side, so the card shows the identity (not a body snippet)
    // when WhatsApp is configured. Null when either field is missing
    // (matches the `no_whatsapp_template` blocker predicate).
    whatsapp_template: { name: string; language: string } | null;
    // P17-C.5 — WhatsApp invitation PDF readiness. Populated when the
    // campaign is wired for the doc-header path (both template fields
    // AND a FileUpload id) AND that FileUpload row still exists. Null
    // otherwise — either because the campaign doesn't use the
    // doc-header path (no file expected) OR because the upload row was
    // deleted (in which case the `no_whatsapp_document` blocker is
    // already in the list, and hiding the readiness line keeps the
    // operator's eye on the blocker instead of half-rendering a
    // reassuring label). The filename is the one the operator uploaded
    // — Meta doesn't attach filename metadata to the message, but
    // showing it on the card lets the operator sanity-check the right
    // file is bound before clicking send.
    whatsapp_document: { filename: string } | null;
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
  // P13-D.2 — result gained `whatsapp: number` so the success morph
  // can report the per-channel tally for WA-bearing sends.
  result?: {
    email: number;
    sms: number;
    whatsapp: number;
    skipped: number;
    failed: number;
  };
  error?: string;
  summary?: string;
};

const BLOCKER_LABEL: Record<string, string> = {
  no_invitees: "No invitees on this campaign",
  no_ready_messages:
    "No messages are ready to send (every contact is already sent, unsubscribed, or missing on the chosen channel)",
  no_email_template: "Email template is empty",
  no_sms_template: "SMS template is empty",
  // P13-D.2 — WhatsApp configuration blockers. Both surface at the
  // ConfirmSend card so the operator fixes the config before the
  // server refuses mid-send. `no_whatsapp_template` fires when either
  // the template name OR the language is missing (Meta needs both as
  // an identity pair). `template_vars_malformed` fires when the
  // stored positional-var JSON fails to parse as a string array —
  // mirrors the planner's Rule 1 inner refusal.
  no_whatsapp_template:
    "WhatsApp template is not fully configured (both name and language are required)",
  template_vars_malformed:
    "WhatsApp template variables are not a valid JSON string array",
  // P17-C.5 — doc-header FK is dangling. Fires when the campaign has
  // a `whatsappDocumentUploadId` AND the WhatsApp template fields set
  // (per `campaignWantsWhatsAppDocument`) but the referenced FileUpload
  // row no longer exists. The operator's edit page has the re-upload
  // control; linking the operator to it from the chat card would close
  // the loop faster, but for now the actionable guidance is in the
  // copy below.
  no_whatsapp_document:
    "WhatsApp invitation PDF is missing or not a PDF. Re-upload a PDF on the campaign edit page before sending.",
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
      // P13-D.2 — additive counter. Always set (0 on two-channel
      // sends) so the success morph can read it unconditionally
      // without branching on channel.
      whatsapp: number;
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
      whatsapp: props.result.whatsapp,
      skipped: props.result.skipped,
      failed: props.result.failed,
    };
  }
  if (props.state === "error") {
    return { phase: "error", error: props.error ?? "unknown" };
  }
  return { phase: "idle" };
}

// Pure predicate for whether the confirm/retry button should accept a
// click. Exported so unit tests can cover the combinatorial matrix
// without standing up jsdom + a full React render.
//
// Two "live" regimes, both require anchor + no blockers:
//
//   1. Initial confirm: phase === "idle", plus at least one message
//      ready. Without `ready_messages > 0` the CTA would POST to a
//      send the server guarantees to refuse via `no_ready_messages`
//      — pointless round-trip.
//   2. Retry after refusal: phase === "error", no new blockers have
//      appeared, anchor is still valid. A persisted error (W5: the
//      server writes `state: "error"` onto the widget row) can come
//      back on reload with blockers present — that's the regression
//      GPT flagged on 3e95ce4. `retry` must NOT be clickable in that
//      case; the operator has to resolve the blocker or refresh the
//      preview first. Otherwise the retry POST enters the same
//      conditions that refused last time and is just noise.
//
// Everything else — sending (transient), sent (button hidden),
// idle + blockers / no anchor / no messages — is disabled.
export function isConfirmSendClickable(params: {
  phase: SendState["phase"];
  hasAnchor: boolean;
  hasBlockers: boolean;
  readyMessages: number;
}): boolean {
  if (
    params.phase === "idle" &&
    params.hasAnchor &&
    !params.hasBlockers &&
    params.readyMessages > 0
  ) {
    return true;
  }
  if (
    params.phase === "error" &&
    params.hasAnchor &&
    !params.hasBlockers
  ) {
    return true;
  }
  return false;
}

export function ConfirmSend({
  props,
  fmt,
  messageId,
  onConfirmedOutcome,
}: {
  props: ConfirmSendProps;
  fmt: FormatContext;
  messageId?: string;
  onConfirmedOutcome?: (outcome: {
    summary: string;
    isError: boolean;
  }) => void;
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
  }, [
    props.state,
    props.error,
    props.summary,
    props.result?.email,
    props.result?.sms,
    // P13-D.2 — track `whatsapp` so a WA-bearing terminal upsert
    // triggers a re-derive. Without this the morph could miss the
    // counter on reload when only the WA value changed between two
    // server-side outcome writes (rare, but possible if the webhook
    // reconciles partial delivery after the initial response).
    props.result?.whatsapp,
    props.result?.skipped,
    props.result?.failed,
  ]);
  const when = formatEventAt(props.event_at, fmt);
  const hasBlockers = props.blockers.length > 0;
  // `hasAnchor` gates the POST — without a messageId the confirm
  // route has no authorization anchor and the button has nowhere to
  // go. See the file-top wiring comment.
  const hasAnchor = typeof messageId === "string" && messageId.length > 0;
  // Single source of truth for "should this button accept a click?".
  // Used for BOTH disabled + style below so the two can't drift —
  // GPT flagged a pre-helper version where the disabled predicate
  // treated any `phase === "error"` as clickable but the style
  // branch gated retry on `hasAnchor && !hasBlockers`. A persisted
  // `state: "error"` widget could come back on reload with blockers
  // present and the button would still POST.
  const clickable = isConfirmSendClickable({
    phase: state.phase,
    hasAnchor,
    hasBlockers,
    readyMessages: props.ready_messages,
  });
  // P13-D.2 — channelLabel expanded for the full vocabulary. `"both"`
  // stays "email + SMS" (the pre-P13 display); `"all"` becomes
  // "email + SMS + WhatsApp"; scalars display the channel name
  // verbatim with "WhatsApp" expanded from `"whatsapp"` for
  // readability.
  const channelLabel = (() => {
    switch (props.channel) {
      case "both":
        return "email + SMS";
      case "all":
        return "email + SMS + WhatsApp";
      case "whatsapp":
        return "WhatsApp";
      default:
        return props.channel;
    }
  })();

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
        if (
          body &&
          typeof body === "object" &&
          typeof (body as Record<string, unknown>).summary === "string"
        ) {
          onConfirmedOutcome?.({
            summary: (body as Record<string, unknown>).summary as string,
            isError: true,
          });
        }
        return;
      }
      const b = (body ?? {}) as {
        ok?: boolean;
        summary?: string;
        result?: {
          email?: number;
          sms?: number;
          // P13-D.2 — `whatsapp` is additive; present on every
          // post-P13 send_campaign response (0 on two-channel sends).
          // Declared here so the `r.whatsapp` read below typechecks
          // without a cast — `unknown` would force every downstream
          // guard to pay the narrowing tax.
          whatsapp?: number;
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
        if (typeof b.summary === "string") {
          onConfirmedOutcome?.({ summary: b.summary, isError: true });
        }
        return;
      }
      const r = b.result ?? {};
      setState({
        phase: "sent",
        summary: typeof b.summary === "string" ? b.summary : "Send complete.",
        email: typeof r.email === "number" ? r.email : 0,
        sms: typeof r.sms === "number" ? r.sms : 0,
        // P13-D.2 — read `whatsapp` defensively (0 when absent) so a
        // pre-P13 transcript replay or a handler response from before
        // the widening still lands in a valid SendState shape.
        whatsapp: typeof r.whatsapp === "number" ? r.whatsapp : 0,
        skipped: typeof r.skipped === "number" ? r.skipped : 0,
        failed: typeof r.failed === "number" ? r.failed : 0,
      });
      if (typeof b.summary === "string") {
        onConfirmedOutcome?.({ summary: b.summary, isError: false });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "network_error";
      setState({ phase: "error", error: msg });
    }
  }
  // P13-D.2 — totals aggregate across all three buckets so the stats
  // strip always reflects the whole preview regardless of channel
  // selection. The whatsapp bucket is `{0,0,0,0}` when WhatsApp isn't
  // part of the resolved channel set (scalar `email`/`sms`, or `both`
  // which is email+SMS-only), so adding it unconditionally is safe
  // and saves the render from branching on `channel`.
  const skippedTotal =
    props.by_channel.email.skipped_already_sent +
    props.by_channel.sms.skipped_already_sent +
    props.by_channel.whatsapp.skipped_already_sent;
  const unsubTotal =
    props.by_channel.email.skipped_unsubscribed +
    props.by_channel.sms.skipped_unsubscribed +
    props.by_channel.whatsapp.skipped_unsubscribed;
  const noContactTotal =
    props.by_channel.email.no_contact +
    props.by_channel.sms.no_contact +
    props.by_channel.whatsapp.no_contact;

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
            {/* P13-D.2 — breakdown hint only appears on multi-channel
                selections where the total alone hides the per-channel
                split. `both` stays email+SMS (pre-P13 semantics); `all`
                adds WhatsApp. Scalar channels (`email`/`sms`/`whatsapp`)
                don't need the hint — the total IS the single-channel
                count. */}
            {props.channel === "both" && (
              <span className="text-slate-400 font-normal">
                {" "}
                ({props.by_channel.email.ready}e / {props.by_channel.sms.ready}s)
              </span>
            )}
            {props.channel === "all" && (
              <span className="text-slate-400 font-normal">
                {" "}
                ({props.by_channel.email.ready}e / {props.by_channel.sms.ready}s / {props.by_channel.whatsapp.ready}w)
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
        props.template_preview.sms_body ||
        props.template_preview.whatsapp_template ||
        props.template_preview.whatsapp_document) && (
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
          {/* P13-D.2 — WhatsApp template identity. The body lives on
              Meta's side (operator-approved BSP template) so the card
              shows `(name, language)` as the identity pair the operator
              approved. Rendered as its own row rather than folded into
              the SMS line because the two are different artifacts —
              mixing them would suggest a shared body. */}
          {props.template_preview.whatsapp_template && (
            <div className="text-slate-600">
              <span className="text-slate-500">WhatsApp template: </span>
              <span className="text-slate-900 font-mono">
                {props.template_preview.whatsapp_template.name}
              </span>
              <span className="text-slate-400">
                {" "}
                ({props.template_preview.whatsapp_template.language})
              </span>
            </div>
          )}
          {/* P17-C.5 — WhatsApp PDF readiness line. Rendered as a
              dedicated row immediately under the template identity
              because the PDF is an attachment on THAT template (not an
              alternative artifact). The filename is rendered in the
              slate tone rather than font-mono — it's a user-facing
              filename (operator-chosen), not an identifier. */}
          {props.template_preview.whatsapp_document && (
            <div className="text-slate-600">
              <span className="text-slate-500">Will attach PDF: </span>
              <span className="text-slate-900">
                {props.template_preview.whatsapp_document.filename}
              </span>
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
            disabled={!clickable}
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
              clickable
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
