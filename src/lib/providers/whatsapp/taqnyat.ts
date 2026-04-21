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

// ---- P17-B — media upload seam ---------------------------------
//
// `taqnyatUploadMedia` is a standalone function, NOT a method on
// `WhatsAppProvider`. Rationale:
//
//   - Media upload is a Taqnyat-specific implementation detail.
//     The stub provider (`stubWhatsApp`) has no upload to fake,
//     and future providers (360dialog, Meta direct, etc.) will
//     each expose their own upload flow — forcing an `uploadMedia`
//     method onto the interface would either pollute every stub
//     with a throw-or-return-fake branch, or introduce an
//     optional-method check at every caller.
//   - The caller for P17-C is the campaign/send wiring, which
//     can import this function directly when the WhatsApp
//     provider is Taqnyat (it will already be branching on
//     `getWhatsAppProvider().name === "taqnyat-whatsapp"` to know
//     whether the headerDocument path is supported).
//   - Keeping the interface minimal preserves the "one channel,
//     one send method" framing the rest of the app leans on.
//
// Envelope shape:
//
//   - URL:          POST https://api.taqnyat.sa/wa/v2/media/
//   - Content-Type: multipart/form-data (boundary set by runtime)
//   - Auth:         Authorization: Bearer <TAQNYAT_WHATSAPP_TOKEN>
//   - Fields (multipart):
//       messaging_product = "whatsapp"          // Meta requires
//       type              = "<mime/type>"       // e.g. application/pdf
//       file              = <binary>            // filename + type
//
// We DO NOT set Content-Type manually — FormData in Node 18+ /
// undici sets `multipart/form-data; boundary=...` with a
// randomised boundary when the body is passed to fetch. Setting
// it manually would omit the boundary and the request would
// fail at the multipart parser.
//
// Response shape: Taqnyat proxies Meta's `{ id: "<media_id>" }`
// envelope. We accept both the flat and nested shapes for
// forward-compatibility (`{ id }`, `{ media: { id } }`). Empty
// or missing id on a 2xx is treated as a failure — we refuse
// to fabricate a success reference.
//
// Returned ref is a `WhatsAppDocumentRef { kind: "id" }` carrying
// the filename the caller supplied. Mirrors the upload→reference
// flow: the uploader doesn't need the filename to perform the
// upload (Meta records it from the multipart part) but the send-
// time envelope DOES need it (the ref goes into either the
// standalone-document `document.filename` or the template
// header-parameter `document.filename`). Caching it on the ref
// means the caller doesn't have to thread it through a second
// time.
//
// NOTE on media expiry: Meta retains uploaded media ids for 30
// days. For the invitation-PDF flow (which sends the document
// shortly after upload) this is comfortable headroom; if a
// future flow needs longer retention, the uploader caller will
// need to re-upload on a schedule. We don't cache / persist ids
// here — that's a decision for the P17-C wiring.

export type TaqnyatMediaUploadResult =
  | { ok: true; ref: WhatsAppDocumentRef }
  | { ok: false; error: string; retryable?: boolean };

export type TaqnyatMediaUploadOptions = {
  token: string;
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  // DI seam for unit tests — real callers use global fetch.
  fetchImpl?: typeof fetch;
};

export async function taqnyatUploadMedia(
  opts: TaqnyatMediaUploadOptions,
): Promise<TaqnyatMediaUploadResult> {
  if (!opts.token) {
    return { ok: false, error: "whatsapp-media: missing token" };
  }
  if (!opts.filename || opts.filename.length === 0) {
    // Defensive: a missing filename would make the multipart part
    // anonymous and the returned ref unusable at send time (both
    // the standalone-document and template-header-document paths
    // carry filename forward to the recipient-visible envelope).
    return { ok: false, error: "whatsapp-media: missing filename" };
  }
  if (!opts.mimeType || opts.mimeType.length === 0) {
    return { ok: false, error: "whatsapp-media: missing mimeType" };
  }
  if (!opts.bytes || opts.bytes.byteLength === 0) {
    return { ok: false, error: "whatsapp-media: empty bytes" };
  }
  const form = buildMediaUploadFormData(
    opts.bytes,
    opts.filename,
    opts.mimeType,
  );
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  const res = await fetchFn("https://api.taqnyat.sa/wa/v2/media/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      // NO Content-Type — FormData serializer sets it with boundary.
    },
    body: form,
  });
  const j = (await res.json().catch(() => ({}))) as {
    id?: string | number;
    media?: { id?: string | number };
    messageId?: string | number;
    requestId?: string | number;
    message?: string;
    error?: { message?: string } | string;
  };
  const mediaId = extractMediaId(j);
  if (res.ok && mediaId) {
    return {
      ok: true,
      ref: { kind: "id", mediaId, filename: opts.filename },
    };
  }
  const errText = extractErrorText(j);
  return {
    ok: false,
    error: `whatsapp-media ${res.status}: ${errText}`,
    retryable: res.status >= 500,
  };
}

// Exported for direct unit coverage — the multipart field set is
// the part most likely to drift against Meta/Taqnyat. Tests pin
// the exact field names, their values, and the file part's
// `name` + `type` so a silent regression (e.g. renaming
// `messaging_product` to `product`) trips before a live upload.
export function buildMediaUploadFormData(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
): FormData {
  const form = new FormData();
  // Meta requires `messaging_product="whatsapp"` on every
  // outbound WhatsApp Cloud API request, including media uploads.
  form.append("messaging_product", "whatsapp");
  // `type` is the MIME type of the file content. Meta uses this
  // to classify the media (document / image / audio / video) —
  // the `type` field on the SEND-time envelope maps to a Meta
  // media type (e.g. "document") separately, but this upload-time
  // field is the literal MIME type of the bytes.
  form.append("type", mimeType);
  // File part: Blob-wrap the bytes so FormData treats it as a
  // file (with filename + content-type headers in the multipart
  // part), not as a plain text field.
  //
  // TypeScript 5 in this repo infers `Blob` as the DOM Blob,
  // which accepts `Uint8Array` in its BlobPart list. The cast
  // below flattens any conditional narrowing ambiguity without
  // changing behaviour.
  const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType });
  form.append("file", blob, filename);
  return form;
}

function extractMediaId(j: {
  id?: string | number;
  media?: { id?: string | number };
  messageId?: string | number;
  requestId?: string | number;
}): string | null {
  // Primary shape: Meta's `{ id: "<media_id>" }` — Taqnyat's proxy
  // returns this flat. Nested `{ media: { id } }` is the fallback
  // for a hypothetical future wrapper shape.
  const candidates = [j.id, j.media?.id, j.messageId, j.requestId];
  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    const s = String(c);
    if (s.length > 0) return s;
  }
  return null;
}
