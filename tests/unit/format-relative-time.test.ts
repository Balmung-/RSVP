import { test } from "node:test";
import assert from "node:assert/strict";

import { formatRelativeTime } from "../../src/components/chat/formatRelativeTime";

// P4-B — tests for the picker's "last touched" label.
//
// Why test this:
//   - The helper branches on several thresholds (30s, 60m, 24h, 48h,
//     7d, same-year) and a silent off-by-one in any threshold would
//     show the operator the wrong bucket (e.g. a session touched 30s
//     ago labelled "1 minute ago" for rows that should read "just
//     now").
//   - `numeric: "auto"` changes the -1 day output to "yesterday" — if
//     a future refactor forgets that option the picker suddenly reads
//     "1 day ago" which looks robotic next to "just now".
//   - Invalid input paths (empty string, "bogus", NaN `now`) must
//     return empty string, not "NaN years ago" or crash the row.
//   - Clock skew: a future `then` must not emit "in 5 minutes".

// All tests pin a fixed `now` so they're deterministic across
// timezones and CI clock jitter.
const NOW = new Date("2026-04-20T12:00:00Z");

// Helper — subtract seconds from NOW and return the ISO string.
function iso(secondsAgo: number): string {
  return new Date(NOW.getTime() - secondsAgo * 1000).toISOString();
}

// ---- Just-now bucket ---------------------------------------------

test("formatRelativeTime: 0 seconds ago returns 'just now' (en)", () => {
  assert.equal(formatRelativeTime(iso(0), { now: NOW, locale: "en" }), "just now");
});

test("formatRelativeTime: 29 seconds ago still reads 'just now' (en)", () => {
  // Boundary — under 30s the label is static so the picker doesn't
  // flicker 1s → 2s → 3s as the operator watches.
  assert.equal(formatRelativeTime(iso(29), { now: NOW, locale: "en" }), "just now");
});

test("formatRelativeTime: 'just now' localises in Arabic", () => {
  assert.equal(formatRelativeTime(iso(0), { now: NOW, locale: "ar" }), "الآن");
});

// ---- Minutes bucket ----------------------------------------------

test("formatRelativeTime: 30 seconds ago crosses into minutes bucket (en)", () => {
  // Exactly at 30s the Intl formatter should take over with 1 minute.
  const out = formatRelativeTime(iso(30), { now: NOW, locale: "en" });
  assert.match(out, /minute/);
});

test("formatRelativeTime: 5 minutes ago reads '5 minutes ago' (en)", () => {
  assert.equal(
    formatRelativeTime(iso(5 * 60), { now: NOW, locale: "en" }),
    "5 minutes ago",
  );
});

test("formatRelativeTime: 59 minutes ago stays in the minutes bucket (en)", () => {
  // Last slot before the hour threshold. Must NOT round up to 1 hour.
  const out = formatRelativeTime(iso(59 * 60), { now: NOW, locale: "en" });
  assert.match(out, /minute/);
});

// ---- Hours bucket ------------------------------------------------

test("formatRelativeTime: 60 minutes ago crosses into hours bucket (en)", () => {
  const out = formatRelativeTime(iso(60 * 60), { now: NOW, locale: "en" });
  assert.match(out, /hour/);
});

test("formatRelativeTime: 2 hours ago reads '2 hours ago' (en)", () => {
  assert.equal(
    formatRelativeTime(iso(2 * 60 * 60), { now: NOW, locale: "en" }),
    "2 hours ago",
  );
});

// ---- Yesterday (numeric:auto) ------------------------------------

test("formatRelativeTime: 25 hours ago reads 'yesterday' not '1 day ago' (en)", () => {
  // Pins the numeric:"auto" option. Without it, Intl emits "1 day
  // ago" which looks robotic next to "just now" and "yesterday" in
  // the dropdown. If this test breaks, check that numeric:"auto" is
  // still passed to Intl.RelativeTimeFormat.
  assert.equal(
    formatRelativeTime(iso(25 * 60 * 60), { now: NOW, locale: "en" }),
    "yesterday",
  );
});

test("formatRelativeTime: 25 hours ago localises to 'أمس' in Arabic", () => {
  assert.equal(
    formatRelativeTime(iso(25 * 60 * 60), { now: NOW, locale: "ar" }),
    "أمس",
  );
});

// ---- Days bucket -------------------------------------------------

test("formatRelativeTime: 3 days ago reads '3 days ago' (en)", () => {
  assert.equal(
    formatRelativeTime(iso(3 * 24 * 60 * 60), { now: NOW, locale: "en" }),
    "3 days ago",
  );
});

test("formatRelativeTime: 6 days ago still reads in days bucket (en)", () => {
  // Last slot before the calendar fallback kicks in. Must NOT read
  // as a date like "Apr 14".
  const out = formatRelativeTime(iso(6 * 24 * 60 * 60), {
    now: NOW,
    locale: "en",
  });
  assert.match(out, /day/);
});

// ---- Calendar fallback -------------------------------------------

test("formatRelativeTime: 7 days ago crosses into calendar bucket (en, same year)", () => {
  // At exactly 7 * 86400s the fallback must produce a calendar date
  // without a year (same-year condensed form).
  const out = formatRelativeTime(iso(7 * 24 * 60 * 60), {
    now: NOW,
    locale: "en",
  });
  // Should NOT contain "day" or "ago" — it's a calendar date now.
  assert.ok(!/day|ago/.test(out), `expected calendar date, got "${out}"`);
  // Must mention the actual month (Apr) since NOW = 2026-04-20 and
  // 7 days before is 2026-04-13.
  assert.match(out, /Apr/);
  assert.match(out, /13/);
});

test("formatRelativeTime: 8 days ago, same year — month + day but NO year", () => {
  // 2026-04-12 — strictly same-year with NOW (2026-04-20).
  const out = formatRelativeTime(iso(8 * 24 * 60 * 60), {
    now: NOW,
    locale: "en",
  });
  assert.match(out, /Apr/);
  assert.match(out, /12/);
  assert.ok(!/2026/.test(out), `same-year should drop year, got "${out}"`);
});

test("formatRelativeTime: 400 days ago — prior year, includes the year", () => {
  // 400 days before 2026-04-20 is early 2025. The year must appear
  // so the operator can distinguish "Apr 18 this year" from
  // "Apr 18 last year".
  const out = formatRelativeTime(iso(400 * 24 * 60 * 60), {
    now: NOW,
    locale: "en",
  });
  assert.match(out, /2025/);
});

// ---- Invalid inputs ----------------------------------------------

test("formatRelativeTime: empty string returns empty string", () => {
  assert.equal(formatRelativeTime("", { now: NOW, locale: "en" }), "");
});

test("formatRelativeTime: non-ISO garbage returns empty string", () => {
  assert.equal(
    formatRelativeTime("not-a-date", { now: NOW, locale: "en" }),
    "",
  );
});

test("formatRelativeTime: non-string input returns empty string", () => {
  assert.equal(
    formatRelativeTime(undefined as unknown as string, {
      now: NOW,
      locale: "en",
    }),
    "",
  );
  assert.equal(
    formatRelativeTime(null as unknown as string, { now: NOW, locale: "en" }),
    "",
  );
});

test("formatRelativeTime: NaN `now` returns empty string, not 'just now'", () => {
  // Defensive — a caller that accidentally passes `new Date("bad")`
  // would silently label every row "just now" otherwise, masking a
  // real bug. Empty string makes the mistake visible.
  assert.equal(
    formatRelativeTime(iso(60), {
      now: new Date("not-a-date"),
      locale: "en",
    }),
    "",
  );
});

// ---- Clock skew (future timestamp) -------------------------------

test("formatRelativeTime: timestamp 60s in the FUTURE reads 'just now' not 'in 1 minute'", () => {
  // A UI labelled "in 5 minutes ago" looks broken. Clamp future
  // timestamps to zero diff instead.
  const future = new Date(NOW.getTime() + 60 * 1000).toISOString();
  assert.equal(
    formatRelativeTime(future, { now: NOW, locale: "en" }),
    "just now",
  );
});
