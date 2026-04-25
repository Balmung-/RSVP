import { test } from "node:test";
import assert from "node:assert/strict";

import { parseWhatsAppCampaignFields } from "../../src/lib/campaign-whatsapp-form";

// P17-D.1 — pure parser pins for the four WhatsApp-campaign fields.
// The parser is the seam between the campaign create/edit server
// actions and the Prisma write layer; it's the last chance to shape
// raw FormData into the `{ field: string | null }` discipline the
// rest of the stack assumes. These tests pin the contract so
// refactors (or a later-landed validation layer) can't drift it
// silently:
//
//  - all four fields are independently optional (no both-or-neither
//    enforcement — the `no_whatsapp_template` / `no_whatsapp_document`
//    blockers catch gaps at send time);
//  - whitespace-only inputs round-trip to `null`, not `""`, so the
//    Prisma nullable discipline holds;
//  - at-cap values pass through verbatim (boundary pin — a
//    `< max` vs `<= max` flip would corrupt legitimate input);
//  - over-cap values clip to exactly `max` chars;
//  - non-string FormData entries (e.g. File blobs from a misconfigured
//    <input type="file">) are ignored and yield `null` rather than
//    `"[object File]"`.
//
// The parser is deliberately DB-free; the FK existence check for
// `whatsappDocumentUploadId` is the server action's responsibility
// and is covered by integration-level scope rather than this file.

function fd(entries: Record<string, string | Blob>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

// Length caps — kept in sync with the constants in the parser module.
// Duplicated here on purpose: if the parser cap changes, the test
// fails loudly and forces a conscious update of both sides.
const NAME_MAX = 200;
const LANGUAGE_MAX = 10;
const VARIABLES_MAX = 2000;
const UPLOAD_ID_MAX = 50;

// --- empty / absent ---------------------------------------------

test("empty FormData → all four fields null", () => {
  const out = parseWhatsAppCampaignFields(new FormData());
  assert.equal(out.templateWhatsAppName, null);
  assert.equal(out.templateWhatsAppLanguage, null);
  assert.equal(out.templateWhatsAppVariables, null);
  assert.equal(out.whatsappDocumentUploadId, null);
});

test("whitespace-only values round-trip to null", () => {
  const out = parseWhatsAppCampaignFields(
    fd({
      templateWhatsAppName: "   ",
      templateWhatsAppLanguage: "\t\n ",
      templateWhatsAppVariables: "  \r\n  ",
      whatsappDocumentUploadId: " ",
    }),
  );
  assert.equal(out.templateWhatsAppName, null);
  assert.equal(out.templateWhatsAppLanguage, null);
  assert.equal(out.templateWhatsAppVariables, null);
  assert.equal(out.whatsappDocumentUploadId, null);
});

// --- trim + happy path ------------------------------------------

test("happy path: all four fields trimmed + preserved", () => {
  const out = parseWhatsAppCampaignFields(
    fd({
      templateWhatsAppName: "  moather2026_moather2026  ",
      templateWhatsAppLanguage: "  en_US  ",
      templateWhatsAppVariables: '  ["{{name}}","{{venue}}"]  ',
      whatsappDocumentUploadId: "  clx12345abcde67890fghij  ",
    }),
  );
  assert.equal(out.templateWhatsAppName, "moather2026_moather2026");
  assert.equal(out.templateWhatsAppLanguage, "en_US");
  assert.equal(out.templateWhatsAppVariables, '["{{name}}","{{venue}}"]');
  assert.equal(out.whatsappDocumentUploadId, "clx12345abcde67890fghij");
});

test("approved preset fills template name and language without free-typing them", () => {
  const out = parseWhatsAppCampaignFields(
    fd({
      templateWhatsAppPreset: "invite-pdf-ar",
      whatsappDocumentUploadId: "clx12345abcde67890fghij",
    }),
  );
  assert.equal(out.templateWhatsAppName, "moather2026_moather2026");
  assert.equal(out.templateWhatsAppLanguage, "ar");
  assert.equal(out.whatsappDocumentUploadId, "clx12345abcde67890fghij");
});

test("approved zero-var preset drops stale advanced variables", () => {
  const out = parseWhatsAppCampaignFields(
    fd({
      templateWhatsAppPreset: "invite-pdf-ar",
      templateWhatsAppVariables: "{stale-json",
    }),
  );
  assert.equal(out.templateWhatsAppName, "moather2026_moather2026");
  assert.equal(out.templateWhatsAppLanguage, "ar");
  assert.equal(out.templateWhatsAppVariables, null);
});

test("unknown preset falls back to raw typed fields instead of wiping them", () => {
  const out = parseWhatsAppCampaignFields(
    fd({
      templateWhatsAppPreset: "unknown-template",
      templateWhatsAppName: "manual_name",
      templateWhatsAppLanguage: "ar",
    }),
  );
  assert.equal(out.templateWhatsAppName, "manual_name");
  assert.equal(out.templateWhatsAppLanguage, "ar");
});

test("permissive: name-only campaign allowed (both-or-neither not enforced)", () => {
  // Matches the existing `templateEmail` / `subjectEmail` discipline:
  // the form accepts partial config; `no_whatsapp_template` blocker
  // surfaces the gap at send time.
  const out = parseWhatsAppCampaignFields(
    fd({ templateWhatsAppName: "only_name" }),
  );
  assert.equal(out.templateWhatsAppName, "only_name");
  assert.equal(out.templateWhatsAppLanguage, null);
  assert.equal(out.templateWhatsAppVariables, null);
  assert.equal(out.whatsappDocumentUploadId, null);
});

test("permissive: language-only campaign allowed (both-or-neither not enforced)", () => {
  const out = parseWhatsAppCampaignFields(
    fd({ templateWhatsAppLanguage: "ar" }),
  );
  assert.equal(out.templateWhatsAppName, null);
  assert.equal(out.templateWhatsAppLanguage, "ar");
});

test("permissive: variables-only (no name/language) allowed", () => {
  // Doesn't make operational sense, but the parser doesn't enforce
  // combinations — the blocker layer does. Pinning so a later
  // zod-ification doesn't accidentally tighten here.
  const out = parseWhatsAppCampaignFields(
    fd({ templateWhatsAppVariables: '["x"]' }),
  );
  assert.equal(out.templateWhatsAppVariables, '["x"]');
  assert.equal(out.templateWhatsAppName, null);
  assert.equal(out.templateWhatsAppLanguage, null);
});

// --- cap boundaries ---------------------------------------------

test("at-NAME_MAX preserved verbatim", () => {
  const name = "n".repeat(NAME_MAX);
  const out = parseWhatsAppCampaignFields(
    fd({ templateWhatsAppName: name }),
  );
  assert.equal(out.templateWhatsAppName, name);
  assert.equal(out.templateWhatsAppName?.length, NAME_MAX);
});

test("over-NAME_MAX clipped to exactly NAME_MAX chars", () => {
  const name = "n".repeat(NAME_MAX + 50);
  const out = parseWhatsAppCampaignFields(
    fd({ templateWhatsAppName: name }),
  );
  assert.equal(out.templateWhatsAppName?.length, NAME_MAX);
});

test("at-LANGUAGE_MAX preserved (worst-case BCP-47: `zh_Hant_HK`)", () => {
  // 10 chars — the justification for the cap in the parser.
  const lang = "zh_Hant_HK";
  assert.equal(lang.length, LANGUAGE_MAX);
  const out = parseWhatsAppCampaignFields(
    fd({ templateWhatsAppLanguage: lang }),
  );
  assert.equal(out.templateWhatsAppLanguage, lang);
});

test("over-LANGUAGE_MAX clipped to exactly LANGUAGE_MAX chars", () => {
  const out = parseWhatsAppCampaignFields(
    fd({ templateWhatsAppLanguage: "x".repeat(LANGUAGE_MAX + 5) }),
  );
  assert.equal(out.templateWhatsAppLanguage?.length, LANGUAGE_MAX);
});

test("at-VARIABLES_MAX preserved verbatim", () => {
  const vars = "v".repeat(VARIABLES_MAX);
  const out = parseWhatsAppCampaignFields(
    fd({ templateWhatsAppVariables: vars }),
  );
  assert.equal(out.templateWhatsAppVariables?.length, VARIABLES_MAX);
});

test("over-VARIABLES_MAX clipped to exactly VARIABLES_MAX chars", () => {
  const out = parseWhatsAppCampaignFields(
    fd({ templateWhatsAppVariables: "v".repeat(VARIABLES_MAX + 123) }),
  );
  assert.equal(out.templateWhatsAppVariables?.length, VARIABLES_MAX);
});

test("at-UPLOAD_ID_MAX preserved", () => {
  const id = "u".repeat(UPLOAD_ID_MAX);
  const out = parseWhatsAppCampaignFields(
    fd({ whatsappDocumentUploadId: id }),
  );
  assert.equal(out.whatsappDocumentUploadId, id);
});

test("over-UPLOAD_ID_MAX clipped to exactly UPLOAD_ID_MAX chars", () => {
  const out = parseWhatsAppCampaignFields(
    fd({ whatsappDocumentUploadId: "u".repeat(UPLOAD_ID_MAX + 100) }),
  );
  assert.equal(out.whatsappDocumentUploadId?.length, UPLOAD_ID_MAX);
});

// --- store-raw-JSON discipline ----------------------------------

test("templateWhatsAppVariables stored verbatim even when malformed", () => {
  // Deliberate: the send-blocker's `template_vars_malformed` catches
  // this at send time; the parser's job is to get bytes into the DB
  // so the operator can see + fix their input in the edit form.
  const out = parseWhatsAppCampaignFields(
    fd({ templateWhatsAppVariables: 'this is not json [' }),
  );
  assert.equal(out.templateWhatsAppVariables, "this is not json [");
});

test("templateWhatsAppVariables empty-array JSON preserved", () => {
  const out = parseWhatsAppCampaignFields(
    fd({ templateWhatsAppVariables: "[]" }),
  );
  assert.equal(out.templateWhatsAppVariables, "[]");
});

// --- non-string FormData entries --------------------------------

test("non-string FormData entry (File blob) → null", () => {
  // A misconfigured <input type="file" name="templateWhatsAppName"/>
  // would deliver a File object rather than a string. The parser
  // should degrade to null rather than coerce to "[object File]" or
  // a file path.
  const blob = new Blob(["junk"], { type: "text/plain" });
  const out = parseWhatsAppCampaignFields(fd({ templateWhatsAppName: blob }));
  assert.equal(out.templateWhatsAppName, null);
});

// --- return shape pin -------------------------------------------

test("return shape: exactly the four declared keys", () => {
  const out = parseWhatsAppCampaignFields(new FormData());
  const keys = Object.keys(out).sort();
  assert.deepEqual(keys, [
    "templateWhatsAppLanguage",
    "templateWhatsAppName",
    "templateWhatsAppVariables",
    "whatsappDocumentUploadId",
  ]);
});
