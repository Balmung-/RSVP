import { test } from "node:test";
import assert from "node:assert/strict";

import {
  campaignWantsWhatsAppDocument,
  type WhatsAppDocumentGateInput,
} from "../../src/lib/providers/whatsapp/sendPlan";

// P17-C.1 — WhatsApp document-header readiness gate.
//
// This predicate is the upstream branching point for every
// subsequent P17-C slice:
//
//   - P17-C.2 uses it as the first check in the planner to decide
//     whether to emit a headerDocument branch.
//   - P17-C.3 uses it pre-upload to short-circuit campaigns that
//     aren't doc-configured (avoids pointless FileUpload fetches).
//   - P17-C.5 uses it to decide whether the propose_send widget
//     shows a "will attach PDF" readiness line.
//
// So the semantics have to be exactly right. The gate is
// "configuration-complete," NOT "send-will-succeed" — presence /
// size / fetchability of the FileUpload bytes are C.3's problem
// (P17-B's short-circuits already catch empty bytes).
//
// A campaign is doc-ready only when ALL THREE fields are set:
//
//   1. `whatsappDocumentUploadId` — there's a PDF to attach.
//   2. `templateWhatsAppName`     — Meta requires a template to
//                                    carry the header document.
//   3. `templateWhatsAppLanguage` — Meta keys templates on
//                                    (name, language); missing
//                                    language = no match.
//
// Any field missing or length-0 → false. The length-0 discipline
// mirrors the planner's existing rule-1 check in sendPlan.ts.

test("campaignWantsWhatsAppDocument: all three fields present + non-empty → true", () => {
  const input: WhatsAppDocumentGateInput = {
    whatsappDocumentUploadId: "upl-abc123",
    templateWhatsAppName: "moather2026_moather2026",
    templateWhatsAppLanguage: "ar",
  };
  assert.equal(campaignWantsWhatsAppDocument(input), true);
});

test("campaignWantsWhatsAppDocument: missing whatsappDocumentUploadId (null) → false", () => {
  // Null means "no PDF configured" — the campaign sends the plain
  // template via the P17-A path. This is the most common case:
  // most campaigns won't have a PDF attachment.
  const input: WhatsAppDocumentGateInput = {
    whatsappDocumentUploadId: null,
    templateWhatsAppName: "moather2026_moather2026",
    templateWhatsAppLanguage: "ar",
  };
  assert.equal(campaignWantsWhatsAppDocument(input), false);
});

test("campaignWantsWhatsAppDocument: missing templateWhatsAppName (null) → false", () => {
  // A FileUpload id without a template name is a config bug: Meta
  // only accepts header documents on template messages. The gate
  // refuses so the confirm-time checker can surface a clean blocker
  // rather than letting a broken send reach the provider.
  const input: WhatsAppDocumentGateInput = {
    whatsappDocumentUploadId: "upl-abc123",
    templateWhatsAppName: null,
    templateWhatsAppLanguage: "ar",
  };
  assert.equal(campaignWantsWhatsAppDocument(input), false);
});

test("campaignWantsWhatsAppDocument: missing templateWhatsAppLanguage (null) → false", () => {
  // Meta identifies a template by the (name, language) pair — a
  // name alone won't resolve to an approved template. Missing
  // language is the same failure class as missing name.
  const input: WhatsAppDocumentGateInput = {
    whatsappDocumentUploadId: "upl-abc123",
    templateWhatsAppName: "moather2026_moather2026",
    templateWhatsAppLanguage: null,
  };
  assert.equal(campaignWantsWhatsAppDocument(input), false);
});

test("campaignWantsWhatsAppDocument: empty-string field (length-0, non-null) → false", () => {
  // Defensive pin against a refactor that reads from a free-form
  // input and lets empty strings through. The gate treats "" as
  // "not set," matching the planner's existing rule-1 length-0
  // discipline at sendPlan.ts:93-96. Three variants to prove
  // each field is individually checked, not just one.
  const emptyDoc: WhatsAppDocumentGateInput = {
    whatsappDocumentUploadId: "",
    templateWhatsAppName: "moather2026_moather2026",
    templateWhatsAppLanguage: "ar",
  };
  assert.equal(campaignWantsWhatsAppDocument(emptyDoc), false);
  const emptyName: WhatsAppDocumentGateInput = {
    whatsappDocumentUploadId: "upl-abc123",
    templateWhatsAppName: "",
    templateWhatsAppLanguage: "ar",
  };
  assert.equal(campaignWantsWhatsAppDocument(emptyName), false);
  const emptyLang: WhatsAppDocumentGateInput = {
    whatsappDocumentUploadId: "upl-abc123",
    templateWhatsAppName: "moather2026_moather2026",
    templateWhatsAppLanguage: "",
  };
  assert.equal(campaignWantsWhatsAppDocument(emptyLang), false);
});
