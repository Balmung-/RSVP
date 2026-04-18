import type { ReactNode } from "react";

// Shared form Field — label + control, one voice. Every admin form
// (campaign, contact, template, stage, invitee, team, user) used to
// carry its own local copy with slight label-class drift. This is
// the canonical shape. Label scale matches the app's `text-micro`
// token so fields read consistently next to pills, tiles, and the
// rest of the chrome.

export function Field({
  label,
  children,
  className = "",
  hint,
  error,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  hint?: string | null;
  error?: string | null;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-micro uppercase tracking-wider text-ink-400">
        {label}
      </span>
      {children}
      {error ? (
        <span className="text-mini text-signal-fail">{error}</span>
      ) : hint ? (
        <span className="text-mini text-ink-400">{hint}</span>
      ) : null}
    </label>
  );
}
