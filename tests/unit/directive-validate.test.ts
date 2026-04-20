import { test } from "node:test";
import assert from "node:assert/strict";

import { validateDirective } from "../../src/lib/ai/directive-validate";

// Guards the Push 11 server-side validate-per-kind contract.
//
// The producer tools (six of them — see the registry list in
// `src/lib/ai/directive-validate.ts`) emit `directive: {kind, props}`
// objects whose `props` is read by a matching client-side renderer
// in `src/components/chat/directives/`. The renderer does a
// type-erasing `as unknown as XProps` cast at the registry boundary,
// so at runtime any shape-drift between producer and consumer paints
// a broken card with zero TypeScript say-so. This module pins the
// shape at the persistence boundary (chat route, before DB write
// and SSE emit) so:
//
//   (a) A regression in a tool handler that silently drops a field
//       can't reach the DB — the tests below pick it up at commit
//       time (each happy-path test doubles as a shape-snapshot of
//       the handler contract).
//   (b) A future replay/load-history path that hydrates stored
//       JSON gets the same guarantees: the validator is pure and
//       can be reused verbatim on read.
//   (c) The closed registry stays closed — unknown kinds never land
//       in `renderDirective` and can't be smuggled to the client.
//
// Test strategy:
//   - One happy-path per kind with the MINIMUM fields that match
//     the current producer shape. Doubles as living documentation
//     of what the validator accepts.
//   - Envelope-level rejections: non-object input, missing kind,
//     missing props, unknown kind.
//   - Per-kind rejections: one representative shape violation per
//     kind that the corresponding renderer would paint incorrectly.
//   - Present-but-wrong-type-optional rejections: documenting that
//     the validator does NOT tolerate garbage in optional fields.

test("validateDirective: rejects non-object input", () => {
  assert.equal(validateDirective(null), null);
  assert.equal(validateDirective(undefined), null);
  assert.equal(validateDirective("directive"), null);
  assert.equal(validateDirective(42), null);
  assert.equal(validateDirective([]), null);
});

test("validateDirective: rejects missing or malformed envelope", () => {
  assert.equal(validateDirective({}), null);
  assert.equal(validateDirective({ kind: "campaign_list" }), null); // no props
  assert.equal(validateDirective({ props: { items: [] } }), null); // no kind
  assert.equal(
    validateDirective({ kind: 42, props: {} }),
    null,
    "numeric kind",
  );
  assert.equal(
    validateDirective({ kind: "campaign_list", props: "oops" }),
    null,
    "string props",
  );
  assert.equal(
    validateDirective({ kind: "campaign_list", props: null }),
    null,
    "null props",
  );
});

test("validateDirective: rejects unknown kind", () => {
  // An unknown kind would otherwise be silent-dropped client-side.
  // Server-side we refuse the write entirely — keeps the DB clean
  // and closes the "forge a directive by adding a new kind" gap.
  assert.equal(
    validateDirective({ kind: "some_future_kind", props: {} }),
    null,
  );
});

// ---- campaign_list ----

test("validateDirective: campaign_list — valid shape round-trips", () => {
  const d = {
    kind: "campaign_list",
    props: {
      items: [
        {
          id: "c-1",
          name: "Eid reception",
          status: "active",
          event_at: "2026-04-19T18:00:00Z",
          venue: "Palace A",
          team_id: null,
          stats: { total: 100, responded: 40, headcount: 55 },
        },
      ],
      filters: {
        status: ["active"],
        upcoming_only: true,
        limit: 20,
      },
    },
  };
  const out = validateDirective(d);
  assert.ok(out);
  assert.equal(out?.kind, "campaign_list");
  // Identity preserved — we validate, we don't rewrite.
  assert.equal(out?.props, d.props);
});

test("validateDirective: campaign_list — rejects item missing stats", () => {
  const d = {
    kind: "campaign_list",
    props: {
      items: [
        {
          id: "c-1",
          name: "Eid reception",
          status: "active",
          event_at: null,
          venue: null,
          team_id: null,
          // stats missing — renderer would throw on s.total access
        },
      ],
    },
  };
  assert.equal(validateDirective(d), null);
});

test("validateDirective: campaign_list — rejects non-number stats field", () => {
  const d = {
    kind: "campaign_list",
    props: {
      items: [
        {
          id: "c-1",
          name: "x",
          status: "draft",
          event_at: null,
          venue: null,
          team_id: null,
          // responded as string — Intl formatters will paint "NaN/40"
          stats: { total: 40, responded: "40" as unknown, headcount: 0 },
        },
      ],
    },
  };
  assert.equal(validateDirective(d), null);
});

// ---- campaign_card ----

test("validateDirective: campaign_card — valid shape round-trips", () => {
  const d = {
    kind: "campaign_card",
    props: {
      id: "c-1",
      name: "Eid reception",
      description: null,
      status: "active",
      event_at: null,
      venue: null,
      locale: "en",
      team_id: null,
      created_at: "2026-04-10T00:00:00Z",
      updated_at: "2026-04-11T00:00:00Z",
      stats: {
        total: 100,
        responded: 40,
        pending: 60,
        attending: 35,
        declined: 5,
        guests: 10,
        headcount: 55,
        sentEmail: 95,
        sentSms: 40,
      },
      activity: [
        {
          id: "e-1",
          created_at: "2026-04-11T10:00:00Z",
          kind: "invite.sent",
          tone: "success",
          line: "Invitations sent.",
        },
      ],
      invitee_scan_capped: false,
    },
  };
  const out = validateDirective(d);
  assert.ok(out);
  assert.equal(out?.kind, "campaign_card");
});

test("validateDirective: campaign_card — rejects incomplete stats", () => {
  const d = {
    kind: "campaign_card",
    props: {
      id: "c-1",
      name: "x",
      description: null,
      status: "draft",
      event_at: null,
      venue: null,
      locale: null,
      team_id: null,
      created_at: "2026-04-10T00:00:00Z",
      updated_at: "2026-04-10T00:00:00Z",
      // Missing sentSms — the detail card reads it and would paint "NaN".
      stats: {
        total: 0,
        responded: 0,
        pending: 0,
        attending: 0,
        declined: 0,
        guests: 0,
        headcount: 0,
        sentEmail: 0,
      },
      activity: [],
    },
  };
  assert.equal(validateDirective(d), null);
});

test("validateDirective: campaign_card — rejects unknown tone in activity", () => {
  // TONE_DOT in the renderer falls back on default, but the whitelist
  // here is stricter — a new tone means the renderer and validator
  // must both be updated together.
  const d = {
    kind: "campaign_card",
    props: {
      id: "c-1",
      name: "x",
      description: null,
      status: "draft",
      event_at: null,
      venue: null,
      locale: null,
      team_id: null,
      created_at: "2026-04-10T00:00:00Z",
      updated_at: "2026-04-10T00:00:00Z",
      stats: {
        total: 0, responded: 0, pending: 0, attending: 0, declined: 0,
        guests: 0, headcount: 0, sentEmail: 0, sentSms: 0,
      },
      activity: [
        {
          id: "e-1",
          created_at: "2026-04-11T10:00:00Z",
          kind: "invite.sent",
          tone: "chartreuse" as unknown as "success", // not in TONES
          line: "odd one out",
        },
      ],
    },
  };
  assert.equal(validateDirective(d), null);
});

// ---- contact_table ----

test("validateDirective: contact_table — valid shape round-trips", () => {
  const d = {
    kind: "contact_table",
    props: {
      items: [
        {
          id: "k-1",
          full_name: "Princess X",
          title: null,
          organization: null,
          email: "px@example.sa",
          phone_e164: null,
          vip_tier: "royal",
          vip_label: "Royal",
          tags: null,
          archived_at: null,
          invitee_count: 3,
        },
      ],
      total: 1,
      filters: {
        query: "prin",
        tier: "royal",
        include_archived: false,
        limit: 20,
      },
    },
  };
  const out = validateDirective(d);
  assert.ok(out);
});

test("validateDirective: contact_table — rejects unknown vip_tier", () => {
  const d = {
    kind: "contact_table",
    props: {
      items: [
        {
          id: "k-1",
          full_name: "X",
          title: null,
          organization: null,
          email: null,
          phone_e164: null,
          vip_tier: "emperor" as unknown as "royal", // not in VIP_TIERS
          vip_label: "Emperor",
          tags: null,
          archived_at: null,
          invitee_count: 0,
        },
      ],
      total: 1,
    },
  };
  assert.equal(validateDirective(d), null);
});

// ---- activity_stream ----

test("validateDirective: activity_stream — valid shape round-trips", () => {
  const d = {
    kind: "activity_stream",
    props: {
      items: [
        {
          id: "e-1",
          created_at: "2026-04-11T10:00:00Z",
          kind: "invite.sent",
          ref_type: "campaign",
          ref_id: "c-1",
          tone: "success",
          line: "Invitations sent.",
          actor: { email: "op@example.sa", full_name: "Operator" },
        },
        {
          // actor may be null
          id: "e-2",
          created_at: "2026-04-11T11:00:00Z",
          kind: "login",
          ref_type: null,
          ref_id: null,
          tone: "default",
          line: "Login.",
          actor: null,
        },
      ],
      filters: { days: 7, limit: 20 },
    },
  };
  const out = validateDirective(d);
  assert.ok(out);
});

test("validateDirective: activity_stream — rejects malformed actor", () => {
  const d = {
    kind: "activity_stream",
    props: {
      items: [
        {
          id: "e-1",
          created_at: "2026-04-11T10:00:00Z",
          kind: "login",
          ref_type: null,
          ref_id: null,
          tone: "default",
          line: "x",
          // actor is present but not null AND not the expected object
          actor: "op@example.sa" as unknown as null,
        },
      ],
    },
  };
  assert.equal(validateDirective(d), null);
});

// ---- confirm_draft ----

test("validateDirective: confirm_draft — valid shape round-trips", () => {
  const d = {
    kind: "confirm_draft",
    props: {
      id: "c-1",
      name: "New draft",
      description: null,
      venue: null,
      event_at: null,
      locale: "en",
      status: "draft",
      team_id: null,
      created_at: "2026-04-19T00:00:00Z",
      event_at_ignored: false,
    },
  };
  const out = validateDirective(d);
  assert.ok(out);
});

test("validateDirective: confirm_draft — rejects missing locale (required)", () => {
  const d = {
    kind: "confirm_draft",
    props: {
      id: "c-1",
      name: "x",
      description: null,
      venue: null,
      event_at: null,
      // locale missing — renderer's formatEventAt would still tolerate it,
      // but the ConfirmDraftProps type says it's required, so the
      // contract demands it.
      status: "draft",
      team_id: null,
      created_at: "2026-04-19T00:00:00Z",
    },
  };
  assert.equal(validateDirective(d), null);
});

test("validateDirective: confirm_draft — rejects present-but-wrong-type optional", () => {
  const d = {
    kind: "confirm_draft",
    props: {
      id: "c-1",
      name: "x",
      description: null,
      venue: null,
      event_at: null,
      locale: "en",
      status: "draft",
      team_id: null,
      created_at: "2026-04-19T00:00:00Z",
      event_at_ignored: "yes" as unknown as boolean, // present but not bool
    },
  };
  assert.equal(validateDirective(d), null);
});

// ---- confirm_send ----

test("validateDirective: confirm_send — valid shape round-trips", () => {
  const d = {
    kind: "confirm_send",
    props: {
      campaign_id: "c-1",
      name: "Eid reception",
      status: "active",
      venue: null,
      event_at: null,
      locale: "en",
      channel: "both",
      only_unsent: true,
      invitee_total: 40,
      ready_messages: 72,
      by_channel: {
        email: {
          ready: 40,
          skipped_already_sent: 0,
          skipped_unsubscribed: 0,
          no_contact: 0,
        },
        sms: {
          ready: 32,
          skipped_already_sent: 0,
          skipped_unsubscribed: 0,
          no_contact: 8,
        },
        whatsapp: {
          ready: 0,
          skipped_already_sent: 0,
          skipped_unsubscribed: 0,
          no_contact: 0,
        },
      },
      template_preview: {
        subject_email: "Invitation",
        email_body: "Body...",
        sms_body: null,
        whatsapp_template: null,
      },
      blockers: [],
    },
  };
  const out = validateDirective(d);
  assert.ok(out);
});

test("validateDirective: confirm_send — rejects unknown channel", () => {
  const d = {
    kind: "confirm_send",
    props: {
      campaign_id: "c-1",
      name: "x",
      status: "active",
      venue: null,
      event_at: null,
      locale: "en",
      channel: "carrier-pigeon" as unknown as "both", // not in CHANNELS
      only_unsent: true,
      invitee_total: 0,
      ready_messages: 0,
      by_channel: {
        email: { ready: 0, skipped_already_sent: 0, skipped_unsubscribed: 0, no_contact: 0 },
        sms: { ready: 0, skipped_already_sent: 0, skipped_unsubscribed: 0, no_contact: 0 },
        whatsapp: { ready: 0, skipped_already_sent: 0, skipped_unsubscribed: 0, no_contact: 0 },
      },
      template_preview: {
        subject_email: null,
        email_body: null,
        sms_body: null,
        whatsapp_template: null,
      },
      blockers: [],
    },
  };
  assert.equal(validateDirective(d), null);
});

test("validateDirective: confirm_send — rejects non-string-array blockers", () => {
  // ConfirmSend renders blockers as a list; a non-string-array here
  // means `.map((b) => <li key={b}>{formatBlocker(b)}</li>)` paints
  // `[object Object]`. The renderer trusts the shape, so we enforce it.
  const d = {
    kind: "confirm_send",
    props: {
      campaign_id: "c-1",
      name: "x",
      status: "draft",
      venue: null,
      event_at: null,
      locale: "en",
      channel: "email",
      only_unsent: true,
      invitee_total: 1,
      ready_messages: 1,
      by_channel: {
        email: { ready: 1, skipped_already_sent: 0, skipped_unsubscribed: 0, no_contact: 0 },
        sms: { ready: 0, skipped_already_sent: 0, skipped_unsubscribed: 0, no_contact: 0 },
        whatsapp: { ready: 0, skipped_already_sent: 0, skipped_unsubscribed: 0, no_contact: 0 },
      },
      template_preview: {
        subject_email: "s",
        email_body: "b",
        sms_body: null,
        whatsapp_template: null,
      },
      blockers: [{ code: "no_invitees" }] as unknown as string[],
    },
  };
  assert.equal(validateDirective(d), null);
});

test("validateDirective: confirm_send — rejects incomplete by_channel breakdown", () => {
  const d = {
    kind: "confirm_send",
    props: {
      campaign_id: "c-1",
      name: "x",
      status: "draft",
      venue: null,
      event_at: null,
      locale: "en",
      channel: "both",
      only_unsent: true,
      invitee_total: 1,
      ready_messages: 1,
      by_channel: {
        email: { ready: 1, skipped_already_sent: 0, skipped_unsubscribed: 0 }, // no_contact missing
        sms: { ready: 0, skipped_already_sent: 0, skipped_unsubscribed: 0, no_contact: 0 },
        whatsapp: { ready: 0, skipped_already_sent: 0, skipped_unsubscribed: 0, no_contact: 0 },
      },
      template_preview: {
        subject_email: null,
        email_body: null,
        sms_body: null,
        whatsapp_template: null,
      },
      blockers: [],
    },
  };
  assert.equal(validateDirective(d), null);
});

// ---- P13-D.2: WhatsApp channel + shape widening ----
//
// Directive shape mirrors widget shape; the gates are independent
// (on purpose — see the header comments in widget-validate.ts and
// directive-validate.ts). Each new invariant gets its own pin here
// so a future refactor that drifts the two validators apart gets
// caught on first drift, not when an operator sees a blank card.

function baseConfirmSendDirective() {
  return {
    kind: "confirm_send",
    props: {
      campaign_id: "c-1",
      name: "Eid",
      status: "active",
      venue: null,
      event_at: null,
      locale: "en",
      channel: "all",
      only_unsent: true,
      invitee_total: 1,
      ready_messages: 3,
      by_channel: {
        email: { ready: 1, skipped_already_sent: 0, skipped_unsubscribed: 0, no_contact: 0 },
        sms: { ready: 1, skipped_already_sent: 0, skipped_unsubscribed: 0, no_contact: 0 },
        whatsapp: { ready: 1, skipped_already_sent: 0, skipped_unsubscribed: 0, no_contact: 0 },
      },
      template_preview: {
        subject_email: "s",
        email_body: "b",
        sms_body: "s",
        whatsapp_template: { name: "rsvp_v1", language: "ar" },
      },
      blockers: [],
    },
  };
}

test("validateDirective: confirm_send — accepts channel: whatsapp", () => {
  const d = baseConfirmSendDirective();
  d.props.channel = "whatsapp";
  assert.ok(validateDirective(d));
});

test("validateDirective: confirm_send — accepts channel: all", () => {
  // The full "all" shape — WA template populated, every per-channel
  // bucket carrying ready counts. This is the canonical green-path
  // directive for a post-P13 send.
  assert.ok(validateDirective(baseConfirmSendDirective()));
});

test("validateDirective: confirm_send — rejects missing by_channel.whatsapp", () => {
  const d = baseConfirmSendDirective();
  const bc = d.props.by_channel as Record<string, unknown>;
  delete bc.whatsapp;
  assert.equal(validateDirective(d), null);
});

test("validateDirective: confirm_send — rejects missing template_preview.whatsapp_template", () => {
  const d = baseConfirmSendDirective();
  const tp = d.props.template_preview as Record<string, unknown>;
  delete tp.whatsapp_template;
  assert.equal(validateDirective(d), null);
});

test("validateDirective: confirm_send — rejects whatsapp_template missing language", () => {
  const d = baseConfirmSendDirective();
  d.props.template_preview.whatsapp_template = { name: "x" } as unknown as {
    name: string;
    language: string;
  };
  assert.equal(validateDirective(d), null);
});

test("validateDirective: confirm_send — rejects whatsapp_template empty name", () => {
  const d = baseConfirmSendDirective();
  d.props.template_preview.whatsapp_template = { name: "", language: "ar" };
  assert.equal(validateDirective(d), null);
});

test("validateDirective: confirm_send — rejects whatsapp_template non-object", () => {
  // String / number / true would pass a shallow `!= null` guard but
  // not the object-shape check. Covering this pins the branching in
  // `validateWhatsAppTemplateLabel`.
  const d = baseConfirmSendDirective();
  (d.props.template_preview as Record<string, unknown>).whatsapp_template =
    "rsvp_v1:ar";
  assert.equal(validateDirective(d), null);
});
