import { test } from "node:test";
import assert from "node:assert/strict";

import { applyCampaignTemplatePrefill } from "../../src/lib/campaign-template-prefill";

test("applies email and SMS library templates onto the campaign draft together", () => {
  const out = applyCampaignTemplatePrefill(
    { locale: "ar", subjectEmail: null, templateEmail: null, templateSms: null },
    {
      kind: "email",
      subject: "Invitation subject",
      body: "Email body",
    },
    {
      kind: "sms",
      subject: null,
      body: "SMS body",
    },
  );

  assert.deepEqual(out, {
    locale: "ar",
    subjectEmail: "Invitation subject",
    templateEmail: "Email body",
    templateSms: "SMS body",
  });
});

test("leaves unrelated campaign fields intact when only SMS copy is applied", () => {
  const out = applyCampaignTemplatePrefill(
    {
      name: "National reception",
      venue: "Riyadh",
      subjectEmail: "Existing subject",
      templateEmail: "Existing body",
      templateSms: null,
    },
    null,
    {
      kind: "sms",
      subject: null,
      body: "New SMS body",
    },
  );

  assert.deepEqual(out, {
    name: "National reception",
    venue: "Riyadh",
    subjectEmail: "Existing subject",
    templateEmail: "Existing body",
    templateSms: "New SMS body",
  });
});
