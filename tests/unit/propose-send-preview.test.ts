import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveProposeSendPreview,
  type ProposeSendChannelInput,
} from "../../src/lib/ai/tools/propose-send-preview";
import type {
  Audience,
  InviteeForAudience,
} from "../../src/lib/ai/tools/send-blockers";

// P14-E — pins the pre-dispatch preview derivation extracted from
// `propose_send.ts`'s handler. Sibling to P14-D' (send-campaign-summary)
// which pinned the POST-dispatch summary. Before this extraction, the
// per-channel bucket fold, `readyMessages` sum, summary-line
// composition, and state ternary all lived inline in a handler that
// pulls in prisma + `loadAudience` + `computeBlockers` — no unit-level
// test could exercise the four transformations in isolation.
//
// Four regression surfaces protected here:
//
//   1. Per-channel bucket fold with 4-way precedence
//      (no_contact → skipped_already_sent → skipped_unsubscribed →
//      ready). A regression flipping any two branches would silently
//      mis-bucket invitees. Visible on the widget's `by_channel`
//      breakdown.
//
//   2. Channel-filter gating — `channel` input → {wantsEmail,
//      wantsSms, wantsWhatsApp}. `"both"` is the pre-P13 vocabulary
//      (email + SMS only) and must NOT silently widen to WhatsApp.
//      A regression flipping this would paint "0 whatsapp" on a
//      scalar "email" send — operator confusion.
//
//   3. `readyMessages` 3-way sum — a regression dropping the WhatsApp
//      bucket silently under-counts the operator-facing ready count
//      on "whatsapp" / "all" sends.
//
//   4. Summary-line composition — first-line format, `readyParts`
//      filter matching the channel set, pluralization branch,
//      conditional Skipped / Blockers lines, always-emitted tail.
//      The summary lands on `output.summary` which the AI transcript
//      consumes verbatim.
//
// Intentionally NOT covered: the widget envelope, template_preview
// clipping, WhatsApp template label construction — those are direct
// pass-throughs from the campaign row, not derivations.

// ---- fixtures --------------------------------------------------

// Build a narrow invitee row with sensible defaults. Every field is
// overrideable so each test isolates one branch.
function mkInvitee(
  overrides: Partial<InviteeForAudience> = {},
): InviteeForAudience {
  return {
    email: "alice@example.com",
    phoneE164: "+15551234567",
    invitations: [],
    ...overrides,
  };
}

// Build an audience from a list of invitees. Unsubscribe sets default
// empty — tests that exercise the unsub path pass explicit sets.
function mkAudience(
  invitees: InviteeForAudience[],
  opts: { unsubEmails?: Set<string>; unsubPhones?: Set<string> } = {},
): Audience {
  return {
    invitees,
    unsubEmails: opts.unsubEmails ?? new Set<string>(),
    unsubPhones: opts.unsubPhones ?? new Set<string>(),
  };
}

// Minimal helper — most tests only vary channel + audience + blockers.
function run(
  channel: ProposeSendChannelInput,
  audience: Audience,
  opts: {
    onlyUnsent?: boolean;
    blockers?: string[];
    campaignName?: string;
    campaignStatus?: string;
  } = {},
) {
  return deriveProposeSendPreview({
    campaignName: opts.campaignName ?? "Test Campaign",
    campaignStatus: opts.campaignStatus ?? "active",
    channel,
    onlyUnsent: opts.onlyUnsent ?? true,
    audience,
    blockers: opts.blockers ?? [],
  });
}

// ---- (1) Per-channel bucket fold — email precedence ------------

test("deriveProposeSendPreview: email bucket → no_contact when inv.email is null", () => {
  // First gate in the precedence chain. A missing email contact
  // lands in no_contact even if other gates would match — this
  // protects against a regression that checks unsub/already-sent
  // before the contact-presence gate.
  const audience = mkAudience([mkInvitee({ email: null })]);
  const out = run("email", audience);
  assert.deepEqual(out.buckets.email, {
    ready: 0,
    skipped_already_sent: 0,
    skipped_unsubscribed: 0,
    no_contact: 1,
  });
});

test("deriveProposeSendPreview: email bucket → skipped_already_sent when onlyUnsent AND has non-failed invitation", () => {
  // Second gate. An invitation row with status !== "failed" on the
  // same channel blocks a resend under onlyUnsent=true.
  const audience = mkAudience([
    mkInvitee({
      invitations: [{ channel: "email", status: "sent" }],
    }),
  ]);
  const out = run("email", audience, { onlyUnsent: true });
  assert.deepEqual(out.buckets.email, {
    ready: 0,
    skipped_already_sent: 1,
    skipped_unsubscribed: 0,
    no_contact: 0,
  });
});

test("deriveProposeSendPreview: email bucket → skipped_unsubscribed when email in unsubEmails set", () => {
  // Third gate. Contact present, no prior send, but on the unsub list.
  const audience = mkAudience([mkInvitee({ email: "bob@example.com" })], {
    unsubEmails: new Set(["bob@example.com"]),
  });
  const out = run("email", audience);
  assert.deepEqual(out.buckets.email, {
    ready: 0,
    skipped_already_sent: 0,
    skipped_unsubscribed: 1,
    no_contact: 0,
  });
});

test("deriveProposeSendPreview: email bucket → ready when all gates pass", () => {
  // Happy path. Contact present, no prior send, not unsubscribed.
  const audience = mkAudience([mkInvitee()]);
  const out = run("email", audience);
  assert.deepEqual(out.buckets.email, {
    ready: 1,
    skipped_already_sent: 0,
    skipped_unsubscribed: 0,
    no_contact: 0,
  });
});

test("deriveProposeSendPreview: email precedence — no_contact wins over already-sent", () => {
  // CRITICAL precedence: an invitee with no email AND a prior
  // invitation lands in no_contact (first gate fires first). A
  // regression evaluating already-sent first would mis-bucket them
  // into skipped_already_sent and mask the contact-missing signal.
  const audience = mkAudience([
    mkInvitee({
      email: null,
      invitations: [{ channel: "email", status: "sent" }],
    }),
  ]);
  const out = run("email", audience);
  assert.equal(out.buckets.email.no_contact, 1);
  assert.equal(out.buckets.email.skipped_already_sent, 0);
});

// ---- (2) Already-sent detection --------------------------------

test("deriveProposeSendPreview: already-sent EXCLUDES status='failed' (failed attempt allows resend)", () => {
  // The `x.status !== "failed"` predicate is load-bearing. An invitee
  // whose prior attempt failed must get a retry — dropping the filter
  // would paint them as already-sent and silently prevent the retry.
  const audience = mkAudience([
    mkInvitee({
      invitations: [{ channel: "email", status: "failed" }],
    }),
  ]);
  const out = run("email", audience);
  assert.equal(out.buckets.email.ready, 1);
  assert.equal(out.buckets.email.skipped_already_sent, 0);
});

test("deriveProposeSendPreview: already-sent is channel-scoped (email invitation does NOT lock SMS)", () => {
  // Per-channel dedupe: a prior email send doesn't block an SMS
  // send to the same invitee. Merging the three checks into one
  // `invitations.some(x => x.status !== "failed")` would paint
  // everyone with any delivery as already-sent on every channel.
  const audience = mkAudience([
    mkInvitee({
      invitations: [{ channel: "email", status: "sent" }],
    }),
  ]);
  const out = run("sms", audience);
  assert.equal(out.buckets.sms.ready, 1);
  assert.equal(out.buckets.sms.skipped_already_sent, 0);
});

test("deriveProposeSendPreview: onlyUnsent=false disables the skipped_already_sent gate entirely", () => {
  // A full re-send path: operator flips `only_unsent` to false; all
  // prior sends should land in `ready` again. A regression that
  // ignored the flag would keep skipping them, making re-send
  // impossible from the preview surface.
  const audience = mkAudience([
    mkInvitee({
      invitations: [{ channel: "email", status: "sent" }],
    }),
  ]);
  const out = run("email", audience, { onlyUnsent: false });
  assert.equal(out.buckets.email.ready, 1);
  assert.equal(out.buckets.email.skipped_already_sent, 0);
});

// ---- (3) Channel-filter matrix ---------------------------------

test("deriveProposeSendPreview: channel='email' → only emailBucket increments", () => {
  // Scalar email send. sms + whatsapp buckets MUST stay at all-zeros.
  const audience = mkAudience([mkInvitee()]);
  const out = run("email", audience);
  assert.equal(out.buckets.email.ready, 1);
  assert.deepEqual(out.buckets.sms, {
    ready: 0,
    skipped_already_sent: 0,
    skipped_unsubscribed: 0,
    no_contact: 0,
  });
  assert.deepEqual(out.buckets.whatsapp, {
    ready: 0,
    skipped_already_sent: 0,
    skipped_unsubscribed: 0,
    no_contact: 0,
  });
});

test("deriveProposeSendPreview: channel='sms' → only smsBucket increments", () => {
  const audience = mkAudience([mkInvitee()]);
  const out = run("sms", audience);
  assert.equal(out.buckets.sms.ready, 1);
  assert.equal(out.buckets.email.ready, 0);
  assert.equal(out.buckets.whatsapp.ready, 0);
});

test("deriveProposeSendPreview: channel='whatsapp' → only whatsAppBucket increments", () => {
  // Most important scalar case — operator asked for WhatsApp, must
  // NOT see any email/SMS counters moving.
  const audience = mkAudience([mkInvitee()]);
  const out = run("whatsapp", audience);
  assert.equal(out.buckets.whatsapp.ready, 1);
  assert.equal(out.buckets.email.ready, 0);
  assert.equal(out.buckets.sms.ready, 0);
});

test("deriveProposeSendPreview: channel='both' → email + sms increment, whatsapp does NOT", () => {
  // Pre-P13 legacy vocabulary. "both" = email + SMS ONLY; silently
  // widening to include WhatsApp would drift legacy callers.
  const audience = mkAudience([mkInvitee()]);
  const out = run("both", audience);
  assert.equal(out.buckets.email.ready, 1);
  assert.equal(out.buckets.sms.ready, 1);
  assert.equal(out.buckets.whatsapp.ready, 0);
  // whatsapp.no_contact also must stay 0 — the invitee was not
  // "considered" for WhatsApp at all under "both".
  assert.equal(out.buckets.whatsapp.no_contact, 0);
});

test("deriveProposeSendPreview: channel='all' → all three buckets increment", () => {
  // Umbrella channel. All three folds run for each invitee with
  // appropriate contact.
  const audience = mkAudience([mkInvitee()]);
  const out = run("all", audience);
  assert.equal(out.buckets.email.ready, 1);
  assert.equal(out.buckets.sms.ready, 1);
  assert.equal(out.buckets.whatsapp.ready, 1);
});

// ---- (4) Precedence edge cases ---------------------------------

test("deriveProposeSendPreview: when already-sent AND unsubscribed, skipped_already_sent wins (first gate)", () => {
  // An invitee who was both previously-sent and later unsubscribed:
  // the fold should paint them as already-sent (the earlier gate in
  // the chain). Pinning this because a refactor swapping the order
  // would silently re-classify them into skipped_unsubscribed —
  // which would then fold into a different summary-line counter and
  // mislead the operator about the REASON for the skip.
  const audience = mkAudience(
    [
      mkInvitee({
        email: "bob@example.com",
        invitations: [{ channel: "email", status: "sent" }],
      }),
    ],
    { unsubEmails: new Set(["bob@example.com"]) },
  );
  const out = run("email", audience);
  assert.equal(out.buckets.email.skipped_already_sent, 1);
  assert.equal(out.buckets.email.skipped_unsubscribed, 0);
});

test("deriveProposeSendPreview: WhatsApp uses unsubPhones (shared with SMS) — SMS-channel unsub blocks WhatsApp too", () => {
  // The Unsubscribe table has no per-channel discriminator for
  // phones; a recipient who STOP-replied to an SMS is treated as
  // unsubscribed for WhatsApp too. Conservative default: don't
  // switch channels to bypass the opt-out.
  const audience = mkAudience(
    [mkInvitee({ phoneE164: "+15559999999" })],
    { unsubPhones: new Set(["+15559999999"]) },
  );
  const out = run("whatsapp", audience);
  assert.equal(out.buckets.whatsapp.skipped_unsubscribed, 1);
  assert.equal(out.buckets.whatsapp.ready, 0);
});

// ---- (5) readyMessages sum -------------------------------------

test("deriveProposeSendPreview: readyMessages = email.ready + sms.ready + whatsapp.ready (3-way sum)", () => {
  // THE regression vector for the sum. A drop of the whatsapp term
  // silently under-counts on "whatsapp" / "all" sends.
  const audience = mkAudience([
    mkInvitee({ email: "a@x.com", phoneE164: "+15550000001" }),
    mkInvitee({ email: "b@x.com", phoneE164: "+15550000002" }),
    mkInvitee({ email: "c@x.com", phoneE164: "+15550000003" }),
  ]);
  const out = run("all", audience);
  assert.equal(out.buckets.email.ready, 3);
  assert.equal(out.buckets.sms.ready, 3);
  assert.equal(out.buckets.whatsapp.ready, 3);
  assert.equal(out.readyMessages, 9);
});

test("deriveProposeSendPreview: readyMessages is 0 when nobody is reachable", () => {
  // Pathological but valid. All three buckets stay at zero ready,
  // readyMessages is the sum = 0.
  const audience = mkAudience([
    mkInvitee({ email: null, phoneE164: null }),
  ]);
  const out = run("all", audience);
  assert.equal(out.readyMessages, 0);
  assert.equal(out.buckets.email.no_contact, 1);
  assert.equal(out.buckets.sms.no_contact, 1);
  assert.equal(out.buckets.whatsapp.no_contact, 1);
});

test("deriveProposeSendPreview: readyMessages is a JOB count — invitee with full contact on channel=all contributes 3", () => {
  // One invitee, one head, but three JOBS (email, sms, whatsapp) on
  // channel=all. Pinning the distinction so a refactor that rebrands
  // `readyMessages` as a recipient count doesn't silently halve the
  // operator-facing number on umbrella sends. Matches the planner's
  // per-(invitee, channel) job enumeration in sendCampaign.
  const audience = mkAudience([mkInvitee()]);
  const out = run("all", audience);
  assert.equal(out.readyMessages, 3);
  assert.equal(out.inviteeCount, 1);
});

// ---- (6) inviteeCount ------------------------------------------

test("deriveProposeSendPreview: inviteeCount equals audience.invitees.length (head count, not job count)", () => {
  // Pinning the distinction: inviteeCount is the HEAD count,
  // readyMessages is the JOB count. Mixing them up is a named
  // historical bug (the old `ready_total` label collapsed the two).
  const audience = mkAudience([
    mkInvitee({ email: "a@x.com" }),
    mkInvitee({ email: "b@x.com" }),
    mkInvitee({ email: "c@x.com", phoneE164: null }),
  ]);
  const out = run("email", audience);
  assert.equal(out.inviteeCount, 3);
  assert.equal(out.readyMessages, 3); // Same number here because each
  // contributes 1 job on the email channel; but on channel=all the
  // invitee with null phone would contribute only 1, not 3.
});

// ---- (7) Summary lines -----------------------------------------

test("deriveProposeSendPreview: first summary line has the exact pinned format", () => {
  // The first line is consumed verbatim by the AI transcript. Its
  // shape is "Propose send for "<name>" [<status>]: channel=<ch>,
  // only_unsent=<bool>." A drift here (add a trailing space, change
  // bracket to paren, etc.) would propagate to every logged send
  // proposal.
  const audience = mkAudience([mkInvitee()]);
  const out = run("email", audience, {
    campaignName: "Alice & Bob's Wedding",
    campaignStatus: "draft",
    onlyUnsent: false,
  });
  assert.equal(
    out.summaryLines[0],
    `Propose send for "Alice & Bob's Wedding" [draft]: channel=email, only_unsent=false.`,
  );
});

test("deriveProposeSendPreview: readyParts filter matches channel set — scalar 'whatsapp' emits only 'whatsapp N'", () => {
  // The readyParts filter mirrors the channel gate. A bug that
  // always emits all three parts on any channel would paint
  // "(email 0, sms 0, whatsapp 3)" on a scalar whatsapp preview —
  // misleading the operator about which channels were considered.
  const audience = mkAudience([mkInvitee()]);
  const out = run("whatsapp", audience);
  // Second line is the "N invitees; M messages" line.
  assert.match(out.summaryLines[1]!, /\(whatsapp 1\)\.$/);
  assert.ok(
    !out.summaryLines[1]!.includes("email 0"),
    `scalar 'whatsapp' must not mention email, got: ${out.summaryLines[1]}`,
  );
  assert.ok(
    !out.summaryLines[1]!.includes("sms 0"),
    `scalar 'whatsapp' must not mention sms, got: ${out.summaryLines[1]}`,
  );
});

test("deriveProposeSendPreview: readyParts on channel='all' emits all three parts in email → sms → whatsapp order", () => {
  // Umbrella channel. Insertion order matters because the summary
  // is a human-readable string and operators visually parse it
  // left-to-right.
  const audience = mkAudience([mkInvitee()]);
  const out = run("all", audience);
  assert.match(out.summaryLines[1]!, /\(email 1, sms 1, whatsapp 1\)\.$/);
});

test("deriveProposeSendPreview: pluralization — invitee singular at 1, plural elsewhere", () => {
  // The "N invitee(s); M message(s)" line uses N===1 ? "" : "s" for
  // both nouns independently. Pinning both branches because the
  // English rule is "0 invitees" is plural too.
  const one = run("email", mkAudience([mkInvitee()]));
  assert.match(one.summaryLines[1]!, /^1 invitee; /);

  const zero = run("email", mkAudience([]));
  assert.match(zero.summaryLines[1]!, /^0 invitees; /);

  const many = run(
    "email",
    mkAudience([
      mkInvitee({ email: "a@x.com" }),
      mkInvitee({ email: "b@x.com" }),
    ]),
  );
  assert.match(many.summaryLines[1]!, /^2 invitees; /);
});

test("deriveProposeSendPreview: no Skipped line when skipped counters are all 0", () => {
  // A clean preview with no skips shouldn't emit "Skipped: already-
  // sent 0, unsubscribed 0." noise. The conditional `> 0` gate
  // matters — dropping it would paint noise on every success.
  const audience = mkAudience([mkInvitee()]);
  const out = run("email", audience);
  const skippedLines = out.summaryLines.filter((l) =>
    l.startsWith("Skipped:"),
  );
  assert.equal(skippedLines.length, 0);
});

test("deriveProposeSendPreview: one Skipped line when totals > 0 with exact 'already-sent X, unsubscribed Y' format", () => {
  // Mixed skips. Pinning the exact string because it's consumed by
  // the AI transcript and a drift would affect every analytics
  // query that greps for this prefix.
  const audience = mkAudience(
    [
      mkInvitee({
        email: "a@x.com",
        invitations: [{ channel: "email", status: "sent" }],
      }),
      mkInvitee({ email: "b@x.com" }),
    ],
    { unsubEmails: new Set(["b@x.com"]) },
  );
  const out = run("email", audience);
  const skippedLines = out.summaryLines.filter((l) =>
    l.startsWith("Skipped:"),
  );
  assert.deepEqual(skippedLines, [
    "Skipped: already-sent 1, unsubscribed 1.",
  ]);
});

test("deriveProposeSendPreview: Blockers line emitted only when blockers.length > 0, with joined codes", () => {
  // Mirror of the Skipped conditional. Two-blocker case pins the
  // join separator (", ") and order preservation.
  const audience = mkAudience([mkInvitee()]);
  const noBlockers = run("email", audience, { blockers: [] });
  assert.ok(
    !noBlockers.summaryLines.some((l) => l.startsWith("Blockers:")),
    "empty blockers must NOT emit a Blockers line",
  );

  const withBlockers = run("email", audience, {
    blockers: ["no_email_template", "status_locked:closed"],
  });
  const blockerLines = withBlockers.summaryLines.filter((l) =>
    l.startsWith("Blockers:"),
  );
  assert.deepEqual(blockerLines, [
    "Blockers: no_email_template, status_locked:closed.",
  ]);
});

test("deriveProposeSendPreview: ConfirmSend tail line is ALWAYS emitted (last line)", () => {
  // The pointer the model reads to know this is a propose, not a
  // send. Must appear on every successful derivation — empty
  // blockers, zero audience, all paths — and always as the final
  // line so downstream consumers (e.g. future UI) can find it
  // structurally.
  const audience = mkAudience([]);
  const out = run("email", audience, { blockers: ["no_invitees"] });
  assert.equal(
    out.summaryLines[out.summaryLines.length - 1],
    `A ConfirmSend card has been rendered. The operator must click Confirm to actually send — this tool does not send.`,
  );
});

// ---- (8) state ternary -----------------------------------------

test("deriveProposeSendPreview: state='ready' when blockers is empty", () => {
  const audience = mkAudience([mkInvitee()]);
  const out = run("email", audience, { blockers: [] });
  assert.equal(out.state, "ready");
});

test("deriveProposeSendPreview: state='blocked' when any blocker is present", () => {
  // Pinning the ternary direction. A single-character flip
  // (`< 0` → `> 0` or `===` → `!==`) would paint the confirm button
  // active on a blocked preview — the exact trust hole the
  // confirmation gate exists to close.
  const audience = mkAudience([mkInvitee()]);
  const out = run("email", audience, { blockers: ["no_email_template"] });
  assert.equal(out.state, "blocked");
});

// ---- (9) Summary join + shape drift guard ----------------------

test("deriveProposeSendPreview: summary joins summaryLines with newline (NOT space)", () => {
  // propose_send historically joined with "\n" — this is
  // INTENTIONALLY different from P14-D' (send-campaign-summary)
  // which joins with " ". Two different transcripts with two
  // different shape contracts. A careless "harmonize" refactor
  // would drift one of them.
  const audience = mkAudience([mkInvitee()]);
  const out = run("email", audience);
  assert.equal(out.summary, out.summaryLines.join("\n"));
  assert.ok(
    out.summary.includes("\n"),
    "summary must contain a newline between lines",
  );
});

test("deriveProposeSendPreview: returns EXACTLY buckets, readyMessages, inviteeCount, summaryLines, summary, state", () => {
  // Output shape drift guard. A new field forces a conscious test
  // update (and a paired handler update so the widget envelope
  // reads the new field).
  const audience = mkAudience([mkInvitee()]);
  const out = run("email", audience);
  const keys = Object.keys(out).sort();
  assert.deepEqual(keys, [
    "buckets",
    "inviteeCount",
    "readyMessages",
    "state",
    "summary",
    "summaryLines",
  ]);
});

test("deriveProposeSendPreview: buckets shape has EXACTLY email, sms, whatsapp", () => {
  // Sub-shape pin. If a fourth channel is added the widget
  // validator would need to know about it — this test fires first.
  const audience = mkAudience([mkInvitee()]);
  const out = run("email", audience);
  const keys = Object.keys(out.buckets).sort();
  assert.deepEqual(keys, ["email", "sms", "whatsapp"]);
});
