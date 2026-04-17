"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Stat } from "./Stat";
import { Badge } from "./Badge";

type Row = {
  id: string;
  name: string;
  title: string | null;
  organization: string | null;
  token: string;
  guestsCount: number;
  checkedInAt: string | null;
};

type Feed = {
  version: string;
  totals: {
    expected: number;
    arrived: number;
    pending: number;
    expectedGuests: number;
    arrivedGuests: number;
  };
  rows: Row[];
};

// Client-polled board. Preserves scroll and focus across updates.
// ETag-aware; idle tabs get a 304 and do almost no work.

export function ArrivalsBoard({
  campaignId,
  initial,
  tz,
}: {
  campaignId: string;
  initial: Feed;
  tz: string;
}) {
  const [feed, setFeed] = useState<Feed>(initial);
  const etagRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch(`/api/campaigns/${campaignId}/arrivals`, {
          headers: etagRef.current ? { "if-none-match": etagRef.current } : {},
          cache: "no-store",
        });
        if (cancelled) return;
        if (res.status === 304) return;
        if (!res.ok) return;
        const et = res.headers.get("etag");
        if (et) etagRef.current = et;
        const json = (await res.json()) as Feed;
        setFeed(json);
      } catch {
        /* network blip — wait for next tick */
      }
    }
    // Prime the ETag so the next tick can 304 immediately when idle.
    etagRef.current = etagRef.current ?? null;
    const id = setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [campaignId]);

  const fmt = new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone: tz });
  const totals = feed.totals;
  const expected = totals.expected;
  const totalExpected = expected + totals.expectedGuests;
  const totalArrived = totals.arrived + totals.arrivedGuests;
  const ratio = expected ? `${Math.round((totals.arrived / expected) * 100)}%` : "";

  return (
    <>
      <div className="grid grid-cols-5 gap-8 mb-10">
        <Stat label="Expected" value={expected} />
        <Stat label="Arrived" value={totals.arrived} hint={ratio} />
        <Stat label="Pending" value={totals.pending} />
        <Stat label="Guests arrived" value={totals.arrivedGuests} />
        <Stat label="Headcount" value={totalArrived} hint={`/ ${totalExpected}`} />
      </div>

      <div className="panel rail overflow-hidden">
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Organization</th>
              <th scope="col">Guests</th>
              <th scope="col">Status</th>
              <th scope="col" className="text-right">Time</th>
            </tr>
          </thead>
          <tbody>
            {feed.rows.map((r) => {
              const inIn = !!r.checkedInAt;
              return (
                <tr key={r.id}>
                  <td>
                    <Link href={`/checkin/${r.token}`} className="font-medium text-ink-900 hover:underline">
                      {r.name}
                    </Link>
                    {r.title ? <div className="text-xs text-ink-400 mt-0.5">{r.title}</div> : null}
                  </td>
                  <td className="text-ink-600">{r.organization ?? <span className="text-ink-300">—</span>}</td>
                  <td className="text-ink-600 tabular-nums">
                    {r.guestsCount > 0 ? `+ ${r.guestsCount}` : <span className="text-ink-300">—</span>}
                  </td>
                  <td>
                    <Badge tone={inIn ? "live" : "hold"}>{inIn ? "arrived" : "expected"}</Badge>
                  </td>
                  <td className="text-right tabular-nums text-xs text-ink-600">
                    {inIn && r.checkedInAt ? fmt.format(new Date(r.checkedInAt)) : <span className="text-ink-300">—</span>}
                  </td>
                </tr>
              );
            })}
            {feed.rows.length === 0 ? (
              <tr><td colSpan={5} className="py-16 text-center text-ink-400 text-sm">No confirmed attendees yet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-ink-400 mt-4">Auto-updates every 10s. Scroll + selection are preserved.</p>
    </>
  );
}
