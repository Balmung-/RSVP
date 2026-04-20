import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decideWhatsAppMessage,
  type WhatsAppPlanCampaign,
  type WhatsAppPlanInput,
} from "../../src/lib/providers/whatsapp/sendPlan";

// P13-A — WhatsApp message-shape planner.
//
// Pins every decision branch:
//   Rule 1 (template): templateWhatsAppName + language set → template message
//   Rule 2 (session text): sessionOpen + templateSms set → text message
//   Rule 3 (no path): neither → reason:"no_template"
//   Malformed variables: reason:"template_vars_malformed"
//
// Also pins rule ORDERING (template wins over session text) and the
// edge cases around empty / null / partial config — each of which
// the operator could realistically produce by saving a partial
// template config in the campaign-edit UI.

// ---- Fixtures ----------------------------------------------------

// The vars map callers build from (campaign + recipient). Same
// shape preview.ts's `vars()` produces. Kept as a constant so tests
// assert on specific interpolated values instead of re-deriving.
const VARS: Record<string, string> = {
  name: "Ahmed",
  title: "CTO",
  organization: "Acme",
  campaign: "Spring Gala",
  venue: "Four Seasons",
  eventAt: "12 May 2026, 19:00",
  rsvpUrl: "https://app.example/rsvp/TOKEN",
  unsubscribeUrl: "https://app.example/unsubscribe/TOKEN",
  brand: "Einai",
};

const TO = "966501234567";

function mkCampaign(
  overrides: Partial<WhatsAppPlanCampaign> = {},
): WhatsAppPlanCampaign {
  return {
    templateWhatsAppName: null,
    templateWhatsAppLanguage: null,
    templateWhatsAppVariables: null,
    templateSms: null,
    ...overrides,
  };
}

function mkInput(
  overrides: Partial<WhatsAppPlanInput> = {},
): WhatsAppPlanInput {
  return {
    campaign: mkCampaign(),
    to: TO,
    vars: VARS,
    ...overrides,
  };
}

// ---- Rule 1: template-first --------------------------------------

test("template: name + language + null variables → template message with variables:undefined", async () => {
  // A template whose BODY has no {{n}} slots is valid on Meta — the
  // adapter must send it without a parameters array. `variables:
  // undefined` (not []) signals that. Downstream the Taqnyat adapter
  // omits the components field entirely.
  const r = decideWhatsAppMessage(
    mkInput({
      campaign: mkCampaign({
        templateWhatsAppName: "rsvp_no_vars",
        templateWhatsAppLanguage: "ar",
        templateWhatsAppVariables: null,
      }),
    }),
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.message, {
    kind: "template",
    to: TO,
    templateName: "rsvp_no_vars",
    languageCode: "ar",
    variables: undefined,
  });
});

test("template: name + language + explicit variables array → positional variables interpolated", async () => {
  // The variable expressions go through `render()` against the vars
  // map. Operators write "{{name}}" as an expression string; the
  // planner resolves it to "Ahmed" and hands the plain string to
  // Meta. This decouples Meta's opaque {{1}}, {{2}} positional slots
  // from the operator-friendly named-variable language.
  const r = decideWhatsAppMessage(
    mkInput({
      campaign: mkCampaign({
        templateWhatsAppName: "rsvp_invitation_v1",
        templateWhatsAppLanguage: "en_US",
        templateWhatsAppVariables: JSON.stringify([
          "{{name}}",
          "{{venue}}",
          "{{eventAt}}",
        ]),
      }),
    }),
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.message.kind, "template");
  if (r.message.kind !== "template") return;
  assert.deepEqual(r.message.variables, [
    "Ahmed",
    "Four Seasons",
    "12 May 2026, 19:00",
  ]);
});

test("template: empty variables array `[]` → variables:[] (distinguishable from undefined)", async () => {
  // Meta treats a template-with-zero-BODY-params the same way as one
  // without a components field, but the distinction matters here for
  // a subtle reason: the Taqnyat adapter's `length > 0` check
  // excludes the components field when variables is empty OR
  // undefined. Both produce identical wire bytes, but the distinction
  // in TypeScript lets tests assert exactly what the operator
  // configured. If the operator saved "[]", that's intentional; if
  // they saved nothing, that's a different intent.
  const r = decideWhatsAppMessage(
    mkInput({
      campaign: mkCampaign({
        templateWhatsAppName: "rsvp_empty_vars",
        templateWhatsAppLanguage: "ar",
        templateWhatsAppVariables: "[]",
      }),
    }),
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.message.kind, "template");
  if (r.message.kind !== "template") return;
  assert.deepEqual(r.message.variables, []);
});

test("template: unknown var expression → resolves to empty string (not error)", async () => {
  // Defensive: if the operator writes a typo like {{organisation}}
  // (British spelling) and the vars map has {{organization}}, the
  // render helper returns "". The planner must NOT reject — that
  // would turn a typo into a whole-campaign send failure. Instead
  // Meta receives an empty positional parameter, which is visible in
  // the rendered message but not fatal. The operator can fix it.
  const r = decideWhatsAppMessage(
    mkInput({
      campaign: mkCampaign({
        templateWhatsAppName: "rsvp_typo",
        templateWhatsAppLanguage: "en_US",
        templateWhatsAppVariables: JSON.stringify([
          "{{name}}",
          "{{organisation}}", // typo: should be organization
        ]),
      }),
    }),
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.message.kind, "template");
  if (r.message.kind !== "template") return;
  assert.deepEqual(r.message.variables, ["Ahmed", ""]);
});

test("template: mixed literal + interpolation in a single expression → partial interpolation", async () => {
  // An expression like "Dear {{name}}," should render with "Dear "
  // and "," preserved literal + "Ahmed" interpolated. This is the
  // same render() discipline email/sms use.
  const r = decideWhatsAppMessage(
    mkInput({
      campaign: mkCampaign({
        templateWhatsAppName: "rsvp_greeting",
        templateWhatsAppLanguage: "en_US",
        templateWhatsAppVariables: JSON.stringify(["Dear {{name}},"]),
      }),
    }),
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.message.kind, "template");
  if (r.message.kind !== "template") return;
  assert.deepEqual(r.message.variables, ["Dear Ahmed,"]);
});

// ---- Malformed variables JSON -----------------------------------

test("variables: non-JSON string → reason:template_vars_malformed", async () => {
  // Operator pasted garbage into the variables field. Fail the send
  // rather than sending a template with no positional params (which
  // would render as "Hello ," on Meta's side — worse than a clean
  // refusal).
  const r = decideWhatsAppMessage(
    mkInput({
      campaign: mkCampaign({
        templateWhatsAppName: "x",
        templateWhatsAppLanguage: "en_US",
        templateWhatsAppVariables: "not-json{{{",
      }),
    }),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "template_vars_malformed");
});

test("variables: JSON object (not array) → reason:template_vars_malformed", async () => {
  // Operator might have typed `{"name": "..."}` thinking it's a
  // named-map. Wrong shape — Meta needs a positional array. Refuse.
  const r = decideWhatsAppMessage(
    mkInput({
      campaign: mkCampaign({
        templateWhatsAppName: "x",
        templateWhatsAppLanguage: "en_US",
        templateWhatsAppVariables: '{"name": "Ahmed"}',
      }),
    }),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "template_vars_malformed");
});

test("variables: array containing non-string → reason:template_vars_malformed", async () => {
  // render() signature is string -> string. A number, boolean, or
  // nested object in the array would crash the interpolation step
  // or silently stringify. Reject at the planner boundary.
  const r = decideWhatsAppMessage(
    mkInput({
      campaign: mkCampaign({
        templateWhatsAppName: "x",
        templateWhatsAppLanguage: "en_US",
        templateWhatsAppVariables: JSON.stringify(["{{name}}", 42]),
      }),
    }),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "template_vars_malformed");
});

test("variables: array containing null → reason:template_vars_malformed", async () => {
  // Same as above but specifically null, which JSON.parse produces
  // for `null` entries.
  const r = decideWhatsAppMessage(
    mkInput({
      campaign: mkCampaign({
        templateWhatsAppName: "x",
        templateWhatsAppLanguage: "en_US",
        templateWhatsAppVariables: JSON.stringify(["{{name}}", null]),
      }),
    }),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "template_vars_malformed");
});

// ---- Template name/language partials ----------------------------

test("template: name set but language null → reason:no_template (Meta requires both)", async () => {
  // Meta identifies templates by (name, language). A name without
  // a language is ambiguous — the campaign-edit UI should force
  // both, but if the schema ever gets into this state, the planner
  // must refuse rather than pick a locale default.
  const r = decideWhatsAppMessage(
    mkInput({
      campaign: mkCampaign({
        templateWhatsAppName: "rsvp_invitation_v1",
        templateWhatsAppLanguage: null,
      }),
    }),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "no_template");
});

test("template: language set but name null → reason:no_template", async () => {
  const r = decideWhatsAppMessage(
    mkInput({
      campaign: mkCampaign({
        templateWhatsAppName: null,
        templateWhatsAppLanguage: "ar",
      }),
    }),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "no_template");
});

test("template: name empty string → reason:no_template (empty ≠ configured)", async () => {
  // "" is what a Prisma row with a cleared text input might produce.
  // Treat it as unconfigured rather than passing the empty string to
  // Meta (which would reject with its own error, worse UX).
  const r = decideWhatsAppMessage(
    mkInput({
      campaign: mkCampaign({
        templateWhatsAppName: "",
        templateWhatsAppLanguage: "ar",
      }),
    }),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "no_template");
});

test("template: language empty string → reason:no_template", async () => {
  const r = decideWhatsAppMessage(
    mkInput({
      campaign: mkCampaign({
        templateWhatsAppName: "x",
        templateWhatsAppLanguage: "",
      }),
    }),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "no_template");
});

// ---- Rule 2: session text ---------------------------------------

test("session text: sessionOpen=true + templateSms set → kind:text with interpolated body", async () => {
  const r = decideWhatsAppMessage(
    mkInput({
      campaign: mkCampaign({
        templateSms: "Hi {{name}}, see you at {{venue}}.",
      }),
      sessionOpen: true,
    }),
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.message, {
    kind: "text",
    to: TO,
    text: "Hi Ahmed, see you at Four Seasons.",
  });
});

test("session text: sessionOpen=true + templateSms null → reason:no_template", async () => {
  // Can't send session text without body content.
  const r = decideWhatsAppMessage(
    mkInput({
      campaign: mkCampaign({ templateSms: null }),
      sessionOpen: true,
    }),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "no_template");
});

test("session text: sessionOpen=true + templateSms empty string → reason:no_template", async () => {
  // Empty SMS template isn't a body. Refuse.
  const r = decideWhatsAppMessage(
    mkInput({
      campaign: mkCampaign({ templateSms: "" }),
      sessionOpen: true,
    }),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "no_template");
});

test("session text: sessionOpen=false + templateSms set → reason:no_template (window closed)", async () => {
  // This is the key policy invariant. Meta rejects session text sent
  // outside the 24h window with a policy error that the operator
  // can't fix post-hoc. Refusing at the planner boundary means the
  // operator sees a clear "no WhatsApp template configured" error
  // instead of a confusing provider-side rejection that happens only
  // for some recipients (those whose window has elapsed).
  const r = decideWhatsAppMessage(
    mkInput({
      campaign: mkCampaign({ templateSms: "Hi {{name}}" }),
      sessionOpen: false,
    }),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "no_template");
});

test("session text: sessionOpen undefined (default) + templateSms set → reason:no_template", async () => {
  // Default is "not safe." Callers must opt in by explicitly passing
  // true. This keeps accidental omission fail-closed.
  const r = decideWhatsAppMessage(
    mkInput({
      campaign: mkCampaign({ templateSms: "Hi {{name}}" }),
      // sessionOpen omitted
    }),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "no_template");
});

// ---- Rule ordering: template wins over session text -------------

test("ordering: template configured AND sessionOpen+templateSms → template wins", async () => {
  // If the operator has configured a template, use it — even if the
  // recipient is inside the session window. Templates are safer
  // (pre-approved by Meta), so they're the default when both paths
  // are available. This also means that reconfiguring a campaign to
  // add a template never silently changes behavior for in-session
  // recipients: they all get the template from that point on.
  const r = decideWhatsAppMessage(
    mkInput({
      campaign: mkCampaign({
        templateWhatsAppName: "rsvp_v1",
        templateWhatsAppLanguage: "ar",
        templateWhatsAppVariables: JSON.stringify(["{{name}}"]),
        templateSms: "fallback SMS: Hi {{name}}",
      }),
      sessionOpen: true,
    }),
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.message.kind, "template");
  if (r.message.kind !== "template") return;
  assert.equal(r.message.templateName, "rsvp_v1");
  assert.deepEqual(r.message.variables, ["Ahmed"]);
});

// ---- Rule 3: neither path available -----------------------------

test("no paths: no template + no session + no templateSms → reason:no_template", async () => {
  // Empty campaign — the most common case for a campaign created
  // before WhatsApp was configured. Clean refusal; the caller marks
  // the Invitation failed with error="no_template" so the operator
  // can see "configure a WhatsApp template to send via this channel."
  const r = decideWhatsAppMessage(mkInput({ campaign: mkCampaign() }));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "no_template");
});

// ---- Pass-through invariants ------------------------------------

test("pass-through: `to` is copied verbatim into the message", async () => {
  // The planner doesn't normalize the phone — callers that need
  // stripping of + / 00 / etc do that first. Proving this pin means
  // a future refactor that accidentally reformats `to` (e.g. "helpful"
  // concat of a country code) breaks this test loudly.
  const weirdTo = "00966-50-123-4567";
  const r = decideWhatsAppMessage(
    mkInput({
      campaign: mkCampaign({
        templateWhatsAppName: "x",
        templateWhatsAppLanguage: "ar",
      }),
      to: weirdTo,
    }),
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.message.to, weirdTo);
});

test("pass-through: empty vars map → all expressions render to empty strings", async () => {
  // Edge case — a caller that didn't build a vars map. Not an error;
  // the template just comes out with blanks. This is the same
  // behavior render() has for unknown keys.
  const r = decideWhatsAppMessage(
    mkInput({
      campaign: mkCampaign({
        templateWhatsAppName: "x",
        templateWhatsAppLanguage: "ar",
        templateWhatsAppVariables: JSON.stringify(["{{name}}", "{{venue}}"]),
      }),
      vars: {},
    }),
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.message.kind, "template");
  if (r.message.kind !== "template") return;
  assert.deepEqual(r.message.variables, ["", ""]);
});
