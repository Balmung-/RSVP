// One number, one label. No card chrome; the row itself is the grouping.
export function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wider text-ink-400">{label}</span>
      <span className="text-2xl font-medium tracking-tightest tabular-nums text-ink-900">{value}</span>
      {hint ? <span className="text-xs text-ink-400">{hint}</span> : null}
    </div>
  );
}
