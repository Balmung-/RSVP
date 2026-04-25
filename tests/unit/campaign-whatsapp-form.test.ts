import { test } from "node:test";
import assert from "node:assert/strict";

import { parseWhatsAppCampaignFields } from "../../src/lib/campaign-whatsapp-form";

function fd(entries: Record<string, string | Blob>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(entries)) form.set(key, value);
  return form;
}

const NAME_MAX = 200;
const LANGUAGE_MAX = 10;
const VARIABLES_MAX = 2000;
const UPLOAD_ID_MAX = 50;

test("empty form -> all WhatsApp fields null", () => {
  const out = parseWhatsAppCampaignFields(new FormData());
  assert.deepEqual(out, {
    templateWhatsAppName: null,
    templateWhatsAppLanguage: null,
    templateWhatsAppVariables: null,
    whatsappDocumentUploadId: null,
  });
});

test("approved mode fills the approved template pair", () => {
  const out = parseWhatsAppCampaignFields(
    fd({
      templateWhatsAppMode: "approved",
      templateWhatsAppPreset: "invite-pdf-ar",
      whatsappDocumentUploadId: "upl-123",
    }),
  );
  assert.equal(out.templateWhatsAppName, "moather2026_moather2026");
  assert.equal(out.templateWhatsAppLanguage, "ar");
  assert.equal(out.templateWhatsAppVariables, null);
  assert.equal(out.whatsappDocumentUploadId, "upl-123");
});

test("approved mode ignores stale custom raw fields", () => {
  const out = parseWhatsAppCampaignFields(
    fd({
      templateWhatsAppMode: "approved",
      templateWhatsAppPreset: "invite-pdf-ar",
      templateWhatsAppName: "manual_name",
      templateWhatsAppLanguage: "en",
      templateWhatsAppVariables: "{bad-json",
    }),
  );
  assert.equal(out.templateWhatsAppName, "moather2026_moather2026");
  assert.equal(out.templateWhatsAppLanguage, "ar");
  assert.equal(out.templateWhatsAppVariables, null);
});

test("custom mode preserves trimmed raw fields", () => {
  const out = parseWhatsAppCampaignFields(
    fd({
      templateWhatsAppMode: "custom",
      templateWhatsAppName: "  custom_name  ",
      templateWhatsAppLanguage: "  ar  ",
      templateWhatsAppVariables: '  ["{{name}}"]  ',
      whatsappDocumentUploadId: "  upload-abc  ",
    }),
  );
  assert.equal(out.templateWhatsAppName, "custom_name");
  assert.equal(out.templateWhatsAppLanguage, "ar");
  assert.equal(out.templateWhatsAppVariables, '["{{name}}"]');
  assert.equal(out.whatsappDocumentUploadId, "upload-abc");
});

test("off mode clears WhatsApp template fields but preserves PDF field only when posted", () => {
  const out = parseWhatsAppCampaignFields(
    fd({
      templateWhatsAppMode: "off",
      templateWhatsAppName: "manual_name",
      templateWhatsAppLanguage: "ar",
      templateWhatsAppVariables: '["x"]',
      whatsappDocumentUploadId: "upload-abc",
    }),
  );
  assert.equal(out.templateWhatsAppName, null);
  assert.equal(out.templateWhatsAppLanguage, null);
  assert.equal(out.templateWhatsAppVariables, null);
  assert.equal(out.whatsappDocumentUploadId, "upload-abc");
});

test("unknown mode falls back to off", () => {
  const out = parseWhatsAppCampaignFields(
    fd({
      templateWhatsAppMode: "mystery",
      templateWhatsAppName: "manual_name",
    }),
  );
  assert.equal(out.templateWhatsAppName, null);
  assert.equal(out.templateWhatsAppLanguage, null);
  assert.equal(out.templateWhatsAppVariables, null);
});

test("custom whitespace-only values round-trip to null", () => {
  const out = parseWhatsAppCampaignFields(
    fd({
      templateWhatsAppMode: "custom",
      templateWhatsAppName: "   ",
      templateWhatsAppLanguage: "\t\n ",
      templateWhatsAppVariables: "  \r\n  ",
      whatsappDocumentUploadId: " ",
    }),
  );
  assert.deepEqual(out, {
    templateWhatsAppName: null,
    templateWhatsAppLanguage: null,
    templateWhatsAppVariables: null,
    whatsappDocumentUploadId: null,
  });
});

test("custom values clip to their caps", () => {
  const out = parseWhatsAppCampaignFields(
    fd({
      templateWhatsAppMode: "custom",
      templateWhatsAppName: "n".repeat(NAME_MAX + 10),
      templateWhatsAppLanguage: "x".repeat(LANGUAGE_MAX + 10),
      templateWhatsAppVariables: "v".repeat(VARIABLES_MAX + 10),
      whatsappDocumentUploadId: "u".repeat(UPLOAD_ID_MAX + 10),
    }),
  );
  assert.equal(out.templateWhatsAppName?.length, NAME_MAX);
  assert.equal(out.templateWhatsAppLanguage?.length, LANGUAGE_MAX);
  assert.equal(out.templateWhatsAppVariables?.length, VARIABLES_MAX);
  assert.equal(out.whatsappDocumentUploadId?.length, UPLOAD_ID_MAX);
});

test("non-string FormData entry on custom path -> null", () => {
  const blob = new Blob(["junk"], { type: "text/plain" });
  const out = parseWhatsAppCampaignFields(
    fd({
      templateWhatsAppMode: "custom",
      templateWhatsAppName: blob,
    }),
  );
  assert.equal(out.templateWhatsAppName, null);
});

test("return shape stays the four persisted keys", () => {
  const out = parseWhatsAppCampaignFields(new FormData());
  assert.deepEqual(Object.keys(out).sort(), [
    "templateWhatsAppLanguage",
    "templateWhatsAppName",
    "templateWhatsAppVariables",
    "whatsappDocumentUploadId",
  ]);
});
