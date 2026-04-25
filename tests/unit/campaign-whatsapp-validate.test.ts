import { test } from "node:test";
import assert from "node:assert/strict";

import { validateWhatsAppCampaignFields } from "../../src/lib/campaign-whatsapp-validate";

function mkFields(
  overrides: Partial<{
    templateWhatsAppName: string | null;
    templateWhatsAppLanguage: string | null;
    templateWhatsAppVariables: string | null;
    whatsappDocumentUploadId: string | null;
  }> = {},
) {
  return {
    templateWhatsAppName: null,
    templateWhatsAppLanguage: null,
    templateWhatsAppVariables: null,
    whatsappDocumentUploadId: null,
    ...overrides,
  };
}

test("empty WhatsApp setup is valid", () => {
  const result = validateWhatsAppCampaignFields(mkFields());
  assert.equal(result.ok, true);
});

test("partial template pair is rejected", () => {
  const result = validateWhatsAppCampaignFields(
    mkFields({ templateWhatsAppName: "moather2026_moather2026" }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.text, "WhatsApp template is incomplete");
});

test("pdf without template is rejected", () => {
  const result = validateWhatsAppCampaignFields(
    mkFields({ whatsappDocumentUploadId: "upload-123" }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.text, "WhatsApp template is required");
});

test("approved document template requires a PDF", () => {
  const result = validateWhatsAppCampaignFields(
    mkFields({
      templateWhatsAppName: "moather2026_moather2026",
      templateWhatsAppLanguage: "ar",
      whatsappDocumentUploadId: null,
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.text, "Invitation PDF is required");
});

test("approved document template with PDF is valid", () => {
  const result = validateWhatsAppCampaignFields(
    mkFields({
      templateWhatsAppName: "moather2026_moather2026",
      templateWhatsAppLanguage: "ar",
      whatsappDocumentUploadId: "upload-123",
    }),
  );
  assert.equal(result.ok, true);
});

test("custom malformed variables are rejected", () => {
  const result = validateWhatsAppCampaignFields(
    mkFields({
      templateWhatsAppName: "custom_template",
      templateWhatsAppLanguage: "ar",
      templateWhatsAppVariables: "{bad-json",
    }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.text, "WhatsApp advanced variables are invalid");
});
