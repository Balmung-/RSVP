// Datetime-local HTML inputs are timezone-naive. The admin enters "19:00"
// meaning 19:00 in Riyadh. Interpreting it as UTC (the server default on Vercel
// and Railway) would silently shift the time by 3 hours.
//
// KSA doesn't observe DST — Asia/Riyadh is +03:00 year-round. For other
// deployments, set APP_TIMEZONE to one of the fixed-offset zones below.

const OFFSETS: Record<string, string> = {
  "Asia/Riyadh": "+03:00",
  "Asia/Dubai": "+04:00",
  "Africa/Cairo": "+02:00",
  UTC: "+00:00",
};

function offsetString(): string {
  const tz = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
  return OFFSETS[tz] ?? "+03:00";
}

function offsetMinutes(): number {
  const s = offsetString();
  const sign = s[0] === "-" ? -1 : 1;
  const h = parseInt(s.slice(1, 3), 10);
  const m = parseInt(s.slice(4, 6), 10);
  return sign * (h * 60 + m);
}

// Parse a <input type="datetime-local"> value in the configured APP_TIMEZONE.
// Returns null if empty/invalid.
export function parseLocalInput(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) return null;
  const iso = s.length === 16 ? `${s}:00${offsetString()}` : `${s}${offsetString()}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Format a Date as a datetime-local string in the configured APP_TIMEZONE —
// used to pre-fill the input when editing.
export function toLocalInput(d: Date | null | undefined): string {
  if (!d) return "";
  const shifted = new Date(d.getTime() + offsetMinutes() * 60_000);
  return shifted.toISOString().slice(0, 16);
}
