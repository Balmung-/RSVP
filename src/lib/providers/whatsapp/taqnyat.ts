import type {
  SendResult,
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
//   - Endpoints:  POST /messages/           (text / template)
//                 POST /media/              (uploads — deferred)
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
// part most likely to drift against Taqnyat/Meta, and the three
// variants (session text, template no-vars, template with vars)
// deserve explicit pins.
export function buildRequestBody(
  to: string,
  msg: WhatsAppMessage,
  templateNamespace: string | undefined,
): Record<string, unknown> {
  if (msg.kind === "text") {
    return textBody(to, msg);
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

function templateBody(
  to: string,
  msg: WhatsAppTemplateMessage,
  templateNamespace: string | undefined,
): Record<string, unknown> {
  // Meta Cloud API template shape. Variables become one BODY
  // component with positional `text` parameters in the order the
  // caller supplied.
  const template: Record<string, unknown> = {
    name: msg.templateName,
    language: { code: msg.languageCode },
  };
  if (templateNamespace && templateNamespace.length > 0) {
    template.namespace = templateNamespace;
  }
  if (msg.variables && msg.variables.length > 0) {
    template.components = [
      {
        type: "body",
        parameters: msg.variables.map((v) => ({ type: "text", text: v })),
      },
    ];
  }
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template,
  };
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
