"use client";

import { useState, useTransition } from "react";
import clsx from "clsx";
import { t, type Locale } from "@/lib/i18n";

type Props = {
  token: string;
  locale: Locale;
  guestsAllowed: number;
  action: (formData: FormData) => Promise<void>;
  existing: { attending: boolean; guestsCount: number; message: string } | null;
};

export default function RsvpForm({ token, locale, guestsAllowed, action, existing }: Props) {
  const L = t(locale);
  const [attending, setAttending] = useState<boolean | null>(existing?.attending ?? null);
  const [guests, setGuests] = useState<number>(existing?.guestsCount ?? 0);
  const [submitted, setSubmitted] = useState(!!existing);
  const [pending, start] = useTransition();

  if (submitted && !pending) {
    return (
      <div className="mt-10 text-center">
        <div className="inline-flex items-center gap-2 text-signal-live text-sm">
          <span className="dot bg-signal-live" />
          <span>{L.rsvp.thankYou}</span>
        </div>
        <p className="text-sm text-ink-500 mt-2">{L.rsvp.received}</p>
        <button
          onClick={() => setSubmitted(false)}
          className="mt-6 text-xs text-ink-400 hover:text-ink-900 underline-offset-4 hover:underline"
          type="button"
        >
          {L.rsvp.update}
        </button>
      </div>
    );
  }

  return (
    <form
      className="mt-10 flex flex-col gap-6"
      action={(fd) =>
        start(async () => {
          fd.set("attending", attending ? "yes" : "no");
          fd.set("guestsCount", String(guests));
          await action(fd);
          setSubmitted(true);
        })
      }
    >
      <input type="hidden" name="token" value={token} />

      <div className="grid grid-cols-2 gap-3">
        <Choice
          selected={attending === true}
          onClick={() => setAttending(true)}
          label={L.rsvp.willAttend}
          tone="live"
        />
        <Choice
          selected={attending === false}
          onClick={() => setAttending(false)}
          label={L.rsvp.wontAttend}
          tone="muted"
        />
      </div>

      {attending === true && guestsAllowed > 0 ? (
        <div className="flex items-center justify-between border-t border-ink-100 pt-6">
          <label className="text-sm text-ink-700">{L.rsvp.guests}</label>
          <div className="inline-flex items-center gap-3">
            <button
              type="button"
              onClick={() => setGuests((g) => Math.max(0, g - 1))}
              className="h-8 w-8 rounded-full border border-ink-200 text-ink-600 hover:border-ink-900 hover:text-ink-900 transition-colors"
              aria-label="-"
            >
              −
            </button>
            <span className="w-8 text-center tabular-nums font-medium">{guests}</span>
            <button
              type="button"
              onClick={() => setGuests((g) => Math.min(guestsAllowed, g + 1))}
              className="h-8 w-8 rounded-full border border-ink-200 text-ink-600 hover:border-ink-900 hover:text-ink-900 transition-colors"
              aria-label="+"
            >
              +
            </button>
            <span className="text-xs text-ink-400">/ {guestsAllowed}</span>
          </div>
        </div>
      ) : null}

      <textarea
        name="message"
        rows={3}
        placeholder={L.rsvp.message}
        defaultValue={existing?.message ?? ""}
        className="field resize-none"
      />

      <button
        disabled={attending === null || pending}
        className={clsx("btn-primary w-full py-3 transition-opacity", {
          "opacity-40 cursor-not-allowed": attending === null || pending,
        })}
      >
        {pending ? "…" : L.rsvp.submit}
      </button>
    </form>
  );
}

function Choice({
  selected,
  onClick,
  label,
  tone,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  tone: "live" | "muted";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "rounded-xl border px-4 py-4 text-sm font-medium transition-all duration-200 ease-glide",
        selected
          ? tone === "live"
            ? "border-signal-live bg-signal-live/5 text-signal-live"
            : "border-ink-900 bg-ink-50 text-ink-900"
          : "border-ink-200 text-ink-600 hover:border-ink-400 hover:text-ink-900",
      )}
    >
      {label}
    </button>
  );
}
