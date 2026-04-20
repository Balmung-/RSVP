import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeBlockers,
  type Audience,
  type CampaignForBlockers,
  type InviteeForAudience,
} from "../../src/lib/ai/tools/send-blockers";

// P13-D.1 — WhatsApp blocker vocabulary.
//
// computeBlockers is the shared truth for the propose_send →
// ConfirmSend → send_campaign path. P13-C widened the runtime
// orchestrators to dispatch WhatsApp; this slice adds the matching
// blocker so an operator who picks a WhatsApp channel against an
// unconfigured campaign sees the problem in the ConfirmSend card
// (client-side disable) AND gets refused at confirm time
// (server-side re-check), rather than getting a wall of failed
// Invitation rows after clicking.
//
// The existing email/SMS blockers are out of scope — they have
// their own coverage in the propose_send / send_campaign tests
// already. This file focuses on the new discriminators:
//
//   - `no_whatsapp_template` when channel set includes whatsapp
//     and either `templateWhatsAppName` or `templateWhatsAppLanguage`
//     is missing / empty
//   - `no_ready_messages` correctly counts a WhatsApp-ready
//     invitee (has phoneE164, not unsubscribed, not already sent)
//   - phone-channel unsubscribe is shared between SMS and WhatsApp
//   - the `"all"` umbrella and scalar `"whatsapp"` both trigger
//     WhatsApp checks; `"both"` does not (pre-P13 invariant)

// ---- Fixtures ---------------------------------------------------

function mkCampaign(
  overrides: Partial<CampaignForBlockers> = {},
): CampaignForBlockers {
  return {
    status: "active",
    templateEmail: "Hi {{name}}",
    templateSms: "Hi {{name}}, RSVP at {{rsvpUrl}}",
    templateWhatsAppName: "rsvp_invitation_v1",
    templateWhatsAppLanguage: "ar",
    ...overrides,
  };
}

function mkInvitee(
  overrides: Partial<InviteeForAudience> = {},
): InviteeForAudience {
  return {
    email: "a@example.com",
    phoneE164: "+966500000001",
    invitations: [],
    ...overrides,
  };
}

function mkAudience(
  overrides: Partial<Audience> = {},
): Audience {
  return {
    invitees: [mkInvitee()],
    unsubEmails: new Set<string>(),
    unsubPhones: new Set<string>(),
    ...overrides,
  };
}

// ---- no_whatsapp_template emission ------------------------------

test("whatsapp scalar: both template fields set → no blocker", () => {
  const blockers = computeBlockers({
    campaign: mkCampaign(),
    audience: mkAudience(),
    channel: "whatsapp",
    onlyUnsent: true,
  });
  assert.deepEqual(blockers, []);
});

test("whatsapp scalar: templateWhatsAppName null → no_whatsapp_template", () => {
  const blockers = computeBlockers({
    campaign: mkCampaign({ templateWhatsAppName: null }),
    audience: mkAudience(),
    channel: "whatsapp",
    onlyUnsent: true,
  });
  assert.ok(blockers.includes("no_whatsapp_template"));
});

test("whatsapp scalar: templateWhatsAppLanguage null → no_whatsapp_template", () => {
  // Meta requires (name, language) as an identity pair — a name
  // without a language can't be resolved to an approved template.
  // Missing either field is a blocker.
  const blockers = computeBlockers({
    campaign: mkCampaign({ templateWhatsAppLanguage: null }),
    audience: mkAudience(),
    channel: "whatsapp",
    onlyUnsent: true,
  });
  assert.ok(blockers.includes("no_whatsapp_template"));
});

test("whatsapp scalar: empty-string template fields are treated as unconfigured", () => {
  // Matches `decideWhatsAppMessage`'s guard: `length > 0` on both.
  // A saved empty string from a cleared form field must surface the
  // same blocker as null.
  const blockers = computeBlockers({
    campaign: mkCampaign({ templateWhatsAppName: "" }),
    audience: mkAudience(),
    channel: "whatsapp",
    onlyUnsent: true,
  });
  assert.ok(blockers.includes("no_whatsapp_template"));
});

// ---- "all" and "both" channel-set differences -------------------

test("all umbrella: includes no_whatsapp_template when WA template missing", () => {
  // "all" = email + sms + whatsapp. Every per-channel template
  // missing surfaces its own blocker. The operator sees the full
  // list, not just the first one.
  const blockers = computeBlockers({
    campaign: mkCampaign({
      templateWhatsAppName: null,
      templateWhatsAppLanguage: null,
    }),
    audience: mkAudience(),
    channel: "all",
    onlyUnsent: true,
  });
  assert.ok(blockers.includes("no_whatsapp_template"));
});

test("both umbrella: does NOT emit no_whatsapp_template (pre-P13 invariant)", () => {
  // "both" preserved as email + SMS ONLY. A campaign without WA
  // configured but targeting "both" should NOT flag WhatsApp —
  // WhatsApp isn't wanted. The load-bearing invariant of P13-C
  // carries forward to the blocker layer here.
  const blockers = computeBlockers({
    campaign: mkCampaign({
      templateWhatsAppName: null,
      templateWhatsAppLanguage: null,
    }),
    audience: mkAudience(),
    channel: "both",
    onlyUnsent: true,
  });
  assert.equal(blockers.includes("no_whatsapp_template"), false);
});

test("email scalar: does NOT emit no_whatsapp_template", () => {
  // Scalar channels only check their own template. An email-only
  // send against an unconfigured WA campaign is perfectly valid.
  const blockers = computeBlockers({
    campaign: mkCampaign({
      templateWhatsAppName: null,
      templateWhatsAppLanguage: null,
    }),
    audience: mkAudience(),
    channel: "email",
    onlyUnsent: true,
  });
  assert.equal(blockers.includes("no_whatsapp_template"), false);
});

// ---- hasReadyMessage: WhatsApp path -----------------------------

test("whatsapp ready: invitee with phone, no prior WA invitation → no no_ready_messages", () => {
  const blockers = computeBlockers({
    campaign: mkCampaign(),
    audience: mkAudience({
      invitees: [mkInvitee({ email: null, phoneE164: "+966500000009" })],
    }),
    channel: "whatsapp",
    onlyUnsent: true,
  });
  assert.equal(blockers.includes("no_ready_messages"), false);
});

test("whatsapp ready: invitee with no phone → no_ready_messages", () => {
  const blockers = computeBlockers({
    campaign: mkCampaign(),
    audience: mkAudience({
      invitees: [mkInvitee({ phoneE164: null })],
    }),
    channel: "whatsapp",
    onlyUnsent: true,
  });
  assert.ok(blockers.includes("no_ready_messages"));
});

test("whatsapp ready: prior successful WA invitation + onlyUnsent=true → no_ready_messages", () => {
  const blockers = computeBlockers({
    campaign: mkCampaign(),
    audience: mkAudience({
      invitees: [
        mkInvitee({
          invitations: [{ channel: "whatsapp", status: "sent" }],
        }),
      ],
    }),
    channel: "whatsapp",
    onlyUnsent: true,
  });
  assert.ok(blockers.includes("no_ready_messages"));
});

test("whatsapp ready: prior FAILED WA invitation does not block (retry is valid)", () => {
  // A failed prior attempt is not a successful send — the operator
  // retrying is legitimate. hasReadyMessage's `status !== "failed"`
  // guard means the failed row doesn't count as "already sent".
  const blockers = computeBlockers({
    campaign: mkCampaign(),
    audience: mkAudience({
      invitees: [
        mkInvitee({
          invitations: [{ channel: "whatsapp", status: "failed" }],
        }),
      ],
    }),
    channel: "whatsapp",
    onlyUnsent: true,
  });
  assert.equal(blockers.includes("no_ready_messages"), false);
});

test("whatsapp ready: prior successful + onlyUnsent=false → still ready (force re-send)", () => {
  const blockers = computeBlockers({
    campaign: mkCampaign(),
    audience: mkAudience({
      invitees: [
        mkInvitee({
          invitations: [{ channel: "whatsapp", status: "sent" }],
        }),
      ],
    }),
    channel: "whatsapp",
    onlyUnsent: false,
  });
  assert.equal(blockers.includes("no_ready_messages"), false);
});

// ---- Shared phone-unsubscribe discipline -------------------------

test("whatsapp ready: unsubscribed phone blocks both SMS and WhatsApp", () => {
  // The Unsubscribe table has one `phoneE164` column without a
  // channel discriminator. A recipient who STOP'd via SMS must
  // not be switched to WhatsApp — same phone, same opt-out. The
  // helper treats unsubPhones as a shared set for both channels.
  const blockers = computeBlockers({
    campaign: mkCampaign(),
    audience: mkAudience({
      invitees: [mkInvitee({ email: null })],
      unsubPhones: new Set(["+966500000001"]),
    }),
    channel: "whatsapp",
    onlyUnsent: true,
  });
  assert.ok(blockers.includes("no_ready_messages"));
});

test("whatsapp ready: unsubscribed phone does NOT block an invitee with email-only for email channel", () => {
  // Sanity check — the unsubPhones set only affects phone channels,
  // not email. An invitee with only an email address and a phone
  // on the unsub list should still be email-ready.
  const blockers = computeBlockers({
    campaign: mkCampaign(),
    audience: mkAudience({
      invitees: [mkInvitee({ phoneE164: null })],
      unsubPhones: new Set(["+966500000001"]),
    }),
    channel: "email",
    onlyUnsent: true,
  });
  assert.equal(blockers.includes("no_ready_messages"), false);
});

// ---- Combination blockers ---------------------------------------

test("all umbrella: stacks missing-template blockers for all three channels", () => {
  // Every missing template surfaces its own blocker. The ConfirmSend
  // UI renders the full list so the operator can fix everything at
  // once instead of iterating one-blocker-at-a-time.
  const blockers = computeBlockers({
    campaign: mkCampaign({
      templateEmail: null,
      templateSms: null,
      templateWhatsAppName: null,
    }),
    audience: mkAudience(),
    channel: "all",
    onlyUnsent: true,
  });
  assert.ok(blockers.includes("no_email_template"));
  assert.ok(blockers.includes("no_sms_template"));
  assert.ok(blockers.includes("no_whatsapp_template"));
});

test("blocker emission order stable: status → audience → templates (email, sms, whatsapp)", () => {
  // Pinning the order means the ConfirmSend UI's blocker list is
  // deterministic — the "loudest problem first" contract propose_send
  // documents (`src/lib/ai/tools/send-blockers.ts:147-149`).
  const blockers = computeBlockers({
    campaign: mkCampaign({
      status: "closed",
      templateEmail: null,
      templateSms: null,
      templateWhatsAppName: null,
    }),
    audience: mkAudience({ invitees: [] }),
    channel: "all",
    onlyUnsent: true,
  });
  assert.deepEqual(blockers, [
    "status_locked:closed",
    "no_invitees",
    "no_email_template",
    "no_sms_template",
    "no_whatsapp_template",
  ]);
});
