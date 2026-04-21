import type {
  SendResult,
  WhatsAppDocumentMessage,
  WhatsAppDocumentRef,
  WhatsAppMessage,
  WhatsAppProvider,
  WhatsAppTemplateMessage,
  WhatsAppTextMessage,
} from "../types";

// Taqnyat WhatsApp — BSP wrapper around Meta's WhatsApp Cloud API.
//
// Docs: https://dev.taqnyat.sa/en/doc/whatsapp/
//
// Key contract differences vs the Taqnyat SMS adapter:
//   - Base URL:   https://api.taqnyat.sa/wa/v2/
//   - Endpoints:  POST /messages/           (text / template / document)
//                 POST /media/              (uploads — deferred to P17-B)
//   - Auth:       Authorization: Bearer <TAQNYAT_WHATSAPP_TOKEN>
//   - Recipients: international format WITHOUT leading `+` or `00`
//                 (same as SMS — shared normalization helper).
//   - Message-type discipline:
//       * `template` is REQUIRED to start a business-initiated
//         conversation. Taqnyat forwards to Meta, which rejects
//         free-form text outside the 24h session window.
//       * `text` is valid only inside the 24h session window; we
//         don't track session state here — Meta's policy rejection
//         surfaces as a provider error string.
//       * `document` as a standalone message is subject to the
//         same session-window rule as `text`. For business-
//         initiated delivery (the invitation-PDF case), attach
//         the document to a template with a DOCUMENT header via
//         `WhatsAppTemplateMessage.headerDocument` instead.
//
// P17-A extends the request shaping with:
//   - a `documentBody` branch for standalone in-session documents;
//   - a `header` component on templates when `headerDocument` is
//     set. The adapter only shapes the request — the referenced
//     mediaId (or link) must already exist at send time. The
//     /media upload seam is P17-B.
//
// Response shape: Taqnyat proxies Meta's response envelope. Success
// carries a `messages: [{id}]` array (Meta's WAMID). We accept that
// as the primary identifier, with `messageId` / `requestId` /
// top-level `id` as tolerant fallbacks in case Taqnyat flattens it
// on their side.
//
// Number normalization is shared with the SMS adapter — Taqnyat
// documents the same `+`/`00`-stripped format for both channels.

import { normalizeRecipient } from "../sms/taqnyat";

export type TaqnyatWhatsAppOptions = {
  token: string;
  // Optional — only some Taqnyat account setups require passing the
  // template namespace alongside the template name. The adapter
  // includes it in the request body only when non-empty, so
  // accounts that don't use it pass nothing and aren't penalized
  // by a stray empty-string field.
  templateNamespace?: string;
};

export function taqnyatWhatsApp(
  opts: TaqnyatWhatsAppOptions,
): WhatsAppProvider {
  return {
    name: "taqnyat-whatsapp",
    async send(msg: WhatsAppMessage): Promise<SendResult> {
      const to = normalizeRecipient(msg.to);
      const body = buildRequestBody(to, msg, opts.templateNamespace);
      const res = await fetch("https://api.taqnyat.sa/wa/v2/messages/", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as {
        messages?: Array<{ id?: string }>;
        messageId?: string | number;
        requestId?: string | number;
        id?: string | number;
        message?: string;
        error?: { message?: string } | string;
        statusCode?: number | string;
      };
      const id = extractId(j);
      if (res.ok && id) {
        return { ok: true, providerId: id };
      }
      const errText = extractErrorText(j);
      return {
        ok: false,
        error: `whatsapp ${res.status}: ${errText}`,
        retryable: res.status >= 500,
      };
    },
  };
}

// Exported for direct unit coverage — the request-body shape is the
// part most likely to drift against Taqnyat/Meta, and each variant
// (session text, template no-vars, template with vars, template
// with document header, standalone document) deserves explicit
// pins.
export function buildRequestBody(
  to: string,
  msg: WhatsAppMessage,
  templateNamespace: string | undefined,
): Record<string, unknown> {
  if (msg.kind === "text") {
    return textBody(to, msg);
  }
  if (msg.kind === "document") {
    return documentBody(to, msg);
  }
  return templateBody(to, msg, templateNamespace);
}

function textBody(to: string, msg: WhatsAppTextMessage): Record<string, unknown> {
  // Meta Cloud API session-text shape. Taqnyat's wa/v2 proxy accepts
  // this verbatim.
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body: msg.text },
  };
}

function documentBody(
  to: string,
  msg: WhatsAppDocumentMessage,
): Record<string, unknown> {
  // Meta Cloud API standalone-document shape.
  //   - `document.id`        when the caller references a previously-
  //                          uploaded media object;
  //   - `document.link`      when Meta should fetch the URL itself;
  //   - `document.filename`  optional; when absent Meta derives it
  //                          from the URL path (noisy for signed URLs);
  //   - `document.caption`   optional overlay under the preview.
  //                          Unlike the template-header-document
  //                          shape, standalone documents DO accept
  //                          caption.
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "document",
    document: documentRefEnvelope(msg.document, msg.caption),
  };
}

function templateBody(
  to: string,
  msg: WhatsAppTemplateMessage,
  templateNamespace: string | undefined,
): Record<string, unknown> {
  // Meta Cloud API template shape. Components are built in the
  // order Meta's renderer expects: HEADER first, BODY second,
  // BUTTONS last (not yet supported here — see P11 comment block).
  // A template is only required to include components that have
  // parameters; Meta accepts a template send without the
  // `components` key if none of the parameterised slots are set.
  const template: Record<string, unknown> = {
    name: msg.templateName,
    language: { code: msg.languageCode },
  };
  if (templateNamespace && templateNamespace.length > 0) {
    template.namespace = templateNamespace;
  }
  const components: Array<Record<string, unknown>> = [];
  if (msg.headerDocument) {
    // Header-component document parameter. Note the absence of a
    // caption field: Meta's envelope rejects `caption` inside a
    // header document parameter (caption only applies to the
    // standalone document-message shape). The shape is:
    //   { type: "header",
    //     parameters: [{ type: "document",
    //                    document: { id|link, filename? } }] }
    components.push({
      type: "header",
      parameters: [
        {
          type: "document",
          document: documentRefEnvelope(msg.headerDocument),
        },
      ],
    });
  }
  if (msg.variables && msg.variables.length > 0) {
    // Body-component parameters. Variables become positional
    // `text` parameters in the order the caller supplied.
    components.push({
      type: "body",
      parameters: msg.variables.map((v) => ({ type: "text", text: v })),
    });
  }
  if (components.length > 0) {
    template.components = components;
  }
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template,
  };
}

// Build the Meta document envelope for either a standalone document
// message (when `caption` is passed) or a template header parameter
// (when `caption` is omitted — Meta rejects caption on the header
// path). Centralised here so `filename` / `id` / `link` discipline
// stays identical across the two callers.
function documentRefEnvelope(
  ref: WhatsAppDocumentRef,
  caption?: string,
): Record<string, unknown> {
  const env: Record<string, unknown> = {};
  if (ref.kind === "id") {
    env.id = ref.mediaId;
  } else {
    env.link = ref.link;
  }
  if (ref.filename && ref.filename.length > 0) {
    env.filename = ref.filename;
  }
  if (caption !== undefined && caption.length > 0) {
    env.caption = caption;
  }
  return env;
}

function extractId(j: {
  messages?: Array<{ id?: string }>;
  messageId?: string | number;
  requestId?: string | number;
  id?: string | number;
}): string | null {
  // Primary: Meta's envelope `messages: [{id: "wamid.xxx"}]`.
  const first = j.messages?.[0]?.id;
  if (first && String(first).length > 0) return String(first);
  for (const c of [j.messageId, j.requestId, j.id]) {
    if (c === undefined || c === null) continue;
    const s = String(c);
    if (s.length > 0) return s;
  }
  return null;
}

function extractErrorText(j: {
  message?: string;
  error?: { message?: string } | string;
}): string {
  if (typeof j.error === "string") return j.error;
  if (j.error && typeof j.error === "object" && j.error.message) {
    return j.error.message;
  }
  return j.message ?? "unknown";
}
