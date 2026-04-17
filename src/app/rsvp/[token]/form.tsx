"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import clsx from "clsx";
import { t, type Locale } from "@/lib/i18n";
import type { SubmitResult } from "@/lib/rsvp";

type Props = {
  token: string;
  locale: Locale;
  guestsAllowed: number;
  action: (prev: SubmitResult | null, fd: FormData) => Promise<SubmitResult>;
  existing: { attending: boolean; guestsCount: number; message: string } | null;
};

const ERROR_KEY: Record<
  Exclude<SubmitResult, { ok: true }>["reason"],
  "closed" | "deadline" | "rate_limited" | "invalid"
> = {
  not_found: "invalid",
  closed: "closed",
  deadline: "deadline",
  rate_limited: "rate_limited",
  invalid: "invalid",
};

export default function RsvpForm({ token, locale, guestsAllowed, action, existing }: Props) {
  const L = t(locale);
  const [state, formAction] = useFormState<SubmitResult | null, FormData>(action, null);
  const [attending, setAttending] = useState<boolean | null>(existing?.attending ?? null);
  const [guests, setGuests] = useState<number>(existing?.guestsCount ?? 0);
  const [editing, setEditing] = useState<boolean>(!existing);

  const successful = state?.ok === true;
  const showDone = successful || (existing && !editing);

  if (showDone) {
    return (
      <div className="mt-10 text-center" role="status" aria-live="polite">
        <div className="inline-flex items-center gap-2 text-signal-live text-sm">
          <span className="dot bg-signal-live" />
          <span>{L.rsvp.thankYou}</span>
        </div>
        <p className="text-sm text-ink-500 mt-2">{L.rsvp.received}</p>
        <button
          onClick={() => setEditing(true)}
          className="mt-6 text-xs text-ink-400 hover:text-ink-900 underline-offset-4 hover:underline"
          type="button"
        >
          {L.rsvp.update}
        </button>
      </div>
    );
  }

  const errorReason = state && !state.ok ? ERROR_KEY[state.reason] : null;
  const errorText =
    errorReason === "closed" || errorReason === "deadline"
      ? L.rsvp.closed
      : errorReason === "rate_limited"
        ? locale === "ar"
          ? "محاولات كثيرة. يرجى المحاولة بعد قليل."
          : "Too many attempts. Please try again in a moment."
        : errorReason === "invalid"
          ? locale === "ar"
            ? "رابط غير صالح."
            : "This invitation link is not valid."
          : null;

  return (
    <form className="mt-10 flex flex-col gap-6" action={formAction}>
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="attending" value={attending === null ? "" : attending ? "yes" : "no"} />
      <input type="hidden" name="guestsCount" value={guests} />

      <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label={L.rsvp.title}>
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
          <label className="text-sm text-ink-700" id="guests-label">
            {L.rsvp.guests}
          </label>
          <div className="inline-flex items-center gap-3" aria-labelledby="guests-label">
            <button
              type="button"
              onClick={() => setGuests((g) => Math.max(0, g - 1))}
              className="h-8 w-8 rounded-full border border-ink-200 text-ink-600 hover:border-ink-900 hover:text-ink-900 transition-colors"
              aria-label={locale === "ar" ? "إنقاص عدد المرافقين" : "Decrease guests"}
            >
              −
            </button>
            <span className="w-8 text-center tabular-nums font-medium" aria-live="polite">{guests}</span>
            <button
              type="button"
              onClick={() => setGuests((g) => Math.min(guestsAllowed, g + 1))}
              className="h-8 w-8 rounded-full border border-ink-200 text-ink-600 hover:border-ink-900 hover:text-ink-900 transition-colors"
              aria-label={locale === "ar" ? "زيادة عدد المرافقين" : "Increase guests"}
            >
              +
            </button>
            <span className="text-xs text-ink-400">/ {guestsAllowed}</span>
          </div>
        </div>
      ) : null}

      <label className="contents">
        <span className="sr-only">{L.rsvp.message}</span>
        <textarea
          name="message"
          rows={3}
          placeholder={L.rsvp.message}
          defaultValue={existing?.message ?? ""}
          maxLength={2000}
          className="field resize-none"
        />
      </label>

      {errorText ? (
        <p role="alert" className="text-sm text-signal-fail text-center">
          {errorText}
        </p>
      ) : null}

      <SubmitButton disabled={attending === null} label={L.rsvp.submit} />
    </form>
  );
}

function SubmitButton({ disabled, label }: { disabled: boolean; label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      disabled={disabled || pending}
      className={clsx("btn-primary w-full py-3 transition-opacity", {
        "opacity-40 cursor-not-allowed": disabled || pending,
      })}
    >
      {pending ? "…" : label}
    </button>
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
      role="radio"
      aria-checked={selected}
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
