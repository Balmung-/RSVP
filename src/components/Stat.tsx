import Link from "next/link";
import type { ReactNode } from "react";

// Two shapes for two reading contexts.
//
// Stat — stacked column: label on top, number below. For panels
// where the stats are a grid (catering, invitees tab, arrivals
// board). Density is the label's job, not the container.
//
// InlineStat — horizontal: number + label on one baseline,
// optional dot for tone, optional link. Used by the dashboard's
// top reading strip, /deliverability and /unsubscribes. One voice
// across every page that shows numbers inline.

export function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-micro uppercase tracking-wider text-ink-400">{label}</span>
      <span
        className="tabular-nums text-ink-900"
        style={{ fontSize: "24px", lineHeight: "28px", letterSpacing: "-0.015em", fontWeight: 500 }}
      >
        {value}
      </span>
      {hint ? <span className="text-mini text-ink-400">{hint}</span> : null}
    </div>
  );
}

export function InlineStat({
  label,
  value,
  tone,
  hint,
  href,
}: {
  label: string;
  value: number;
  tone?: "hold" | "fail";
  hint?: string;
  href?: string;
}) {
  const dot =
    tone === "hold"
      ? "bg-signal-hold animate-pulse"
      : tone === "fail"
        ? "bg-signal-fail"
        : null;
  const body = (
    <span className="inline-flex items-baseline gap-2">
      {dot ? (
        <span
          className={`h-1.5 w-1.5 rounded-full translate-y-[-3px] ${dot}`}
          aria-hidden
        />
      ) : null}
      <span
        className="text-ink-900 tabular-nums"
        style={{ fontSize: "24px", lineHeight: "28px", letterSpacing: "-0.015em", fontWeight: 500 }}
      >
        {value.toLocaleString()}
      </span>
      <span className="text-micro uppercase tracking-wider text-ink-400">{label}</span>
      {hint ? <span className="text-mini text-ink-400">· {hint}</span> : null}
    </span>
  );
  if (href) {
    return (
      <Link href={href} className="text-ink-900 hover:text-ink-700 transition-colors">
        {body}
      </Link>
    );
  }
  return body as ReactNode;
}
