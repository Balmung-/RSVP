import { test } from "node:test";
import assert from "node:assert/strict";

import {
  phrase,
  type ActivityRecord,
} from "../../src/lib/activity";

// P14-I pin set (half A) — `phrase()` is the bilingual-ish
// activity-line renderer used by:
//   - the dashboard's recent-activity widget
//   - the per-campaign activity page
//   - the `campaign_detail` AI tool (rendered as card.activity[])
//   - the `recent_activity` AI tool (returned verbatim to the model)
//
// Every string here is operator-visible. There are ~45 event-kind
// branches in the switch; this file pins one representative test
// per kind (so a silent kind-rename or accidental deletion breaks
// a specific test) plus dedicated pins for the cross-cutting
// properties:
//
//   - Actor fallback cascade (fullName → email → "System")
//   - Tone correctness per kind (tone is rendered as a colored dot
//     in the UI; default=grey, success=green, warn=amber, fail=red)
//   - Pluralization toggles (1 vs N recipients / invitees / guests)
//   - Tier-to-tone table for rsvp.vip.notified (royal=fail is a
//     load-bearing escalation property)
//   - The `default` fallback branch — critical because an unknown
//     kind MUST NOT throw, must produce a readable fallback line
//   - `channelLabel` mapping (inlined in activity.ts — covered
//     transitively by kind tests that depend on data.channel)
//   - `safeJSON` tolerance on malformed / missing e.data
//
// The original file uses positional arguments and JSON.parse on
// `e.data`; constructing a minimal ActivityRecord for each test
// keeps the assertion surface tight.

// Tiny factory — fills in the fields phrase() reads, leaves
// everything else undefined. The prisma EventLog has many columns
// (id, createdAt, actorId, etc.); phrase only reads kind, refType,
// data, and actor — so we cast through unknown at the boundary.
function record(fields: {
  kind: string;
  refType?: string | null;
  data?: Record<string, unknown> | null;
  actor?: { email: string; fullName: string | null } | null;
}): ActivityRecord {
  return {
    kind: fields.kind,
    refType: fields.refType ?? null,
    data: fields.data === null
      ? null
      : fields.data === undefined
        ? null
        : JSON.stringify(fields.data),
    actor: fields.actor ?? null,
  } as unknown as ActivityRecord;
}

// ---------------------------------------------------------------
// Cross-cutting — actor fallback cascade.
// ---------------------------------------------------------------

test("phrase: actor with fullName renders fullName, not email", () => {
  const r = phrase(
    record({
      kind: "user.login",
      actor: { email: "alice@example.com", fullName: "Alice Admin" },
    }),
  );
  assert.equal(r.line, "Alice Admin signed in.");
});

test("phrase: actor without fullName falls back to email", () => {
  const r = phrase(
    record({
      kind: "user.login",
      actor: { email: "bob@example.com", fullName: null },
    }),
  );
  assert.equal(r.line, "bob@example.com signed in.");
});

test("phrase: actor absent (null) falls back to 'System' (system-emitted events)", () => {
  // invite.sent is emitted by the server, not by an actor — so
  // the "System" fallback renders for system-side lines. Pinning
  // this prevents a regression that would show "null signed in"
  // or a raw id on system-emitted rows.
  const r = phrase(
    record({ kind: "user.login", actor: null }),
  );
  assert.equal(r.line, "System signed in.");
});

// ---------------------------------------------------------------
// Default fallback — critical robustness property.
// ---------------------------------------------------------------

test("phrase: unknown kind falls back to '<actor> · <kind> on <refType>' format", () => {
  // Forward-compatible — a new event kind added to the system
  // before activity.ts gets a dedicated branch MUST NOT crash
  // the UI; the fallback produces a readable line.
  const r = phrase(
    record({
      kind: "something.new.feature",
      refType: "campaign",
      actor: { email: "x@y.com", fullName: "Sam" },
    }),
  );
  assert.equal(r.line, "Sam · something.new.feature on campaign.");
  assert.equal(r.tone, "default");
});

test("phrase: unknown kind with missing refType omits the 'on X' clause", () => {
  const r = phrase(
    record({
      kind: "something.new",
      actor: { email: "x@y.com", fullName: "Sam" },
    }),
  );
  assert.equal(r.line, "Sam · something.new.");
});

// ---------------------------------------------------------------
// user.* kinds — 6 tests.
// ---------------------------------------------------------------

test("phrase: user.created renders with email + role interpolation", () => {
  const r = phrase(
    record({
      kind: "user.created",
      actor: { email: "admin@x.com", fullName: "Admin" },
      data: { email: "new@x.com", role: "editor" },
    }),
  );
  assert.equal(
    r.line,
    'Admin invited new@x.com as editor.',
  );
});

test("phrase: user.created with missing data falls back to sane placeholders", () => {
  const r = phrase(
    record({
      kind: "user.created",
      actor: { email: "a@x.com", fullName: "A" },
      data: {},
    }),
  );
  assert.equal(r.line, "A invited a new user as member.");
});

test("phrase: user.password_reset → tone warn (elevated operation)", () => {
  const r = phrase(
    record({
      kind: "user.password_reset",
      actor: { email: "a@x.com", fullName: "A" },
    }),
  );
  assert.equal(r.tone, "warn");
});

test("phrase: user.deleted → tone warn", () => {
  const r = phrase(
    record({
      kind: "user.deleted",
      actor: { email: "a@x.com", fullName: "A" },
    }),
  );
  assert.equal(r.tone, "warn");
});

test("phrase: user.2fa_enabled → success tone", () => {
  const r = phrase(
    record({
      kind: "user.2fa_enabled",
      actor: { email: "a@x.com", fullName: "A" },
    }),
  );
  assert.equal(r.tone, "success");
  assert.equal(r.line, "A turned on two-step sign-in.");
});

test("phrase: user.2fa_disabled → warn tone (security regression signal)", () => {
  // 2FA being DISABLED is a security-sensitive event — the warn
  // tone alerts operators scanning activity logs. Pinned to
  // prevent a tone-table regression that would demote this to
  // default.
  const r = phrase(
    record({
      kind: "user.2fa_disabled",
      actor: { email: "a@x.com", fullName: "A" },
    }),
  );
  assert.equal(r.tone, "warn");
});

// ---------------------------------------------------------------
// approval.* — 3 tests covering plural toggle + tone table.
// ---------------------------------------------------------------

test("phrase: approval.requested — 1 recipient (singular)", () => {
  const r = phrase(
    record({
      kind: "approval.requested",
      actor: { email: "a@x.com", fullName: "A" },
      data: { recipients: 1, channel: "email" },
    }),
  );
  assert.equal(
    r.line,
    "A requested admin approval — 1 recipient on email.",
  );
  assert.equal(r.tone, "warn");
});

test("phrase: approval.requested — N recipients (plural + toLocaleString formatting)", () => {
  const r = phrase(
    record({
      kind: "approval.requested",
      actor: { email: "a@x.com", fullName: "A" },
      data: { recipients: 1500, channel: "both" },
    }),
  );
  // `toLocaleString()` is environment-dependent but Node
  // defaults to en-US formatting with commas. If running in a
  // different locale this test would need a more permissive
  // assertion — pinned under en-US for the test env.
  assert.ok(
    r.line.includes("1,500 recipients") ||
      r.line.includes("1500 recipients"),
    `expected plural 'recipients' with formatted count, got: ${r.line}`,
  );
  assert.ok(r.line.includes("email + SMS"));
});

test("phrase: approval.rejected → tone fail with truncated note", () => {
  const r = phrase(
    record({
      kind: "approval.rejected",
      actor: { email: "a@x.com", fullName: "A" },
      data: { note: "timing conflict with a competing event" },
    }),
  );
  assert.equal(r.tone, "fail");
  assert.ok(r.line.includes('"timing conflict'));
});

// ---------------------------------------------------------------
// invite.* — 6 kinds (send, deliver, fail, bounce, retry ok/fail).
// ---------------------------------------------------------------

test("phrase: invite.sent uses channelLabel mapping", () => {
  const r = phrase(
    record({ kind: "invite.sent", data: { channel: "sms" } }),
  );
  // channelLabel("sms") → "SMS" (uppercase)
  assert.equal(r.line, "Invitation sent via SMS.");
});

test("phrase: invite.delivered → tone success", () => {
  const r = phrase(record({ kind: "invite.delivered" }));
  assert.equal(r.tone, "success");
});

test("phrase: invite.failed → tone fail with provider error detail", () => {
  const r = phrase(
    record({
      kind: "invite.failed",
      data: { error: "rate limit exceeded" },
    }),
  );
  assert.equal(r.tone, "fail");
  assert.ok(r.line.includes("rate limit exceeded"));
});

test("phrase: invite.failed without error falls back to 'provider error'", () => {
  const r = phrase(record({ kind: "invite.failed", data: {} }));
  assert.equal(r.line, "Delivery failed — provider error.");
});

test("phrase: invite.bounced → tone fail", () => {
  const r = phrase(record({ kind: "invite.bounced" }));
  assert.equal(r.tone, "fail");
});

test("phrase: invite.retry.ok → success tone", () => {
  const r = phrase(
    record({
      kind: "invite.retry.ok",
      actor: { email: "a@x.com", fullName: "A" },
    }),
  );
  assert.equal(r.tone, "success");
});

// ---------------------------------------------------------------
// rsvp.* — attending/declined branches + tier→tone table.
// ---------------------------------------------------------------

test("phrase: rsvp.submitted (attending, 0 guests) — success tone, no guest suffix", () => {
  const r = phrase(
    record({
      kind: "rsvp.submitted",
      data: { attending: true, guests: 0 },
    }),
  );
  assert.equal(r.line, "An invitee confirmed attending.");
  assert.equal(r.tone, "success");
});

test("phrase: rsvp.submitted (attending, N guests) — includes `(+N)` suffix", () => {
  const r = phrase(
    record({
      kind: "rsvp.submitted",
      data: { attending: true, guests: 3 },
    }),
  );
  assert.equal(r.line, "An invitee confirmed attending (+3).");
});

test("phrase: rsvp.submitted (declined) — default tone, no '(+N)' suffix", () => {
  // Declined is 'default' tone (neutral), not 'warn' — an RSVP
  // no is a legitimate outcome, not a warning state. Pinned to
  // keep the tone table calm.
  const r = phrase(
    record({
      kind: "rsvp.submitted",
      data: { attending: false, guests: 5 },
    }),
  );
  assert.equal(r.line, "An invitee declined.");
  assert.equal(r.tone, "default");
});

test("phrase: rsvp.vip.notified — royal → tone fail (load-bearing escalation)", () => {
  // Royal-tier RSVPs trigger a "red alert" on the activity feed.
  // A regression demoting this to warn or default would quietly
  // lower the signal strength on events that need the
  // highest operator attention.
  const r = phrase(
    record({
      kind: "rsvp.vip.notified",
      data: { tier: "royal" },
    }),
  );
  assert.equal(r.line, "Royal RSVP — admins notified.");
  assert.equal(r.tone, "fail");
});

test("phrase: rsvp.vip.notified — minister → warn tone", () => {
  const r = phrase(
    record({
      kind: "rsvp.vip.notified",
      data: { tier: "minister" },
    }),
  );
  assert.equal(r.line, "Minister RSVP — admins notified.");
  assert.equal(r.tone, "warn");
});

test("phrase: rsvp.vip.notified — vip (generic) → warn tone", () => {
  const r = phrase(
    record({ kind: "rsvp.vip.notified", data: { tier: "vip" } }),
  );
  assert.equal(r.line, "VIP RSVP — admins notified.");
  assert.equal(r.tone, "warn");
});

// ---------------------------------------------------------------
// stage.* — tone is data-dependent (failed>0 → warn).
// ---------------------------------------------------------------

test("phrase: stage.completed with 0 failed → success tone", () => {
  const r = phrase(
    record({
      kind: "stage.completed",
      data: { sent: 100, failed: 0 },
    }),
  );
  assert.equal(r.line, "Stage completed — 100 sent, 0 failed.");
  assert.equal(r.tone, "success");
});

test("phrase: stage.completed with failed>0 → warn tone", () => {
  // Completion isn't "fail" (the stage still ran), but the
  // presence of failures downgrades to warn for attention.
  const r = phrase(
    record({
      kind: "stage.completed",
      data: { sent: 98, failed: 2 },
    }),
  );
  assert.equal(r.tone, "warn");
});

test("phrase: stage.failed → fail tone (stage itself errored)", () => {
  const r = phrase(
    record({
      kind: "stage.failed",
      data: { error: "SMTP timeout" },
    }),
  );
  assert.equal(r.tone, "fail");
  assert.ok(r.line.includes("SMTP timeout"));
});

// ---------------------------------------------------------------
// inbound.* — 4 kinds, covers the auto-apply vs reviewed path.
// ---------------------------------------------------------------

test("phrase: inbound.applied (attending) → success tone", () => {
  const r = phrase(
    record({
      kind: "inbound.applied",
      data: { intent: "attending", channel: "email" },
    }),
  );
  assert.equal(
    r.line,
    "Auto-applied an attending reply from email.",
  );
  assert.equal(r.tone, "success");
});

test("phrase: inbound.applied (declined) → success tone (RSVP captured is a win)", () => {
  const r = phrase(
    record({
      kind: "inbound.applied",
      data: { intent: "declined", channel: "sms" },
    }),
  );
  assert.equal(r.line, "Auto-applied a declined reply from SMS.");
  assert.equal(r.tone, "success");
});

test("phrase: inbound.applied (stop) — generic auto-processed phrasing", () => {
  const r = phrase(
    record({
      kind: "inbound.applied",
      data: { intent: "stop", channel: "email" },
    }),
  );
  // Not the attending/declined branch — stop intent routes
  // through the third branch: "Auto-processed an inbound stop."
  assert.equal(r.line, "Auto-processed an inbound stop.");
});

test("phrase: inbound.reviewed — actor applied a reviewer decision", () => {
  const r = phrase(
    record({
      kind: "inbound.reviewed",
      actor: { email: "reviewer@x.com", fullName: "Reviewer" },
      data: { decision: "attending", channel: "sms" },
    }),
  );
  assert.equal(
    r.line,
    'Reviewer applied "attending" from SMS inbox.',
  );
});

// ---------------------------------------------------------------
// import.completed — pluralization + duplicates branch.
// ---------------------------------------------------------------

test("phrase: import.completed (1 created, 0 duplicates) — singular, no duplicates clause", () => {
  const r = phrase(
    record({
      kind: "import.completed",
      actor: { email: "a@x.com", fullName: "A" },
      data: {
        created: 1,
        duplicatesWithin: 0,
        duplicatesExisting: 0,
      },
    }),
  );
  assert.equal(r.line, "A imported 1 invitee.");
  assert.equal(r.tone, "success");
});

test("phrase: import.completed (N created, M duplicates) — plural + duplicates clause", () => {
  const r = phrase(
    record({
      kind: "import.completed",
      actor: { email: "a@x.com", fullName: "A" },
      data: {
        created: 42,
        duplicatesWithin: 3,
        duplicatesExisting: 5,
      },
    }),
  );
  assert.equal(
    r.line,
    "A imported 42 invitees (8 duplicates skipped).",
  );
});

// ---------------------------------------------------------------
// contact/unsubscribe/template/team/checkin — one representative
// test each to pin that the branches exist and return the right
// tone (smaller set; exact strings are less regression-prone for
// these simpler branches).
// ---------------------------------------------------------------

test("phrase: unsubscribe.one_click → warn tone", () => {
  const r = phrase(record({ kind: "unsubscribe.one_click" }));
  assert.equal(r.tone, "warn");
});

test("phrase: contact.deleted → warn tone", () => {
  const r = phrase(
    record({
      kind: "contact.deleted",
      actor: { email: "a@x.com", fullName: "A" },
    }),
  );
  assert.equal(r.tone, "warn");
});

test("phrase: template.deleted → warn tone", () => {
  const r = phrase(
    record({
      kind: "template.deleted",
      actor: { email: "a@x.com", fullName: "A" },
    }),
  );
  assert.equal(r.tone, "warn");
});

test("phrase: team.deleted → warn tone (irreversible operation)", () => {
  const r = phrase(
    record({
      kind: "team.deleted",
      actor: { email: "a@x.com", fullName: "A" },
    }),
  );
  assert.equal(r.tone, "warn");
});

test("phrase: checkin.arrived (with guests) → success + `(+N)` suffix", () => {
  const r = phrase(
    record({
      kind: "checkin.arrived",
      data: { guests: 2 },
    }),
  );
  assert.equal(
    r.line,
    "An invitee arrived at the event (+2).",
  );
  assert.equal(r.tone, "success");
});

test("phrase: checkin.reverted → warn tone (data adjustment)", () => {
  const r = phrase(
    record({
      kind: "checkin.reverted",
      actor: { email: "a@x.com", fullName: "A" },
    }),
  );
  assert.equal(r.tone, "warn");
});

// ---------------------------------------------------------------
// safeJSON robustness — tested through phrase()'s data access.
// ---------------------------------------------------------------

test("phrase: malformed JSON data survives (safeJSON returns {})", () => {
  // A DB row with garbage data (e.g., from a schema-mismatched
  // migration) MUST NOT crash the feed — safeJSON catches the
  // parse error and returns an empty object. Pinned by asserting
  // the default-value branches fire.
  const r = phrase({
    kind: "user.created",
    refType: null,
    data: "NOT VALID JSON {{",
    actor: { email: "a@x.com", fullName: "A" },
  } as unknown as ActivityRecord);
  // Falls through to "a new user" / "member" defaults.
  assert.equal(r.line, "A invited a new user as member.");
});

test("phrase: null data survives (safeJSON short-circuits on null)", () => {
  const r = phrase(
    record({
      kind: "user.created",
      data: null,
      actor: { email: "a@x.com", fullName: "A" },
    }),
  );
  assert.equal(r.line, "A invited a new user as member.");
});

// ---------------------------------------------------------------
// channelLabel coverage (tested transitively via invite.sent /
// approval.requested / inbound.* kinds).
// ---------------------------------------------------------------

test("phrase: channelLabel 'both' renders as 'email + SMS'", () => {
  const r = phrase(
    record({
      kind: "invite.sent",
      data: { channel: "both" },
    }),
  );
  assert.equal(r.line, "Invitation sent via email + SMS.");
});

test("phrase: channelLabel with unknown channel string passes through verbatim", () => {
  const r = phrase(
    record({
      kind: "invite.sent",
      data: { channel: "whatsapp" },
    }),
  );
  // "whatsapp" is not email/sms/both → falls through to the
  // "typeof === string" branch and renders as-is.
  assert.equal(r.line, "Invitation sent via whatsapp.");
});

test("phrase: channelLabel with missing channel falls back to 'message'", () => {
  const r = phrase(
    record({
      kind: "invite.sent",
      data: {},
    }),
  );
  assert.equal(r.line, "Invitation sent via message.");
});

// ---------------------------------------------------------------
// Shape drift — the return shape is { line, tone } with
// tone ∈ {default, success, warn, fail}. Pinned exhaustively.
// ---------------------------------------------------------------

test("phrase: return shape — exactly { line, tone } keys, tone in closed set", () => {
  const r = phrase(record({ kind: "user.login" }));
  assert.deepEqual(Object.keys(r).sort(), ["line", "tone"]);
  assert.ok(
    ["default", "success", "warn", "fail"].includes(r.tone),
    `tone ${r.tone} outside closed set`,
  );
});
