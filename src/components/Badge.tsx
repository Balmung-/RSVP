import clsx from "clsx";

const tone = {
  live: "bg-signal-live/10 text-signal-live",
  wait: "bg-ink-100 text-ink-500",
  fail: "bg-signal-fail/10 text-signal-fail",
  hold: "bg-signal-hold/10 text-signal-hold",
  muted: "bg-ink-100 text-ink-500",
} as const;

export function Badge({
  children,
  tone: t = "muted",
}: {
  children: React.ReactNode;
  tone?: keyof typeof tone;
}) {
  return (
    <span className={clsx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium", tone[t])}>
      <span className={clsx("dot", {
        "bg-signal-live": t === "live",
        "bg-ink-400": t === "wait" || t === "muted",
        "bg-signal-fail": t === "fail",
        "bg-signal-hold": t === "hold",
      })} />
      {children}
    </span>
  );
}
