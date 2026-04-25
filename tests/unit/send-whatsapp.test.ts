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
  WhatsAppDocumentRef,
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
    // P17-C.4 — post-swap provenance update. Doc-header happy paths
    // produce TWO `updateInvitation` calls: one carrying just
    // `payload` (after the mediaId is known) and one carrying the
    // terminal status/providerId/sentAt after the provider send.
    // Tests filter `updateCalls` on `u.payload !== undefined` to
    // isolate provenance updates from status updates.
    payload?: string;
  }>;
  eventLogs: Array<{
    kind: string;
    refType: string;
    refId: string;
    data: string;
  }>;
  sendCalls: WhatsAppMessage[];
  // P17-C.3 — doc-header resolution tracking. Every intercept call
  // (loadFileUpload / uploadMedia) is recorded so tests can assert
  // both "was called with the right args" and "was NOT called when
  // the intercept shouldn't fire." The latter guards against a
  // regression that, say, accidentally triggers an upload on every
  // send regardless of plan shape.
  loadFileUploadCalls: string[];
  uploadMediaCalls: Array<{
    bytes: Uint8Array;
    filename: string;
    mimeType: string;
  }>;
};

function mkEffects(): SideEffects {
  return {
    unsubscribedCalls: [],
    createCalls: [],
    updateCalls: [],
    eventLogs: [],
    sendCalls: [],
    loadFileUploadCalls: [],
    uploadMediaCalls: [],
  };
}

function mkDeps(
  opts: {
    unsubscribed?: boolean;
    sendResult?: SendResult;
    nextInvId?: string;
    // P17-C.3 — doc-header resolution wiring. Both optional so
    // existing (non-doc) tests can keep passing `{}`. Tests that
    // exercise the intercept configure the return values
    // explicitly.
    //
    //   - `fileUpload === undefined` → loadFileUpload dep is NOT
    //     supplied on deps (forces the `doc_upload_deps_missing`
    //     path when combined with omitted `uploadMedia`).
    //   - `fileUpload === null`      → dep supplied, returns null
    //     (the FileUpload row doesn't exist — `doc_not_found`).
    //   - `fileUpload === { ... }`   → dep supplied, returns row.
    //
    // Same three-state convention for `uploadMedia`: undefined =
    // dep absent; any value = dep supplied with that return.
    fileUpload?:
      | { contents: Uint8Array; filename: string; contentType: string }
      | null;
    uploadMedia?:
      | { ok: true; ref: WhatsAppDocumentRef }
      | { ok: false; error: string };
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
    // Conditionally attach doc deps — opts.fileUpload === undefined
    // means "don't provide the dep at all," which exercises the
    // `doc_upload_deps_missing` path.
    ...(opts.fileUpload !== undefined
      ? {
          loadFileUpload: async (id: string) => {
            effects.loadFileUploadCalls.push(id);
            return opts.fileUpload ?? null;
          },
        }
      : {}),
    ...(opts.uploadMedia !== undefined
      ? {
          uploadMedia: async (upload: {
            bytes: Uint8Array;
            filename: string;
            mimeType: string;
          }) => {
            effects.uploadMediaCalls.push(upload);
            return opts.uploadMedia!;
          },
        }
      : {}),
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

test("planner no_template: writes failed Invitation, no provider call, invite.failed EventLog", async () => {
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
  // Provider never called, but the failure is now logged so operators
  // can see the exact refusal reason in campaign activity and
  // deliverability.
  assert.equal(effects.sendCalls.length, 0);
  assert.equal(effects.eventLogs.length, 1);
  assert.equal(effects.eventLogs[0].kind, "invite.failed");
  assert.deepEqual(JSON.parse(effects.eventLogs[0].data), {
    channel: "whatsapp",
    error: "no_template",
  });
});

// ---- 4. planner failure: malformed variables JSON ----------------

test("planner template_vars_malformed: writes failed row with structured error and EventLog", async () => {
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
  assert.equal(effects.eventLogs.length, 1);
  assert.equal(effects.eventLogs[0].kind, "invite.failed");
  assert.deepEqual(JSON.parse(effects.eventLogs[0].data), {
    channel: "whatsapp",
    error: "template_vars_malformed",
  });
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

test("provider failure: row marked failed with provider error and invite.failed EventLog", async () => {
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
  // Provider failure is distinct from `invite.sent`, so it emits its
  // own failure log without corrupting the success audit trail.
  assert.equal(effects.eventLogs.length, 1);
  assert.equal(effects.eventLogs[0].kind, "invite.failed");
  assert.deepEqual(JSON.parse(effects.eventLogs[0].data), {
    channel: "whatsapp",
    error: "provider_rate_limited",
  });
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

// ---- P17-C.3: doc-header placeholder → mediaId swap -------------
//
// When the planner emits a template message with a placeholder
// `headerDocument: { kind: "link", link: "/api/files/<id>" }`,
// performWhatsAppSend intercepts BEFORE the provider.send call,
// reads the FileUpload bytes via `loadFileUpload`, uploads them
// via `uploadMedia` (wired to Taqnyat in real deps), and swaps
// the ref to `{ kind: "id", mediaId, filename }`. Any failure in
// that chain fails the invitation row with a structured error;
// the chat widgets (P17-C.5) will render those errors later.

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]); // "%PDF-1"
const UPLOAD_ID = "upl-abc123";
const MEDIA_ID = "4455667788";

test("doc-header: happy path — load + upload + send with id-ref headerDocument", async () => {
  // Full chain: doc-configured campaign → planner emits link
  // placeholder → loadFileUpload called with id parsed from link
  // → uploadMedia called with bytes+filename+mime → provider.send
  // called with an id-shape headerDocument ref → invitation
  // marked sent. Pins every step of the handoff in order.
  const { deps, effects } = mkDeps({
    fileUpload: {
      contents: PDF_BYTES,
      filename: "invitation.pdf",
      contentType: "application/pdf",
    },
    uploadMedia: {
      ok: true,
      ref: { kind: "id", mediaId: MEDIA_ID, filename: "invitation.pdf" },
    },
  });
  const r = await performWhatsAppSend(
    deps,
    mkCampaign({
      templateWhatsAppName: "moather2026_moather2026",
      templateWhatsAppLanguage: "ar",
      whatsappDocumentUploadId: UPLOAD_ID,
    }),
    mkInvitee(),
  );
  assert.deepEqual(r, { ok: true, invitationId: INV_ID });
  // loadFileUpload called with the id parsed from the planner's
  // placeholder link — NOT the full `/api/files/<id>` URL.
  assert.deepEqual(effects.loadFileUploadCalls, [UPLOAD_ID]);
  // uploadMedia receives bytes + filename + mime unchanged from
  // the FileUpload row (no re-projection).
  assert.equal(effects.uploadMediaCalls.length, 1);
  assert.equal(effects.uploadMediaCalls[0].bytes, PDF_BYTES);
  assert.equal(effects.uploadMediaCalls[0].filename, "invitation.pdf");
  assert.equal(effects.uploadMediaCalls[0].mimeType, "application/pdf");
  // Provider.send receives the SWAPPED message — the
  // headerDocument is now an id-ref, not the link placeholder.
  assert.equal(effects.sendCalls.length, 1);
  const sent = effects.sendCalls[0];
  assert.equal(sent.kind, "template");
  if (sent.kind !== "template") return;
  assert.deepEqual(sent.headerDocument, {
    kind: "id",
    mediaId: MEDIA_ID,
    filename: "invitation.pdf",
  });
  // Invitation ends up sent, not failed.
  assert.ok(
    effects.updateCalls.some((u) => u.status === "sent"),
    "invitation should be marked sent",
  );
});

test("doc-header: plain template (no doc ref) skips load + upload entirely", async () => {
  // A negative pin: without `whatsappDocumentUploadId` set, the
  // planner emits no headerDocument, and the intercept must NOT
  // fire. Catches a regression that accidentally resolves the
  // (absent) headerDocument on every send — which would make
  // plain-template sends fail the moment a deployment lacks
  // doc deps.
  const { deps, effects } = mkDeps({
    // Doc deps intentionally NOT supplied; if the intercept fires
    // we'd hit `doc_upload_deps_missing` and the send would fail.
  });
  const r = await performWhatsAppSend(
    deps,
    mkCampaign({
      templateWhatsAppName: "rsvp_invitation_v1",
      templateWhatsAppLanguage: "en_US",
      // whatsappDocumentUploadId: null (mkCampaign default)
    }),
    mkInvitee(),
  );
  assert.deepEqual(r, { ok: true, invitationId: INV_ID });
  assert.deepEqual(effects.loadFileUploadCalls, []);
  assert.deepEqual(effects.uploadMediaCalls, []);
  // Provider.send fired once, with a template message carrying no
  // headerDocument at all.
  assert.equal(effects.sendCalls.length, 1);
  const sent = effects.sendCalls[0];
  assert.equal(sent.kind, "template");
  if (sent.kind !== "template") return;
  assert.equal(
    Object.prototype.hasOwnProperty.call(sent, "headerDocument"),
    false,
  );
});

test("doc-header: loadFileUpload returns null → invitation failed doc_not_found, no upload, no send", async () => {
  // Operator has deleted the FileUpload AFTER configuring the
  // campaign (onDelete:SetNull would usually null the FK, but a
  // race between send queueing and delete can still surface
  // this). Must fail cleanly — NOT call uploadMedia (would be
  // a no-op, but we pin the "fail-fast" discipline).
  const { deps, effects } = mkDeps({
    fileUpload: null, // dep provided, but returns "row not found"
    uploadMedia: {
      ok: true,
      ref: { kind: "id", mediaId: "should-not-appear", filename: "x" },
    },
  });
  const r = await performWhatsAppSend(
    deps,
    mkCampaign({
      templateWhatsAppName: "moather2026_moather2026",
      templateWhatsAppLanguage: "ar",
      whatsappDocumentUploadId: UPLOAD_ID,
    }),
    mkInvitee(),
  );
  assert.deepEqual(r, { ok: false, error: "doc_not_found" });
  assert.deepEqual(effects.loadFileUploadCalls, [UPLOAD_ID]);
  // Crucially, NO upload, NO send.
  assert.deepEqual(effects.uploadMediaCalls, []);
  assert.deepEqual(effects.sendCalls, []);
  // Invitation is marked failed with the structured error.
  assert.ok(
    effects.updateCalls.some(
      (u) => u.status === "failed" && u.error === "doc_not_found",
    ),
    "invitation should be marked failed with error=doc_not_found",
  );
});

test("doc-header: FileUpload with empty bytes → invitation failed doc_empty, no upload, no send", async () => {
  // Defensive pin against a DB state bug: a FileUpload row that
  // exists but has zero-length contents (shouldn't happen via
  // /api/uploads — it rejects empty files — but the schema
  // allows it). The length-0 guard mirrors P17-B's
  // `taqnyatUploadMedia` short-circuit; catching it pre-upload
  // means the operator sees `doc_empty` rather than the generic
  // `whatsapp-media: empty bytes` — the former is immediately
  // actionable (re-upload the PDF), the latter sounds like a
  // network problem.
  const { deps, effects } = mkDeps({
    fileUpload: {
      contents: new Uint8Array(0),
      filename: "invitation.pdf",
      contentType: "application/pdf",
    },
    uploadMedia: {
      ok: true,
      ref: { kind: "id", mediaId: "nope", filename: "x" },
    },
  });
  const r = await performWhatsAppSend(
    deps,
    mkCampaign({
      templateWhatsAppName: "moather2026_moather2026",
      templateWhatsAppLanguage: "ar",
      whatsappDocumentUploadId: UPLOAD_ID,
    }),
    mkInvitee(),
  );
  assert.deepEqual(r, { ok: false, error: "doc_empty" });
  assert.deepEqual(effects.loadFileUploadCalls, [UPLOAD_ID]);
  assert.deepEqual(effects.uploadMediaCalls, []);
  assert.deepEqual(effects.sendCalls, []);
  assert.ok(
    effects.updateCalls.some(
      (u) => u.status === "failed" && u.error === "doc_empty",
    ),
    "invitation should be marked failed with error=doc_empty",
  );
});

test("doc-header: FileUpload with non-PDF MIME → invitation failed doc_not_pdf, no upload, no send", async () => {
  // Pilot contract: the approved template is a PDF document header.
  // A crafted bind to a DOCX/TXT upload must fail closed before the
  // BSP upload call, even if the row otherwise exists and has bytes.
  const { deps, effects } = mkDeps({
    fileUpload: {
      contents: PDF_BYTES,
      filename: "invitation.docx",
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    uploadMedia: {
      ok: true,
      ref: { kind: "id", mediaId: "nope", filename: "x" },
    },
  });
  const r = await performWhatsAppSend(
    deps,
    mkCampaign({
      templateWhatsAppName: "moather2026_moather2026",
      templateWhatsAppLanguage: "ar",
      whatsappDocumentUploadId: UPLOAD_ID,
    }),
    mkInvitee(),
  );
  assert.deepEqual(r, { ok: false, error: "doc_not_pdf" });
  assert.deepEqual(effects.loadFileUploadCalls, [UPLOAD_ID]);
  assert.deepEqual(effects.uploadMediaCalls, []);
  assert.deepEqual(effects.sendCalls, []);
  assert.ok(
    effects.updateCalls.some(
      (u) => u.status === "failed" && u.error === "doc_not_pdf",
    ),
    "invitation should be marked failed with error=doc_not_pdf",
  );
});

test("doc-header: uploadMedia fails → invitation failed with upload error, no send", async () => {
  // Meta / BSP upload rejection. The intercept passes the error
  // string through verbatim (no rewrap) so the operator sees
  // exactly what Taqnyat said — "whatsapp-media 401: bad token"
  // or similar. No provider.send call on upload failure;
  // invitation marked failed.
  const { deps, effects } = mkDeps({
    fileUpload: {
      contents: PDF_BYTES,
      filename: "invitation.pdf",
      contentType: "application/pdf",
    },
    uploadMedia: {
      ok: false,
      error: "whatsapp-media 401: invalid token",
    },
  });
  const r = await performWhatsAppSend(
    deps,
    mkCampaign({
      templateWhatsAppName: "moather2026_moather2026",
      templateWhatsAppLanguage: "ar",
      whatsappDocumentUploadId: UPLOAD_ID,
    }),
    mkInvitee(),
  );
  assert.deepEqual(r, {
    ok: false,
    error: "whatsapp-media 401: invalid token",
  });
  assert.deepEqual(effects.loadFileUploadCalls, [UPLOAD_ID]);
  assert.equal(effects.uploadMediaCalls.length, 1);
  assert.deepEqual(effects.sendCalls, []);
  assert.ok(
    effects.updateCalls.some(
      (u) =>
        u.status === "failed" &&
        u.error === "whatsapp-media 401: invalid token",
    ),
    "invitation should be marked failed with the upload error verbatim",
  );
});

test("doc-header: dep not supplied → invitation failed doc_upload_deps_missing, no load, no send", async () => {
  // Harness-level failure mode: the caller's deps forgot to wire
  // the resolution path but passed a doc-configured campaign.
  // Failing with `doc_upload_deps_missing` (rather than silently
  // sending the unreachable `/api/files/<id>` URL through to the
  // provider) is what makes this testable at all — the operator
  // or test author sees an obvious "you forgot to wire it" error
  // instead of a confusing "Meta can't fetch this URL."
  const { deps, effects } = mkDeps({
    // fileUpload + uploadMedia both undefined → neither dep is
    // on the returned `deps` object.
  });
  const r = await performWhatsAppSend(
    deps,
    mkCampaign({
      templateWhatsAppName: "moather2026_moather2026",
      templateWhatsAppLanguage: "ar",
      whatsappDocumentUploadId: UPLOAD_ID,
    }),
    mkInvitee(),
  );
  assert.deepEqual(r, { ok: false, error: "doc_upload_deps_missing" });
  // Neither intercept sub-step fired — the deps check short-
  // circuits before loadFileUpload would be invoked.
  assert.deepEqual(effects.loadFileUploadCalls, []);
  assert.deepEqual(effects.uploadMediaCalls, []);
  assert.deepEqual(effects.sendCalls, []);
});

// ---- P17-C.4: post-swap payload provenance ----------------------
//
// After a successful C.3 swap, the invitation's `payload` column is
// overwritten with the create-time template descriptor PLUS three
// provenance fields: `documentMediaId`, `documentFilename`,
// `documentUploadId`. That lets an operator auditing a sent row
// answer "which media did we attempt?" without consulting a separate
// table — the answer travels with the invitation.
//
// Pins below establish:
//   1. Happy path — provenance fields written with correct values.
//   2. Plain template (no swap) — NO provenance update; payload
//      stays at its `payloadForPlan` create-time shape.
//   3. Ref without filename — `documentFilename` serialized as
//      explicit null (not dropped silently).
//   4. Swap failure — NO provenance update; status update carries
//      only the structured error.

test("doc-header payload: post-swap update carries documentMediaId, filename, uploadId", async () => {
  // Full-chain provenance: the payload update fires BEFORE the send,
  // carrying the template descriptor (name, language, interpolated
  // variables) plus the three doc-provenance fields. The terminal
  // status update (status=sent + providerId + sentAt) is a separate
  // call with no payload field — each update has exactly one job.
  const { deps, effects } = mkDeps({
    fileUpload: {
      contents: PDF_BYTES,
      filename: "invitation.pdf",
      contentType: "application/pdf",
    },
    uploadMedia: {
      ok: true,
      ref: { kind: "id", mediaId: MEDIA_ID, filename: "invitation.pdf" },
    },
  });
  const r = await performWhatsAppSend(
    deps,
    mkCampaign({
      templateWhatsAppName: "moather2026_moather2026",
      templateWhatsAppLanguage: "ar",
      // Deliberately malformed/stale vars should be ignored for the
      // approved zero-variable template.
      templateWhatsAppVariables: JSON.stringify(["{{name}}", "{{venue}}"]),
      whatsappDocumentUploadId: UPLOAD_ID,
    }),
    mkInvitee(),
  );
  assert.deepEqual(r, { ok: true, invitationId: INV_ID });

  // Exactly one provenance update — partition the update list and
  // pin both partitions independently.
  const payloadUpdates = effects.updateCalls.filter(
    (u) => u.payload !== undefined,
  );
  const statusUpdates = effects.updateCalls.filter(
    (u) => u.payload === undefined,
  );
  assert.equal(payloadUpdates.length, 1);
  assert.equal(statusUpdates.length, 1);

  // Provenance payload shape: template fields + doc fields all present
  // and sourced from the swap result (MEDIA_ID) + parsed upload link
  // (UPLOAD_ID), not from the campaign column directly.
  const payload = JSON.parse(payloadUpdates[0].payload!);
  assert.equal(payload.template, "moather2026_moather2026");
  assert.equal(payload.language, "ar");
  assert.deepEqual(payload.variables, []);
  assert.equal(payload.documentMediaId, MEDIA_ID);
  assert.equal(payload.documentFilename, "invitation.pdf");
  assert.equal(payload.documentUploadId, UPLOAD_ID);

  // Provenance update touches ONLY payload — no status/providerId/sentAt
  // bleed-through. The separation matters for audit: a reader can tell
  // the invitation was "enriched with provenance, then sent" rather
  // than "sent all at once," which helps diagnose mid-flight failures.
  assert.equal(payloadUpdates[0].status, undefined);
  assert.equal(payloadUpdates[0].providerId, undefined);
  assert.equal(payloadUpdates[0].sentAt, undefined);
  assert.equal(payloadUpdates[0].error, undefined);

  // Terminal status update is the usual shape.
  assert.equal(statusUpdates[0].status, "sent");
  assert.equal(statusUpdates[0].providerId, PROVIDER_ID);
  assert.equal(statusUpdates[0].sentAt, NOW);
});

test("doc-header payload: plain template (no swap) writes no provenance update", async () => {
  // Negative pin: without `whatsappDocumentUploadId`, the planner
  // emits no headerDocument, the intercept doesn't fire, and the
  // only updateInvitation call is the terminal status=sent one.
  // The invitation's payload column stays at its create-time
  // `payloadForPlan` shape (no doc fields).
  const { deps, effects } = mkDeps();
  const r = await performWhatsAppSend(
    deps,
    mkCampaign({
      templateWhatsAppName: "rsvp_invitation_v1",
      templateWhatsAppLanguage: "en_US",
      templateWhatsAppVariables: JSON.stringify(["{{name}}"]),
    }),
    mkInvitee(),
  );
  assert.deepEqual(r, { ok: true, invitationId: INV_ID });

  const payloadUpdates = effects.updateCalls.filter(
    (u) => u.payload !== undefined,
  );
  assert.equal(payloadUpdates.length, 0);

  // Create-time payload still carries the template JSON without
  // doc fields — confirms `payloadForPlan` is the sole writer on
  // the no-swap path.
  assert.equal(effects.createCalls.length, 1);
  const created = JSON.parse(effects.createCalls[0].payload);
  assert.equal(created.template, "rsvp_invitation_v1");
  assert.equal(created.documentMediaId, undefined);
  assert.equal(created.documentFilename, undefined);
  assert.equal(created.documentUploadId, undefined);
});

test("doc-header payload: ref without filename → documentFilename serialized as null", async () => {
  // Defensive pin: `WhatsAppDocumentRef.filename` is optional. If
  // the BSP returns a ref without one, the audit row should still
  // have a structured shape — an explicit `null` rather than the
  // key being silently dropped by JSON.stringify. Keeps the payload
  // schema stable for downstream consumers.
  const { deps, effects } = mkDeps({
    fileUpload: {
      contents: PDF_BYTES,
      filename: "invitation.pdf",
      contentType: "application/pdf",
    },
    uploadMedia: {
      ok: true,
      // filename deliberately omitted to simulate a BSP that didn't
      // echo one back.
      ref: { kind: "id", mediaId: MEDIA_ID },
    },
  });
  await performWhatsAppSend(
    deps,
    mkCampaign({
      templateWhatsAppName: "moather2026_moather2026",
      templateWhatsAppLanguage: "ar",
      whatsappDocumentUploadId: UPLOAD_ID,
    }),
    mkInvitee(),
  );
  const payloadUpdates = effects.updateCalls.filter(
    (u) => u.payload !== undefined,
  );
  assert.equal(payloadUpdates.length, 1);
  const payload = JSON.parse(payloadUpdates[0].payload!);
  // Key is present and explicitly null — not missing.
  assert.equal("documentFilename" in payload, true);
  assert.equal(payload.documentFilename, null);
  // Other provenance fields still present.
  assert.equal(payload.documentMediaId, MEDIA_ID);
  assert.equal(payload.documentUploadId, UPLOAD_ID);
});

test("doc-header payload: swap failure (doc_not_found) writes no provenance update", async () => {
  // When the swap chain fails, the invitation is marked failed with
  // the structured error. The payload column is NOT overwritten —
  // it keeps its create-time template descriptor (no doc fields).
  // Audit readers use the PRESENCE of `documentMediaId` in payload
  // as the signal that the send attempted a specific media; an
  // absent field means "we never got far enough to know the id."
  const { deps, effects } = mkDeps({
    fileUpload: null,
    // uploadMedia provided so the deps-missing branch doesn't fire
    // first — we want the DB-miss branch specifically.
    uploadMedia: {
      ok: true,
      ref: { kind: "id", mediaId: "unreachable", filename: "x" },
    },
  });
  const r = await performWhatsAppSend(
    deps,
    mkCampaign({
      templateWhatsAppName: "moather2026_moather2026",
      templateWhatsAppLanguage: "ar",
      whatsappDocumentUploadId: UPLOAD_ID,
    }),
    mkInvitee(),
  );
  assert.deepEqual(r, { ok: false, error: "doc_not_found" });

  // Zero provenance updates — the swap never produced a mediaId, so
  // there's nothing to record.
  const payloadUpdates = effects.updateCalls.filter(
    (u) => u.payload !== undefined,
  );
  assert.equal(payloadUpdates.length, 0);
  // The only update is the terminal failed-status one.
  assert.equal(effects.updateCalls.length, 1);
  assert.equal(effects.updateCalls[0].status, "failed");
  assert.equal(effects.updateCalls[0].error, "doc_not_found");
});
