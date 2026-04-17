"use client";

import { useEffect, useRef, useState } from "react";

// Door-kiosk display. Chromeless, ETag-polled, latest arrivals big and
// legible from a few meters out. Chimes a subtle tone on each new arrival
// so the greeter at the door hears confirmation even if their eyes are
// elsewhere.

type Feed = {
  version: string;
  totals: {
    expected: number;
    arrived: number;
    pending: number;
    expectedGuests: number;
    arrivedGuests: number;
  };
  rows: Array<{
    id: string;
    name: string;
    title: string | null;
    organization: string | null;
    token: string;
    guestsCount: number;
    checkedInAt: string | null;
  }>;
};

export function KioskBoard({
  campaignId,
  campaignName,
  initial,
  tz,
}: {
  campaignId: string;
  campaignName: string;
  initial: Feed;
  tz: string;
}) {
  const [feed, setFeed] = useState<Feed>(initial);
  const etagRef = useRef<string | null>(null);
  const lastArrivedCount = useRef(initial.totals.arrived);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch(`/api/campaigns/${campaignId}/arrivals`, {
          headers: etagRef.current ? { "if-none-match": etagRef.current } : {},
          cache: "no-store",
        });
        if (cancelled || res.status === 304 || !res.ok) return;
        const et = res.headers.get("etag");
        if (et) etagRef.current = et;
        const json = (await res.json()) as Feed;
        if (cancelled) return;
        if (json.totals.arrived > lastArrivedCount.current) {
          chime();
        }
        lastArrivedCount.current = json.totals.arrived;
        setFeed(json);
      } catch {
        /* swallow — next tick retries */
      }
    }
    const id = setInterval(tick, 6_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [campaignId]);

  const fmt = new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone: tz });
  const latestArrivals = feed.rows.filter((r) => r.checkedInAt).slice(0, 6);
  const { arrived, expected, expectedGuests, arrivedGuests } = feed.totals;
  const totalExpected = expected + expectedGuests;
  const totalArrived = arrived + arrivedGuests;
  const ratio = expected ? Math.round((arrived / expected) * 100) : 0;

  return (
    <div className="min-h-screen bg-ink-900 text-ink-0 flex flex-col">
      <header className="flex items-center justify-between px-14 pt-10 pb-6">
        <div className="flex items-center gap-3">
          <span className="h-2 w-2 rounded-full bg-signal-live animate-pulse" aria-hidden />
          <span className="text-micro uppercase text-ink-300 tracking-wider">Live · door</span>
        </div>
        <span className="text-micro uppercase text-ink-300 tracking-wider tabular-nums">
          {new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz }).format(new Date())}
        </span>
      </header>

      <div className="px-14 mb-8">
        <h1 className="text-ink-0 truncate" style={{ fontSize: "52px", lineHeight: "60px", letterSpacing: "-0.03em", fontWeight: 500 }}>
          {campaignName}
        </h1>
      </div>

      <div className="grid grid-cols-4 gap-10 px-14 mb-14">
        <BigStat label="Expected" value={expected} />
        <BigStat label="Arrived" value={arrived} accent="live" />
        <BigStat label="Pending" value={Math.max(0, expected - arrived)} />
        <BigStat label="Headcount" value={totalArrived} hint={`/ ${totalExpected}`} accent="live" />
      </div>

      <div className="flex-1 px-14 pb-14">
        <div className="flex items-baseline justify-between mb-6">
          <h2 className="text-ink-0" style={{ fontSize: "28px", lineHeight: "34px", letterSpacing: "-0.02em", fontWeight: 500 }}>
            Latest arrivals
          </h2>
          <span className="text-ink-300 tabular-nums" style={{ fontSize: "16px" }}>
            {ratio}% checked in
          </span>
        </div>
        {latestArrivals.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-ink-300">
            <span className="text-section">Waiting for arrivals…</span>
          </div>
        ) : (
          <ol className="flex flex-col divide-y divide-ink-800">
            {latestArrivals.map((r) => (
              <li key={r.id} className="flex items-center justify-between py-6">
                <div className="min-w-0">
                  <div
                    className="text-ink-0 truncate"
                    style={{ fontSize: "28px", lineHeight: "34px", letterSpacing: "-0.01em", fontWeight: 500 }}
                  >
                    {r.name}
                  </div>
                  <div className="text-ink-400 truncate" style={{ fontSize: "16px" }}>
                    {[r.title, r.organization].filter(Boolean).join(" · ") || "Guest"}
                    {r.guestsCount > 0 ? ` · +${r.guestsCount}` : ""}
                  </div>
                </div>
                <div className="text-signal-live tabular-nums shrink-0 ms-8" style={{ fontSize: "20px", fontWeight: 500 }}>
                  {r.checkedInAt ? fmt.format(new Date(r.checkedInAt)) : ""}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function BigStat({ label, value, hint, accent }: { label: string; value: number; hint?: string; accent?: "live" }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-micro uppercase text-ink-400 tracking-wider">{label}</span>
      <div className="flex items-baseline gap-3">
        <span
          className={accent === "live" ? "text-signal-live tabular-nums" : "text-ink-0 tabular-nums"}
          style={{ fontSize: "64px", lineHeight: "64px", letterSpacing: "-0.03em", fontWeight: 500 }}
        >
          {value.toLocaleString()}
        </span>
        {hint ? (
          <span className="text-ink-400 tabular-nums" style={{ fontSize: "20px" }}>{hint}</span>
        ) : null}
      </div>
    </div>
  );
}

// Short synthesized beep using Web Audio — no asset needed. Fails silently
// in browsers that block autoplay until user interaction.
function chime() {
  try {
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.45);
    setTimeout(() => ctx.close(), 600);
  } catch {
    /* ignore */
  }
}
