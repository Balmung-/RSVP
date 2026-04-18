import { prisma } from "./db";

// Response pulse — a daily bucket count of RSVPs on a given campaign
// for the last N days. Powers the thin sparkline on the campaign
// workspace. Two series: attending and declined. Kept small and
// scalar so the renderer stays trivial.

export type PulseBucket = {
  dayKey: string; // YYYY-MM-DD in APP_TIMEZONE
  attending: number;
  declined: number;
};

const TZ = () => process.env.APP_TIMEZONE ?? "Asia/Riyadh";

function localDayKey(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const dd = parts.find((p) => p.type === "day")?.value ?? "";
  return `${y}-${m}-${dd}`;
}

export async function campaignPulse(
  campaignId: string,
  days: number = 30,
): Promise<PulseBucket[]> {
  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 3600_000);

  const rows = await prisma.response.findMany({
    where: { campaignId, respondedAt: { gte: since } },
    select: { respondedAt: true, attending: true },
  });

  const buckets = new Map<string, PulseBucket>();
  // Seed every day in the window so the sparkline has uniform spacing
  // and empty days render as zero-height bars rather than gaps.
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getTime() - (days - 1 - i) * 24 * 3600_000);
    const key = localDayKey(d);
    buckets.set(key, { dayKey: key, attending: 0, declined: 0 });
  }
  for (const r of rows) {
    const key = localDayKey(r.respondedAt);
    const slot = buckets.get(key);
    if (!slot) continue;
    if (r.attending) slot.attending++;
    else slot.declined++;
  }
  return Array.from(buckets.values());
}
