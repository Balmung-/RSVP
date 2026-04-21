// Thin contract for outbound messaging. One shape, two channels.
// Implementations live in ./email/* and ./sms/* — the rest of the app only
// ever imports the interfaces and the getters from ./index.

export type SendResult =
  | { ok: true; providerId: string }
  | { ok: false; error: string; retryable?: boolean };

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  // Per-campaign mailbox routing hint (B3). Only the Gmail adapter
  // consults it — other providers ignore it. Semantics:
  //   - string   -> route to the OAuthAccount for (provider=google, teamId=<id>),
  //                 falling back to the office-wide (teamId=null) slot if
  //                 the team row isn't connected;
  //   - null     -> route to the office-wide slot directly;
  //   - omitted  -> same as null (office-wide). Deliberate: non-campaign
  //                 senders (digest, admin notify) should default to the
  //                 office-wide mailbox without having to know about teams.
  teamId?: string | null;
}

export interface SmsMessage {
  to: string; // E.164
  body: string;
}

export interface EmailProvider {
  readonly name: string;
  send(msg: EmailMessage): Promise<SendResult>;
}

export interface SmsProvider {
  readonly name: string;
  send(msg: SmsMessage): Promise<SendResult>;
}

// ---- WhatsApp channel (P11 / P17) ----
//
// WhatsApp is a separate channel, not a flavor of SMS. The Meta
// platform (and every BSP that fronts it, including Taqnyat)
// enforces a session window + template discipline that the simple
// `SmsMessage {to, body}` shape can't express without lying:
//
//   - A business-initiated conversation MUST start from an approved
//     template message. Sending a free-form text outside the
//     24-hour session window returns a policy error on Meta's side.
//   - Inside the 24-hour session window (after the customer has
//     messaged us), a free-form text ("session text") is valid.
//
// This type split is deliberate. Callers that want to start a new
// conversation build a `WhatsAppTemplateMessage`; callers inside
// the session window build a `WhatsAppTextMessage` (or a standalone
// `WhatsAppDocumentMessage` for in-session document delivery).
// Providers enforce the channel-specific rules when constructing
// the upstream request; the caller doesn't need to know which BSP
// is wired.
//
// Media messages: P17-A adds DOCUMENT support (the invitation-PDF
// use case). Image/video/audio variants can be added later as
// additive type extensions following the same pattern. Document
// delivery has two paths:
//   (a) Business-initiated — a pre-approved template whose
//       HEADER component is of DOCUMENT type, carrying the PDF
//       as a header parameter alongside BODY text variables.
//       Modelled here as `WhatsAppTemplateMessage.headerDocument`.
//   (b) In-session — a standalone `type: "document"` message sent
//       within the 24h window. Modelled as `WhatsAppDocumentMessage`.
// Both paths refer to the media via `WhatsAppDocumentRef`: either
// a previously-uploaded `mediaId` (from Meta's /media upload flow)
// or a public HTTPS `link` Meta fetches directly. The upload flow
// itself is a separate seam (P17-B).

// In-session free-form text. Valid only when the recipient has
// messaged us within the last 24h; providers don't enforce this
// (they can't know session state from the request alone) — if the
// BSP rejects with a policy error we surface it as a non-retryable
// failure.
export interface WhatsAppTextMessage {
  kind: "text";
  to: string; // E.164; adapter normalizes to provider format
  text: string;
}

// Reference to a WhatsApp-hosted media object. Discriminated on
// `kind` so the adapter emits the right Meta envelope shape:
//   - `id`   → `{ id: "<media_id>", filename?: "..." }` — the
//              media was uploaded via the BSP's /media endpoint
//              and is referenced by its returned id. Preferred
//              path when the file is operator-supplied (our case
//              for PDF invitations) because Meta doesn't have to
//              fetch it.
//   - `link` → `{ link: "<url>", filename?: "..." }` — Meta
//              fetches the URL directly at send time. The URL
//              must be publicly reachable, HTTPS, and return the
//              declared content-type. Useful when the file is
//              already hosted elsewhere (e.g. pre-generated PDFs
//              in object storage with a signed URL).
//
// `filename` is OPTIONAL but recommended. When absent, Meta
// derives the filename from the URL path / media metadata, which
// can surface as a noisy UUID in the recipient's chat. Always
// supplying `filename: "invitation.pdf"` (or similar) gives the
// PDF a human-readable name in the recipient's WhatsApp.
export type WhatsAppDocumentRef = { filename?: string } & (
  | { kind: "id"; mediaId: string }
  | { kind: "link"; link: string }
);

// In-session standalone document message. Like `WhatsAppTextMessage`,
// valid only inside the 24h session window — adapters don't enforce
// this, but the BSP/Meta rejects with a non-retryable policy error
// when sent outside the window. For business-initiated document
// delivery (the common case — sending an invitation PDF to a
// recipient who hasn't messaged us first), use a
// `WhatsAppTemplateMessage` with `headerDocument` set.
//
// `caption` is an optional overlay text that Meta renders under
// the document preview. It is NOT supported on the template-header-
// document path (Meta's envelope doesn't accept a caption field
// inside a header-component document parameter), which is why
// caption lives on this type directly rather than on
// `WhatsAppDocumentRef`.
export interface WhatsAppDocumentMessage {
  kind: "document";
  to: string; // E.164
  document: WhatsAppDocumentRef;
  caption?: string;
}

// Business-initiated template message. `templateName` +
// `languageCode` identify the pre-approved template; `variables`
// are the ordered positional parameters for the BODY component.
// Button parameters remain out of scope of the initial seam — a
// later push can extend this shape without breaking existing
// callers.
//
// `headerDocument` (P17-A): when set, the template has a DOCUMENT
// header component and the referenced PDF/image/etc. is sent as
// the header parameter. The template ITSELF must be pre-approved
// by Meta with a DOCUMENT header — the adapter only shapes the
// request; it can't enforce template-side correctness. A mismatch
// (e.g. `headerDocument` set on a template whose header was
// approved as IMAGE or TEXT) surfaces as a Meta policy error at
// send time.
export interface WhatsAppTemplateMessage {
  kind: "template";
  to: string; // E.164
  templateName: string;
  languageCode: string; // e.g. "ar" or "en_US"
  variables?: string[];
  headerDocument?: WhatsAppDocumentRef;
}

export type WhatsAppMessage =
  | WhatsAppTextMessage
  | WhatsAppTemplateMessage
  | WhatsAppDocumentMessage;

export interface WhatsAppProvider {
  readonly name: string;
  send(msg: WhatsAppMessage): Promise<SendResult>;
}
