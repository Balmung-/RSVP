"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import clsx from "clsx";
import { Modal } from "./Modal";
import { Icon } from "./Icon";
import type { ChannelReadiness } from "@/lib/channel-readiness";

type Summary = {
  invited: number;
  withEmail: number;
  withSms: number;
  withWhatsApp: number;
  alreadyEmailSent: number;
  alreadySmsSent: number;
  alreadyWhatsAppSent: number;
};

type UiChannel = "all" | "email" | "sms" | "whatsapp";
type SubmitChannel = "all" | "both" | "email" | "sms" | "whatsapp";

export function SendDialog({
  campaignId,
  summary,
  status,
  action,
  canWrite,
  setup,
  editHref,
}: {
  campaignId: string;
  summary: Summary;
  status: string;
  action: (fd: FormData) => Promise<void>;
  canWrite: boolean;
  setup: ChannelReadiness[];
  editHref: string;
}) {
  const options = useMemo(() => buildOptions(summary), [summary]);
  const hasSendableOptions = options.length > 0;
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<UiChannel>(options[0]?.value ?? "all");
  const [pending, start] = useTransition();
  const isSending = status === "sending" || pending;

  if (!canWrite) return null;

  const selected = countBySelection(channel, summary);
  const total = selected.email + selected.sms + selected.whatsapp;

  return (
    <>
      <button
        type="button"
        className="btn btn-primary"
        disabled={isSending || summary.invited === 0}
        onClick={() => {
          setChannel((current) => (options.some((option) => option.value === current) ? current : options[0].value));
          setOpen(true);
        }}
      >
        <Icon name="send" size={14} />
        {isSending ? "Sending..." : hasSendableOptions ? "Send invitations" : "Fix message setup"}
      </button>

      <Modal
        open={open}
        onClose={() => (pending ? undefined : setOpen(false))}
        title="Send invitations"
        description={
          hasSendableOptions
            ? "Invitations go out immediately after you confirm. Only channels that are actually configured for this campaign are shown."
            : "Nothing is sendable yet. Fix the campaign setup below, then return here to send."
        }
        size="md"
        footer={
          hasSendableOptions ? (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={pending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
              <form
                action={(fd) => {
                  fd.set("id", campaignId);
                  fd.set("channel", toSubmitChannel(channel, summary));
                  start(async () => {
                    await action(fd);
                    setOpen(false);
                  });
                }}
              >
                <button className="btn btn-primary" disabled={pending || total === 0} type="submit">
                  {pending ? (
                    <>
                      <Icon name="spinner" size={14} className="animate-spin" />
                      Sending...
                    </>
                  ) : (
                    <>Send to {total.toLocaleString()}</>
                  )}
                </button>
              </form>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setOpen(false)}
              >
                Close
              </button>
              <Link href={editHref} className="btn btn-primary">
                Edit message setup
              </Link>
            </>
          )
        }
      >
        {hasSendableOptions ? (
          <div className="space-y-5">
            <fieldset>
              <legend className="mb-2 text-micro uppercase text-ink-400">Channel</legend>
              <div className={clsx("grid gap-2", options.length >= 4 ? "grid-cols-2" : options.length === 3 ? "grid-cols-3" : options.length === 2 ? "grid-cols-2" : "grid-cols-1")}>
                {options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setChannel(option.value)}
                    className={clsx(
                      "rounded-lg border px-3 py-2 text-body transition-colors",
                      channel === option.value
                        ? "border-ink-900 bg-ink-50 text-ink-900"
                        : "border-ink-200 text-ink-600 hover:border-ink-400",
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="divide-y divide-ink-100 rounded-xl border border-ink-100">
              <Row label="Invitees in campaign" value={summary.invited.toLocaleString()} />
              {summary.withEmail > 0 && (selected.email > 0 || channel === "email" || channel === "all") ? (
                <Row
                  label="Will receive email"
                  value={selected.email.toLocaleString()}
                  hint={
                    summary.alreadyEmailSent > 0
                      ? `${summary.alreadyEmailSent.toLocaleString()} already received - skipped`
                      : undefined
                  }
                />
              ) : null}
              {summary.withSms > 0 && (selected.sms > 0 || channel === "sms" || channel === "all") ? (
                <Row
                  label="Will receive SMS"
                  value={selected.sms.toLocaleString()}
                  hint={
                    summary.alreadySmsSent > 0
                      ? `${summary.alreadySmsSent.toLocaleString()} already received - skipped`
                      : undefined
                  }
                />
              ) : null}
              {summary.withWhatsApp > 0 && (selected.whatsapp > 0 || channel === "whatsapp" || channel === "all") ? (
                <Row
                  label="Will receive WhatsApp"
                  value={selected.whatsapp.toLocaleString()}
                  hint={
                    summary.alreadyWhatsAppSent > 0
                      ? `${summary.alreadyWhatsAppSent.toLocaleString()} already received - skipped`
                      : undefined
                  }
                />
              ) : null}
              <Row label="Total messages" value={total.toLocaleString()} emphasize />
            </div>

            {total === 0 ? (
              <p className="flex items-start gap-2 text-body text-signal-hold">
                <Icon name="circle-alert" size={14} className="mt-0.5" />
                <span>Nothing to send on the selected channel.</span>
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-xl border border-ink-100">
              {setup.map((channel) => (
                <div
                  key={channel.channel}
                  className="flex items-start justify-between gap-3 border-b border-ink-100 px-4 py-3 last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="text-body text-ink-900">{channel.label}</div>
                    <div className="mt-0.5 text-body text-ink-600">{channel.reason}</div>
                    {channel.detail ? (
                      <div className="mt-0.5 text-mini text-ink-500">{channel.detail}</div>
                    ) : null}
                  </div>
                  <span
                    className={clsx(
                      "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
                      channel.ready ? "bg-signal-live/10 text-signal-live" : "bg-signal-hold/10 text-signal-hold",
                    )}
                  >
                    <span
                      className={clsx("dot", {
                        "bg-signal-live": channel.ready,
                        "bg-signal-hold": !channel.ready,
                      })}
                    />
                    {channel.ready ? "ready" : "setup needed"}
                  </span>
                </div>
              ))}
            </div>
            <p className="text-mini text-ink-500">
              Set up at least one channel before sending. Replies and delivery history stay on the invitee list and activity log.
            </p>
          </div>
        )}
      </Modal>
    </>
  );
}

function buildOptions(summary: Summary): Array<{ value: UiChannel; label: string }> {
  const options: Array<{ value: UiChannel; label: string }> = [];
  const hasEmail = summary.withEmail > 0;
  const hasSms = summary.withSms > 0;
  const hasWhatsApp = summary.withWhatsApp > 0;

  if (hasEmail && hasSms && hasWhatsApp) {
    options.push({ value: "all", label: "All available" });
  } else if (hasEmail && hasSms) {
    options.push({ value: "all", label: "Email + SMS" });
  }
  if (hasEmail) options.push({ value: "email", label: "Email" });
  if (hasSms) options.push({ value: "sms", label: "SMS" });
  if (hasWhatsApp) options.push({ value: "whatsapp", label: "WhatsApp" });

  return options;
}

function countBySelection(channel: UiChannel, summary: Summary) {
  const selectAllMeans = toSubmitChannel("all", summary);
  const include = {
    email: channel === "email" || (channel === "all" && (selectAllMeans === "both" || selectAllMeans === "all")),
    sms: channel === "sms" || (channel === "all" && (selectAllMeans === "both" || selectAllMeans === "all")),
    whatsapp: channel === "whatsapp" || (channel === "all" && selectAllMeans === "all"),
  };

  return {
    email: include.email ? Math.max(0, summary.withEmail - summary.alreadyEmailSent) : 0,
    sms: include.sms ? Math.max(0, summary.withSms - summary.alreadySmsSent) : 0,
    whatsapp: include.whatsapp ? Math.max(0, summary.withWhatsApp - summary.alreadyWhatsAppSent) : 0,
  };
}

function toSubmitChannel(channel: UiChannel, summary: Summary): SubmitChannel {
  if (channel === "email" || channel === "sms" || channel === "whatsapp") return channel;
  if (summary.withEmail > 0 && summary.withSms > 0 && summary.withWhatsApp > 0) return "all";
  if (summary.withEmail > 0 && summary.withSms > 0) return "both";
  if (summary.withEmail > 0) return "email";
  if (summary.withSms > 0) return "sms";
  return "whatsapp";
}

function Row({
  label,
  value,
  hint,
  emphasize,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasize?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <div>
        <div className={clsx("text-body", emphasize ? "font-medium text-ink-900" : "text-ink-700")}>
          {label}
        </div>
        {hint ? <div className="mt-0.5 text-mini text-ink-500">{hint}</div> : null}
      </div>
      <div className={clsx("tabular-nums", emphasize ? "font-medium text-ink-900" : "text-ink-700")}>
        {value}
      </div>
    </div>
  );
}
