import type { WhatsAppDocumentRef, WhatsAppMessage } from "../types";
import { render } from "@/lib/template";

// P13 — WhatsApp message-shape planner.
//
// Pure decision function. Takes the narrow slice of Campaign data
// needed to decide template-vs-text + an already-built interpolation
// `vars` map + the recipient's phone number, and returns either a
// `WhatsAppMessage` ready to hand to `WhatsAppProvider.send(...)` or a
// structured reason why no valid message could be built.
//
// Why this lives in its own module (and not inside delivery.ts):
//   - The decision logic branches on campaign state AND a policy
//     state (24h session window) the DB doesn't model. Keeping it
//     pure makes every branch unit-testable with plain data; the
//     Prisma + provider wiring that uses it stays trivial.
//   - Meta's template-vs-text discipline is a correctness seam, not
//     an ergonomics one. If we get it wrong the operator thinks they
//     sent an invite that Meta actually rejected. Pinning each branch
//     with a named test makes a regression loud.
//   - The caller (sendWhatsApp in a later P13 slice) stays free to
//     handle the result uniformly: pass `.message` to the provider
//     on success, translate `.reason` into an Invitation.error on
//     failure — no branching on schema fields at the delivery layer.
//
// The planner deliberately does NOT import Prisma. `WhatsAppPlanCampaign`
// is a local shape that matches what a `select: { ... }` call on
// Campaign produces; tests supply it as a plain object, and future
// callers build it from whatever row shape they have.

// Narrow Campaign view — just the fields the planner reads. This
// stays decoupled from Prisma's generated `Campaign` so tests don't
// need a full row and a future schema change (e.g. renaming a field)
// only touches this shape if the planner's inputs actually change.
export type WhatsAppPlanCampaign = {
  templateWhatsAppName: string | null;
  templateWhatsAppLanguage: string | null;
  // JSON-encoded array of positional expression strings. Null means
  // "no variables" — the template is sent with no BODY parameters,
  // which Meta allows for templates whose BODY has no {{n}} slots.
  templateWhatsAppVariables: string | null;
  // Fallback body text for the in-session path. Reused from the SMS
  // column — WhatsApp session text and SMS have identical content
  // discipline (plain text, no template). A dedicated WhatsApp text
  // column is an easy future extension if SMS ergonomics diverge.
  templateSms: string | null;
  // P17-C.2 — WhatsApp header-document upload ref. When set (and the
  // template fields above are also set), the planner adds a
  // `headerDocument` to the template message. Null / empty means the
  // plain template path (P17-A). The planner emits a placeholder
  // `{ kind: "link", link: "/api/files/{id}" }` ref — the chat
  // confirm_send path (P17-C.3) intercepts plans with a link-ref and
  // swaps them for a Meta `{ kind: "id", mediaId, filename }` after
  // uploading the bytes via the Taqnyat media endpoint. Keeping the
  // planner output "link-only" preserves its purity (no I/O); the
  // ref-swap happens at the delivery edge.
  whatsappDocumentUploadId: string | null;
};

export type WhatsAppPlanInput = {
  campaign: WhatsAppPlanCampaign;
  // Recipient phone in whatever format the provider expects. The
  // planner is format-agnostic — it just copies `to` through to the
  // output message. Normalization (E.164 strip, `+`/`00` prefix) is
  // the caller's concern.
  to: string;
  // Pre-built interpolation context. The same shape preview.ts's
  // `renderSms` / `renderEmail` helpers use. Keys include `name`,
  // `venue`, `eventAt`, `rsvpUrl`, etc. Unknown keys in the template
  // expressions render as empty strings (consistent with render's
  // behavior — see template.ts).
  vars: Record<string, string>;
  // Whether the recipient is inside Meta's 24h session window. The
  // planner can't determine this itself (it has no access to inbound
  // history); callers that know — e.g. a "reply to an incoming
  // WhatsApp message" flow — pass true. Default false: campaigns
  // sending to cold recipients cannot use session text.
  sessionOpen?: boolean;
};

export type WhatsAppPlanResult =
  | { ok: true; message: WhatsAppMessage }
  // "no_template":             neither a template is configured nor a
  //                            session-text path is open with body
  //                            text available. Caller should surface
  //                            this as a blocker / Invitation.error.
  // "template_vars_malformed": templateWhatsAppVariables is non-null
  //                            but not a JSON array of strings. The
  //                            operator's configuration is broken;
  //                            caller should refuse the whole send
  //                            rather than silently drop variables.
  | { ok: false; reason: "no_template" | "template_vars_malformed" };

export function decideWhatsAppMessage(
  input: WhatsAppPlanInput,
): WhatsAppPlanResult {
  const { campaign, to, vars, sessionOpen } = input;

  // Rule 1: template-first. Business-initiated conversations on
  // Meta REQUIRE an approved template — this is the primary path
  // for any campaign send. Both name AND language must be set;
  // Meta identifies a template by (name, language) as a pair.
  if (
    campaign.templateWhatsAppName !== null &&
    campaign.templateWhatsAppName.length > 0 &&
    campaign.templateWhatsAppLanguage !== null &&
    campaign.templateWhatsAppLanguage.length > 0
  ) {
    let variables: string[] | undefined;
    if (campaign.templateWhatsAppVariables !== null) {
      const parsed = tryParseStringArray(campaign.templateWhatsAppVariables);
      if (!parsed.ok) {
        return { ok: false, reason: "template_vars_malformed" };
      }
      // Interpolate each positional expression against the vars map.
      // An expression that references an unknown key becomes empty
      // string — same behavior as the other renderers. The operator
      // is responsible for keeping the variable expressions in sync
      // with the template's {{1}}, {{2}} slot count on Meta's side;
      // a shorter array just means trailing slots stay as Meta's
      // default empty substitution.
      variables = parsed.value.map((expr) => render(expr, vars));
    }
    // P17-C.2 — doc-header enrichment. The three-field gate
    // (`campaignWantsWhatsAppDocument`) is co-located in this module;
    // inside Rule 1 the name/language checks are redundant with the
    // ones above, but calling the predicate keeps the doc-readiness
    // semantics in exactly one place. If it returns true, attach a
    // placeholder `link` ref pointing at our own `/api/files/{id}`
    // route. The chat confirm_send edge (P17-C.3) intercepts this
    // link shape, reads the FileUpload bytes, uploads to Meta via
    // the Taqnyat media endpoint, and swaps the ref to a
    // `{ kind: "id", mediaId, filename }` before handing the
    // message to the provider. The link here is therefore a
    // sentinel — Meta itself never fetches it. Filename is omitted
    // deliberately: C.3 supplies it from `FileUpload.filename` when
    // it builds the final ref, and carrying a filename through the
    // intermediate state would just be dead data.
    let headerDocument: WhatsAppDocumentRef | undefined;
    if (
      campaignWantsWhatsAppDocument({
        whatsappDocumentUploadId: campaign.whatsappDocumentUploadId,
        templateWhatsAppName: campaign.templateWhatsAppName,
        templateWhatsAppLanguage: campaign.templateWhatsAppLanguage,
      })
    ) {
      headerDocument = {
        kind: "link",
        // The `!` is safe: the predicate above returned true only
        // if this field is non-null and non-empty.
        link: `/api/files/${campaign.whatsappDocumentUploadId!}`,
      };
    }
    return {
      ok: true,
      message: {
        kind: "template",
        to,
        templateName: campaign.templateWhatsAppName,
        languageCode: campaign.templateWhatsAppLanguage,
        variables,
        ...(headerDocument !== undefined ? { headerDocument } : {}),
      },
    };
  }

  // Rule 2: session-text fallback. Only valid when the caller has
  // explicitly asserted `sessionOpen === true`. A default of
  // `undefined` / `false` is deliberately treated as "not safe" —
  // Meta returns a policy error on session-text outside the window,
  // and that error isn't something the operator can fix after the
  // fact; the whole send would fail and retries wouldn't help. So
  // the planner refuses session-text unless the caller has a
  // concrete reason to believe the window is open.
  if (
    sessionOpen === true &&
    campaign.templateSms !== null &&
    campaign.templateSms.length > 0
  ) {
    return {
      ok: true,
      message: {
        kind: "text",
        to,
        text: render(campaign.templateSms, vars),
      },
    };
  }

  // Rule 3: no path to a valid message. Common cases: campaign has
  // no WhatsApp template AND no session is open (cold send), or
  // the operator has only one of name/language set (Meta needs both).
  return { ok: false, reason: "no_template" };
}

// P17-C.1 — WhatsApp document-header readiness gate.
//
// Pure predicate: does the campaign have everything it needs to use
// Meta's template header-document component? Three conditions, all
// required:
//
//   1. A FileUpload id to attach (the PDF bytes live here).
//   2. A template name — Meta only accepts a header document on a
//      template message, not a free-form text message. A doc ref
//      without a template would be a config error.
//   3. A template language code — Meta keys templates on the
//      (name, language) pair. Mirrors the planner's rule-1 discipline
//      a few lines above.
//
// Empty-string fields count as "missing" (a length-0 value in any
// of these columns is still unusable). Callers get a clean boolean
// without having to repeat the three-field check at each site.
//
// Narrow input shape — callers (the planner, confirm-time checkers,
// future widget readiness lines) can pass a minimal projection and
// don't have to construct a full `WhatsAppPlanCampaign`.
export type WhatsAppDocumentGateInput = {
  whatsappDocumentUploadId: string | null;
  templateWhatsAppName: string | null;
  templateWhatsAppLanguage: string | null;
};

export function campaignWantsWhatsAppDocument(
  input: WhatsAppDocumentGateInput,
): boolean {
  if (
    input.whatsappDocumentUploadId === null ||
    input.whatsappDocumentUploadId.length === 0
  ) {
    return false;
  }
  if (
    input.templateWhatsAppName === null ||
    input.templateWhatsAppName.length === 0
  ) {
    return false;
  }
  if (
    input.templateWhatsAppLanguage === null ||
    input.templateWhatsAppLanguage.length === 0
  ) {
    return false;
  }
  return true;
}

// Local JSON-array validator. Returns a tagged result so the caller
// can distinguish "parse failed" from "empty array" — both legitimate
// states with different treatments (empty array is a valid zero-var
// template; parse failure is a config error).
function tryParseStringArray(
  s: string,
): { ok: true; value: string[] } | { ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return { ok: false };
  }
  if (!Array.isArray(parsed)) return { ok: false };
  for (const entry of parsed) {
    if (typeof entry !== "string") return { ok: false };
  }
  return { ok: true, value: parsed as string[] };
}
