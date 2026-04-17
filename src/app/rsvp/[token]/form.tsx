"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import clsx from "clsx";
import { t, type Locale } from "@/lib/i18n";
import type { SubmitResult } from "@/lib/rsvp";

type QuestionView = {
  id: string;
  prompt: string;
  kind: string;
  required: boolean;
  options: string | null;
  showWhen: string;
};

type EventOptionView = {
  id: string;
  label: string | null;
  startsAt: string; // ISO
  venue: string | null;
};

type Props = {
  token: string;
  locale: Locale;
  guestsAllowed: number;
  action: (prev: SubmitResult | null, fd: FormData) => Promise<SubmitResult>;
  eventOptions: EventOptionView[];
  questions: QuestionView[];
  priorAttending: boolean | null;
  existing: {
    attending: boolean;
    guestsCount: number;
    message: string;
    eventOptionId: string | null;
    answers: Record<string, string>;
  } | null;
};

const ERROR_KEY: Record<
  Exclude<SubmitResult, { ok: true }>["reason"],
  "closed" | "deadline" | "rate_limited" | "invalid" | "answers_invalid"
> = {
  not_found: "invalid",
  closed: "closed",
  deadline: "deadline",
  rate_limited: "rate_limited",
  invalid: "invalid",
  answers_invalid: "answers_invalid",
};

export default function RsvpForm({
  token,
  locale,
  guestsAllowed,
  action,
  eventOptions,
  questions,
  priorAttending,
  existing,
}: Props) {
  const L = t(locale);
  const [state, formAction] = useFormState<SubmitResult | null, FormData>(action, null);
  const [attending, setAttending] = useState<boolean | null>(existing?.attending ?? priorAttending);
  const [guests, setGuests] = useState<number>(existing?.guestsCount ?? 0);
  const [eventOptionId, setEventOptionId] = useState<string | null>(existing?.eventOptionId ?? null);
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
          : errorReason === "answers_invalid"
            ? locale === "ar"
              ? "يرجى مراجعة الإجابات المطلوبة."
              : "Please review the required answers below."
            : null;
  const fieldErrors = state && !state.ok && state.reason === "answers_invalid" ? state.errors ?? {} : {};

  const applicableQuestions = questions.filter((q) => {
    if (q.showWhen === "always") return true;
    if (attending === null) return false;
    return q.showWhen === (attending ? "attending" : "declined");
  });

  return (
    <form className="mt-10 flex flex-col gap-6" action={formAction}>
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="attending" value={attending === null ? "" : attending ? "yes" : "no"} />
      <input type="hidden" name="guestsCount" value={guests} />
      <input type="hidden" name="eventOptionId" value={eventOptionId ?? ""} />

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

      {attending === true && eventOptions.length > 0 ? (
        <div className="border-t border-ink-100 pt-6">
          <div className="text-[11px] uppercase tracking-wider text-ink-400 mb-3">
            {locale === "ar" ? "اختر التاريخ" : "Pick a date"}
          </div>
          <div className="grid grid-cols-1 gap-2">
            {eventOptions.map((o) => {
              const sel = eventOptionId === o.id;
              const when = new Intl.DateTimeFormat(locale === "ar" ? "ar-SA" : "en-GB", {
                dateStyle: "long",
                timeStyle: "short",
              }).format(new Date(o.startsAt));
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => setEventOptionId(o.id)}
                  className={clsx(
                    "text-left border rounded-xl px-4 py-3 transition-colors",
                    sel
                      ? "border-ink-900 bg-ink-50 text-ink-900"
                      : "border-ink-200 text-ink-600 hover:border-ink-400 hover:text-ink-900",
                  )}
                  role="radio"
                  aria-checked={sel}
                >
                  <div className="text-sm font-medium tabular-nums">{when}</div>
                  {o.venue || o.label ? (
                    <div className="text-xs text-ink-400 mt-0.5">{[o.label, o.venue].filter(Boolean).join(" · ")}</div>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

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

      {applicableQuestions.length > 0 ? (
        <div className="border-t border-ink-100 pt-6 flex flex-col gap-5">
          {applicableQuestions.map((q) => (
            <QuestionField
              key={q.id}
              question={q}
              error={fieldErrors[q.id]}
              defaultValue={existing?.answers[q.id] ?? ""}
              locale={locale}
            />
          ))}
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

function QuestionField({
  question,
  error,
  defaultValue,
  locale,
}: {
  question: QuestionView;
  error?: string;
  defaultValue: string;
  locale: Locale;
}) {
  const options = (question.options ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const fieldName = `q_${question.id}`;
  const label = (
    <div className="text-[11px] uppercase tracking-wider text-ink-400">
      {question.prompt}
      {question.required ? <span className="text-signal-fail ms-1">*</span> : null}
    </div>
  );
  const errText = errorMessage(error, locale);
  const errEl = errText ? <p className="text-xs text-signal-fail mt-1">{errText}</p> : null;

  switch (question.kind) {
    case "short_text":
      return (
        <label className="flex flex-col gap-1.5">
          {label}
          <input
            name={fieldName}
            type="text"
            className="field"
            maxLength={300}
            required={question.required}
            defaultValue={defaultValue}
          />
          {errEl}
        </label>
      );
    case "long_text":
      return (
        <label className="flex flex-col gap-1.5">
          {label}
          <textarea
            name={fieldName}
            className="field"
            rows={3}
            maxLength={5000}
            required={question.required}
            defaultValue={defaultValue}
          />
          {errEl}
        </label>
      );
    case "number":
      return (
        <label className="flex flex-col gap-1.5">
          {label}
          <input
            name={fieldName}
            type="number"
            className="field"
            required={question.required}
            defaultValue={defaultValue}
          />
          {errEl}
        </label>
      );
    case "boolean":
      return (
        <div className="flex flex-col gap-1.5">
          {label}
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              name={fieldName}
              type="checkbox"
              value="true"
              className="accent-ink-900"
              defaultChecked={defaultValue === "true"}
            />
            <span>{locale === "ar" ? "نعم" : "Yes"}</span>
          </label>
          {errEl}
        </div>
      );
    case "single_select":
      return (
        <div className="flex flex-col gap-1.5">
          {label}
          <div className="flex flex-col gap-1.5">
            {options.map((o) => (
              <label key={o} className="flex items-center gap-2 text-sm text-ink-700">
                <input
                  type="radio"
                  name={fieldName}
                  value={o}
                  className="accent-ink-900"
                  required={question.required}
                  defaultChecked={defaultValue === o}
                />
                <span>{o}</span>
              </label>
            ))}
          </div>
          {errEl}
        </div>
      );
    case "multi_select": {
      const selected = new Set(defaultValue.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      return (
        <div className="flex flex-col gap-1.5">
          {label}
          <div className="flex flex-col gap-1.5">
            {options.map((o) => (
              <label key={o} className="flex items-center gap-2 text-sm text-ink-700">
                <input
                  type="checkbox"
                  name={fieldName}
                  value={o}
                  className="accent-ink-900"
                  defaultChecked={selected.has(o)}
                />
                <span>{o}</span>
              </label>
            ))}
          </div>
          {errEl}
        </div>
      );
    }
    default:
      return null;
  }
}

function errorMessage(code: string | undefined, locale: Locale): string | null {
  if (!code) return null;
  if (code === "required") return locale === "ar" ? "هذا الحقل مطلوب." : "Required.";
  if (code === "invalid_number") return locale === "ar" ? "رقم غير صالح." : "Enter a number.";
  if (code === "invalid_choice") return locale === "ar" ? "اختيار غير صالح." : "Pick a valid option.";
  return code;
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
