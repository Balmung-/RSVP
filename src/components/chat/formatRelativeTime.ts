// Pure relative-time formatter for the P4-B session picker.
//
// Each row in the picker dropdown needs a compact "last touched" label
// so the operator can eyeball recency without reading a full
// timestamp. The shape follows Gmail/Slack picker conventions:
//
//   < 30s   → "just now"           / "الآن"
//   < 1h    → "5 minutes ago"      / Intl-localized variant
//   < 24h   → "2 hours ago"        / "منذ ساعتين"
//   < 48h   → "yesterday"          / "أمس"           (Intl numeric:auto)
//   < 7d    → "3 days ago"
//   same calendar year → "Apr 18"  / "١٨ أبريل"     (Intl short date)
//   else    → "Apr 18, 2025"       / "١٨ أبريل ٢٠٢٥"
//
// Why a separate pure helper (instead of reusing the local `formatAge`
// in WorkspaceRollup.tsx):
//   - `formatAge` hard-codes `Date.now()` — untestable without freezing
//     global time. We need deterministic tests here.
//   - The picker needs a CALENDAR fallback past 7 days; the rollup
//     keeps going with "17 days ago" because the rollup is always
//     fresh-ish. Picker rows can be months old.
//   - `numeric: "auto"` is mandatory so -1 day reads "yesterday", not
//     "1 day ago". The picker shows one row per session and the
//     difference is visually jarring next to "just now".
//
// Contract:
//   - `iso` is an ISO 8601 UTC string (the shape SessionListItem
//     ships). Invalid / empty → returns empty string so callers can
//     `aria-hidden` a blank cell instead of rendering "NaN years ago".
//   - `now` is injectable — tests pass a fixed Date; the UI passes
//     `new Date()` at render time.
//   - Clock-skew defense: if `then > now` we treat the diff as 0
//     ("just now") rather than emit "in 5 minutes". A UI that
//     announces a future timestamp looks broken.

export type RelativeTimeLocale = "en" | "ar";

export function formatRelativeTime(
  iso: string,
  opts: { now: Date; locale: RelativeTimeLocale },
): string {
  if (typeof iso !== "string" || iso.length === 0) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const nowMs = opts.now.getTime();
  // Guard against a NaN `now` (e.g. a test or runtime that passed
  // `new Date("bogus")`). Without this we'd return "just now" for
  // everything, which silently masks a caller bug.
  if (Number.isNaN(nowMs)) return "";

  const diffMs = Math.max(0, nowMs - then);
  const diffSec = Math.round(diffMs / 1000);

  const tag = opts.locale === "ar" ? "ar-SA" : "en-GB";

  if (diffSec < 30) return opts.locale === "ar" ? "الآن" : "just now";

  const rtf = new Intl.RelativeTimeFormat(tag, { numeric: "auto" });

  if (diffSec < 60 * 60) {
    const m = Math.max(1, Math.round(diffSec / 60));
    return rtf.format(-m, "minute");
  }
  if (diffSec < 60 * 60 * 24) {
    const h = Math.max(1, Math.round(diffSec / 3600));
    return rtf.format(-h, "hour");
  }
  // Between 24h and 48h always reads as "yesterday" via numeric:auto.
  // After that, day count up through the 7-day threshold.
  if (diffSec < 60 * 60 * 24 * 7) {
    const d = Math.max(1, Math.round(diffSec / 86400));
    return rtf.format(-d, "day");
  }

  // Calendar fallback. Same-year rows drop the year so they fit in
  // the narrow picker column; older rows carry the year to avoid
  // confusion between e.g. "Apr 18" two years ago and this year's.
  const thenDate = new Date(then);
  const sameYear = thenDate.getUTCFullYear() === opts.now.getUTCFullYear();
  const fmt = new Intl.DateTimeFormat(tag, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return fmt.format(thenDate);
}
