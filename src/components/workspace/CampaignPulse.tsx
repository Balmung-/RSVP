import type { PulseBucket } from "@/lib/pulse";

// Thin sparkline of daily RSVP response volume. Inline SVG so there's
// no client library, no hydration cost — the chart is a server-
// rendered artifact. Reads horizontally across the page width, matches
// the shell's other calm surfaces, only asserts itself when something
// is actually happening.

export function CampaignPulse({
  buckets,
  totalAttending,
  totalDeclined,
}: {
  buckets: PulseBucket[];
  totalAttending: number;
  totalDeclined: number;
}) {
  if (buckets.length === 0) return null;
  const peak = buckets.reduce(
    (m, b) => Math.max(m, b.attending + b.declined),
    0,
  );
  // Hide the chart when every day is zero — the directive calls for
  // "rare, sharp signal." A flat line of invisible bars is noise.
  if (peak === 0) return null;

  const width = 480;
  const height = 36;
  const slot = width / buckets.length;
  const barW = Math.max(2, Math.floor(slot * 0.7));

  return (
    <div className="flex items-end gap-4 max-w-[640px]">
      <div className="min-w-0 flex-1">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          height={height}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Daily RSVP pulse · ${totalAttending} attending, ${totalDeclined} declined over the last ${buckets.length} days`}
        >
          {buckets.map((b, i) => {
            const total = b.attending + b.declined;
            if (total === 0) return null;
            const h = (total / peak) * (height - 2);
            const aH = (b.attending / peak) * (height - 2);
            const x = Math.floor(i * slot);
            return (
              <g key={b.dayKey}>
                <title>{`${b.dayKey}: ${b.attending} attending · ${b.declined} declined`}</title>
                <rect
                  x={x}
                  y={height - h}
                  width={barW}
                  height={h - aH}
                  className="fill-ink-200"
                />
                <rect
                  x={x}
                  y={height - aH}
                  width={barW}
                  height={aH}
                  className="fill-ink-900"
                />
              </g>
            );
          })}
        </svg>
      </div>
      <div className="text-mini text-ink-500 tabular-nums shrink-0 leading-tight text-end">
        <div>
          <span className="text-ink-900 font-medium">{totalAttending.toLocaleString()}</span> yes
        </div>
        <div className="text-ink-400">
          {totalDeclined.toLocaleString()} no · {buckets.length}d
        </div>
      </div>
    </div>
  );
}
