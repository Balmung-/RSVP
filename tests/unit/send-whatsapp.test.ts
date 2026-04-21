import { test } from "node:test";
import assert from "node:assert/strict";

import {
  performWhatsAppSend,
  type WhatsAppSendDeps,
} from "../../src/lib/delivery";
import type { Campaign, Invitee } from "@prisma/client";
import type {
  WhatsAppMessage,
  SendResult,
} from "../../src/lib/providers/types";

// P13-B — choreography tests for `performWhatsAppSend`.
//
// The function is the pure-deps core of `sendWhatsApp`: it decides a
// message shape via `decideWhatsAppMessage`, writes an Invitation row
// (or short-circuits), calls the provider, and writes EventLog on
// success. All DB + provider access is injected, so these tests pin
// each branch with in-memory fakes.
//
// Branch coverage:
//   1. no_phone      → short-circuit (no row, no provider call)
//   2. unsubscribed  → short-circuit (no row, no provider call)
//   3. planner fails (no template, no session text) → row written as failed,
//                     no provider call, no EventLog
//   4. planner fails (malformed variables)          → row written as failed
//   5. happy path template → row queued, provider called with template
//                            message, row updated to sent, EventLog with
//                            channel:"whatsapp", kind:"template"
//   6. happy path session text (sessionOpen=true + templateSms)
//   7. provider failure    → row updated to failed, no EventLog
//   8. payload column shape — template JSON vs text body vs error descriptor
//
// Same harness pattern as tests/unit/taqnyat-webhook-route.test.ts:
// a `SideEffects` tracker + `mkDeps` helper with per-test overrides.

// ---- Fixtures ----------------------------------------------------

const NOW = new Date("2026-04-20T12:00:00Z");
const INV_ID = "inv-fake-1";
const PROVIDER_ID = "wamid.abc123";

type SideEffects = {
  unsubscribedCalls: string[];
  createCalls: Array<{
    campaignId: string;
    inviteeId: string;
    channel: string;
    status: string;
    payload: string;
  }>;
  updateCalls: Array<{
    id: string;
    status?: string;
    providerId?: string;
    sentAt?: Date;
    error?: string;
  }>;
  eventLogs: Array<{
    kind: string;
    refType: string;
    refId: string;
    data: string;
  }>;
  sendCalls: WhatsAppMessage[];
};

function mkEffects(): SideEffects {
  return {
    unsubscribedCalls: [],
    createCalls: [],
    updateCalls: [],
    eventLogs: [],
    sendCalls: [],
  };
}

function mkDeps(
  opts: {
    unsubscribed?: boolean;
    sendResult?: SendResult;
    nextInvId?: string;
  } = {},
): { deps: WhatsAppSendDeps; effects: SideEffects } {
  const effects = mkEffects();
  const deps: WhatsAppSendDeps = {
    isUnsubscribed: async (phone) => {
      effects.unsubscribedCalls.push(phone);
      return opts.unsubscribed === true;
    },
    createInvitation: async (data) => {
      effects.createCalls.push(data);
      return { id: opts.nextInvId ?? INV_ID };
    },
    updateInvitation: async (id, data) => {
      effects.updateCalls.push({ id, ...data });
    },
    createEventLog: async (data) => {
      effects.eventLogs.push(data);
    },
    send: async (msg) => {
      effects.sendCalls.push(msg);
      return (
        opts.sendResult ?? { ok: true, providerId: PROVIDER_ID }
      );
    },
    now: () => NOW,
  };
  return { deps, effects };
}

// Campaign / Invitee fixtures. Using `as Campaign` / `as Invitee` —
// performWhatsAppSend only reads a narrow slice of each (templateX,
// teamId, id, name for Campaign; phoneE164, fullName, etc. via
// buildVars on Invitee), and the Prisma types require fields the
// code never touches. The planner is already tested with a narrow
// typed shape; these tests are about choreography.
function mkCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: "camp-1",
    name: "Spring Gala",
    description: null,
    eventAt: new Date("2026-05-12T16:00:00Z"),
    venue: "Four Seasons",
    locale: "en",
    rsvpDeadline: null,
    status: "active",
    templateEmail: null,
    templateSms: null,
    subjectEmail: null,
    templateWhatsAppName: null,
    templateWhatsAppLanguage: null,
    templateWhatsAppVariables: null,
    createdAt: NOW,
    updatedAt: NOW,
    brandColor: null,
    brandLogoUrl: null,
    brandHeroUrl: null,
    teamId: null,
    // P17-C.2 — the planner now reads `whatsappDocumentUploadId`;
    // without this explicit null the `as Campaign` cast masks a
    // missing-at-runtime field that crashes the predicate's
    // length check. Every caller of `decideWhatsAppMessage` must
    // supply this (even as null) now.
    whatsappDocumentUploadId: null,
    ...overrides,
  } as Campaign;
}

function mkInvitee(overrides: Partial<Invitee> = {}): Invitee {
  return {
    id: "inv-src-1",
    campaignId: "camp-1",
    contactId: null,
    fullName: "Ahmed Faisal",
    title: "CTO",
    organization: "Acme",
    email: null,
    phoneE164: "+966501234567",
    locale: null,
    tags: null,
    rsvpToken: "TOKEN",
    guestsAllowed: 0,
    notes: null,
    dedupKey: "deadbeef",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Invitee;
}

// ---- 1. no_phone short-circuit -----------------------------------

test("no_phone: invitee without phoneE164 short-circuits before DB + provider", async () => {
  // Matches sendEmail/sendSms discipline — pre-dispatch refusals
  // don't flood the event log with expected rejections. A caller who
  // wants to know "why didn't X get a WhatsApp?" consults the
  // Invitee table, not a failed Invitation row.
  const { deps, effects } = mkDeps();
  const r = await performWhatsAppSend(
    deps,
    mkCampaign(),
    mkInvitee({ phoneE164: null }),
  );
  assert.deepEqual(r, { ok: false, error: "no_phone" });
  // Critically: no side effects whatsoever.
  assert.equal(effects.unsubscribedCalls.length, 0);
  assert.equal(effects.createCalls.length, 0);
  assert.equal(effects.sendCalls.length, 0);
  assert.equal(effects.eventLogs.length, 0);
});

// ---- 2. unsubscribed short-circuit -------------------------------

test("unsubscribed: refusal short-circuits AFTER the check but before write", async () => {
  const { deps, effects } = mkDeps({ unsubscribed: true });
  const r = await performWhatsAppSend(
    deps,
    mkCampaign({
      templateWhatsAppName: "rsvp_v1",
      templateWhatsAppLanguage: "ar",
    }),
    mkInvitee(),
  );
  assert.deepEqual(r, { ok: false, error: "unsubscribed" });
  // Unsubscribed check ran (phone was passed in).
  assert.deepEqual(effects.unsubscribedCalls, ["+966501234567"]);
  // No row written, no provider call — same rationale as no_phone.
  assert.equal(effects.createCalls.length, 0);
  assert.equal(effects.sendCalls.length, 0);
  assert.equal(effects.eventLogs.length, 0);
});

// ---- 3. planner failure: no template configured ------------------

test("planner no_template: writes failed Invitation, no provider call, no EventLog", async () => {
  // Unlike unsubscribed, this represents a CAMPAIGN configuration bug
  // the operator needs to see in the send stats. Writing a failed row
  // surfaces it in the audit trail.
  const { deps, effects } = mkDeps();
  const r = await performWhatsAppSend(deps, mkCampaign(), mkInvitee());
  assert.deepEqual(r, { ok: false, error: "no_template" });
  // Row written first.
  assert.equal(effects.createCalls.length, 1);
  const created = effects.createCalls[0];
  assert.equal(created.channel, "whatsapp");
  assert.equal(created.status, "queued");
  assert.equal(created.campaignId, "camp-1");
  assert.equal(created.inviteeId, "inv-src-1");
  // Payload carries the structured error descriptor so audit reviewers
  // can tell a planner-refusal apart from a provider failure.
  assert.deepEqual(JSON.parse(created.payload), { error: "no_template" });
  // Then flipped to failed.
  assert.equal(effects.updateCalls.length, 1);
  assert.deepEqual(effects.updateCalls[0], {
    id: INV_ID,
    status: "failed",
    error: "no_template",
  });
  // Provider never called, no EventLog.
  assert.equal(effects.sendCalls.length, 0);
  assert.equal(effects.eventLogs.length, 0);
});

// ---- 4. planner failure: malformed variables JSON ----------------

test("planner template_vars_malformed: writes failed row with structured error", async () => {
  const { deps, effects } = mkDeps();
  const r = await performWhatsAppSend(
    deps,
    mkCampaign({
      templateWhatsAppName: "rsvp_v1",
      templateWhatsAppLanguage: "ar",
      templateWhatsAppVariables: "not valid json",
    }),
    mkInvitee(),
  );
  assert.deepEqual(r, { ok: false, error: "template_vars_malformed" });
  assert.equal(effects.createCalls.length, 1);
  assert.deepEqual(JSON.parse(effects.createCalls[0].payload), {
    error: "template_vars_malformed",
  });
  assert.equal(effects.updateCalls.length, 1);
  assert.equal(effects.updateCalls[0].status, "failed");
  assert.equal(effects.updateCalls[0].error, "template_vars_malformed");
  assert.equal(effects.sendCalls.length, 0);
  assert.equal(effects.eventLogs.length, 0);
});

// ---- 5. happy path: template -------------------------------------

test("happy path template: queued row → sent → EventLog with kind:'template'", async () => {
  const { deps, effects } = mkDeps();
  const r = await performWhatsAppSend(
    deps,
    mkCampaign({
      templateWhatsAppName: "rsvp_invitation_v1",
      templateWhatsAppLanguage: "ar",
      templateWhatsAppVariables: JSON.stringify(["{{name}}", "{{venue}}"]),
    }),
    mkInvitee(),
  );
  assert.deepEqual(r, { ok: true, invitationId: INV_ID });

  // One queued row with a template JSON descriptor in payload.
  assert.equal(effects.createCalls.length, 1);
  const created = effects.createCalls[0];
  assert.equal(created.status, "queued");
  assert.equal(created.channel, "whatsapp");
  const payload = JSON.parse(created.payload);
  assert.equal(payload.template, "rsvp_invitation_v1");
  assert.equal(payload.language, "ar");
  // Positional variables interpolated from buildVars against invitee.
  assert.deepEqual(payload.variables, ["Ahmed Faisal", "Four Seasons"]);

  // Provider called with the template message.
  assert.equal(effects.sendCalls.length, 1);
  const sent = effects.sendCalls[0];
  assert.equal(sent.kind, "template");
  if (sent.kind !== "template") throw new Error("unreachable");
  assert.equal(sent.templateName, "rsvp_invitation_v1");
  assert.equal(sent.languageCode, "ar");
  assert.deepEqual(sent.variables, ["Ahmed Faisal", "Four Seasons"]);
  assert.equal(sent.to, "+966501234567");

  // Row flipped to sent with providerId + sentAt=NOW.
  assert.equal(effects.updateCalls.length, 1);
  assert.deepEqual(effects.updateCalls[0], {
    id: INV_ID,
    status: "sent",
    providerId: PROVIDER_ID,
    sentAt: NOW,
  });

  // EventLog shape pinned — audit consumers (summary widget in later
  // P13 slices) filter on kind:"invite.sent" + data.channel.
  assert.equal(effects.eventLogs.length, 1);
  const log = effects.eventLogs[0];
  assert.equal(log.kind, "invite.sent");
  assert.equal(log.refType, "invitation");
  assert.equal(log.refId, INV_ID);
  assert.deepEqual(JSON.parse(log.data), {
    channel: "whatsapp",
    kind: "template",
  });
});

// ---- 6. happy path: session text ---------------------------------

test("happy path session text: sessionOpen=true + templateSms → kind:'text'", async () => {
  const { deps, effects } = mkDeps();
  const r = await performWhatsAppSend(
    deps,
    mkCampaign({
      templateSms: "Hi {{name}}, RSVP at {{rsvpUrl}}",
    }),
    mkInvitee(),
    { sessionOpen: true },
  );
  assert.deepEqual(r, { ok: true, invitationId: INV_ID });

  // Session-text payload is the rendered body (so reviewers see
  // exactly what was sent), not a JSON descriptor.
  assert.equal(effects.createCalls.length, 1);
  assert.equal(
    effects.createCalls[0].payload,
    "Hi Ahmed Faisal, RSVP at http://localhost:3000/rsvp/TOKEN",
  );

  // Provider called with text message.
  assert.equal(effects.sendCalls.length, 1);
  const sent = effects.sendCalls[0];
  assert.equal(sent.kind, "text");
  if (sent.kind !== "text") throw new Error("unreachable");
  assert.equal(
    sent.text,
    "Hi Ahmed Faisal, RSVP at http://localhost:3000/rsvp/TOKEN",
  );

  // EventLog kind discriminator flips to "text".
  assert.equal(effects.eventLogs.length, 1);
  assert.deepEqual(JSON.parse(effects.eventLogs[0].data), {
    channel: "whatsapp",
    kind: "text",
  });
});

// ---- 7. provider failure -----------------------------------------

test("provider failure: row marked failed with provider error, no EventLog", async () => {
  const { deps, effects } = mkDeps({
    sendResult: { ok: false, error: "provider_rate_limited" },
  });
  const r = await performWhatsAppSend(
    deps,
    mkCampaign({
      templateWhatsAppName: "rsvp_v1",
      templateWhatsAppLanguage: "ar",
    }),
    mkInvitee(),
  );
  assert.deepEqual(r, { ok: false, error: "provider_rate_limited" });

  // Row queued + provider called.
  assert.equal(effects.createCalls.length, 1);
  assert.equal(effects.sendCalls.length, 1);
  // Row flipped to failed with the provider's error.
  assert.equal(effects.updateCalls.length, 1);
  assert.deepEqual(effects.updateCalls[0], {
    id: INV_ID,
    status: "failed",
    error: "provider_rate_limited",
  });
  // Critically: no EventLog. `invite.sent` means the invite actually
  // went out. Logging on provider failure would corrupt the audit.
  assert.equal(effects.eventLogs.length, 0);
});

// ---- 8. session text refused without sessionOpen -----------------

test("session text NOT used when sessionOpen is absent (even with templateSms set)", async () => {
  // The planner's Rule 2 only fires when the caller asserts
  // sessionOpen=true. Absent (undefined) or false → no_template.
  // Pinning this at the choreography level catches a regression
  // where a caller might default sessionOpen to true.
  const { deps, effects } = mkDeps();
  const r = await performWhatsAppSend(
    deps,
    mkCampaign({
      templateSms: "Hi {{name}}",
    }),
    mkInvitee(),
    // sessionOpen omitted on purpose
  );
  assert.deepEqual(r, { ok: false, error: "no_template" });
  assert.equal(effects.sendCalls.length, 0);
});

// ---- 9. template wins over session text even when both present ---

test("template-first rule: template used even when sessionOpen + templateSms also set", async () => {
  // Mirrors the planner's rule ordering test. Pinning it here too
  // catches a regression where delivery.ts accidentally swaps
  // arguments / flips precedence.
  const { deps, effects } = mkDeps();
  const r = await performWhatsAppSend(
    deps,
    mkCampaign({
      templateWhatsAppName: "rsvp_v1",
      templateWhatsAppLanguage: "ar",
      templateSms: "Hi {{name}}",
    }),
    mkInvitee(),
    { sessionOpen: true },
  );
  assert.deepEqual(r, { ok: true, invitationId: INV_ID });
  assert.equal(effects.sendCalls.length, 1);
  assert.equal(effects.sendCalls[0].kind, "template");
});
