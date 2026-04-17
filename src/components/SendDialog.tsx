"use client";

import { useState, useTransition } from "react";
import clsx from "clsx";
import { Modal } from "./Modal";
import { Icon } from "./Icon";

type Summary = {
  invited: number;
  withEmail: number;
  withPhone: number;
  alreadyEmailSent: number;
  alreadySmsSent: number;
};

// The pre-send safety net. One button flow:
// 1. "Send invitations" button opens the modal.
// 2. Modal shows recipient summary + channel pick.
// 3. User confirms → server action fires.

export function SendDialog({
  campaignId,
  summary,
  status,
  action,
  canWrite,
}: {
  campaignId: string;
  summary: Summary;
  status: string;
  action: (fd: FormData) => Promise<void>;
  canWrite: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<"both" | "email" | "sms">("both");
  const [pending, start] = useTransition();
  const isSending = status === "sending" || pending;

  if (!canWrite) return null;

  const toEmail = summary.withEmail - (channel === "sms" ? summary.withEmail : summary.alreadyEmailSent);
  const toSms = summary.withPhone - (channel === "email" ? summary.withPhone : summary.alreadySmsSent);
  const emailCount = channel === "sms" ? 0 : Math.max(0, summary.withEmail - summary.alreadyEmailSent);
  const smsCount = channel === "email" ? 0 : Math.max(0, summary.withPhone - summary.alreadySmsSent);
  const total = emailCount + smsCount;

  return (
    <>
      <button
        type="button"
        className="btn btn-primary"
        disabled={isSending || summary.invited === 0}
        onClick={() => setOpen(true)}
      >
        <Icon name="send" size={14} />
        {isSending ? "Sending…" : "Send invitations"}
      </button>

      <Modal
        open={open}
        onClose={() => (pending ? undefined : setOpen(false))}
        title="Send invitations"
        description="Invitations go out immediately after you confirm. Only invitees who haven't already received this channel are included."
        size="md"
        footer={
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
                fd.set("channel", channel);
                start(async () => {
                  await action(fd);
                  setOpen(false);
                });
              }}
            >
              <button
                className="btn btn-primary"
                disabled={pending || total === 0}
                type="submit"
              >
                {pending ? (
                  <>
                    <Icon name="spinner" size={14} className="animate-spin" />
                    Sending…
                  </>
                ) : (
                  <>Send to {total.toLocaleString()}</>
                )}
              </button>
            </form>
          </>
        }
      >
        <div className="space-y-5">
          <fieldset>
            <legend className="text-micro text-ink-400 uppercase mb-2">Channel</legend>
            <div className="grid grid-cols-3 gap-2">
              {(["both", "email", "sms"] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setChannel(c)}
                  className={clsx(
                    "rounded-lg border px-3 py-2 text-body transition-colors",
                    channel === c
                      ? "border-ink-900 bg-ink-50 text-ink-900"
                      : "border-ink-200 text-ink-600 hover:border-ink-400",
                  )}
                >
                  {c === "both" ? "Email & SMS" : c === "email" ? "Email only" : "SMS only"}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="rounded-xl border border-ink-100 divide-y divide-ink-100">
            <Row label="Invitees in campaign" value={summary.invited.toLocaleString()} />
            {channel !== "sms" ? (
              <Row
                label="Will receive email"
                value={emailCount.toLocaleString()}
                hint={
                  summary.alreadyEmailSent > 0
                    ? `${summary.alreadyEmailSent.toLocaleString()} already received — skipped`
                    : undefined
                }
              />
            ) : null}
            {channel !== "email" ? (
              <Row
                label="Will receive SMS"
                value={smsCount.toLocaleString()}
                hint={
                  summary.alreadySmsSent > 0
                    ? `${summary.alreadySmsSent.toLocaleString()} already received — skipped`
                    : undefined
                }
              />
            ) : null}
            <Row label="Total messages" value={total.toLocaleString()} emphasize />
          </div>

          {total === 0 ? (
            <p className="text-body text-signal-hold flex items-start gap-2">
              <Icon name="circle-alert" size={14} className="mt-0.5" />
              <span>Nothing to send on this channel — everyone has already received it.</span>
            </p>
          ) : null}
        </div>
      </Modal>
    </>
  );
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
        <div className={clsx("text-body", emphasize ? "text-ink-900 font-medium" : "text-ink-700")}>
          {label}
        </div>
        {hint ? <div className="text-mini text-ink-500 mt-0.5">{hint}</div> : null}
      </div>
      <div className={clsx("tabular-nums", emphasize ? "text-ink-900 font-medium" : "text-ink-700")}>
        {value}
      </div>
    </div>
  );
}
