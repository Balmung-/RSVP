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

// ---- WhatsApp channel (P11) ----
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
// the session window build a `WhatsAppTextMessage`. Providers
// enforce the channel-specific rules when constructing the upstream
// request; the caller doesn't need to know which BSP is wired.
//
// Media messages are deferred — Meta's media flow (upload-then-
// reference vs link) adds another boundary. Adding a
// `WhatsAppMediaMessage` variant later is a type extension, not a
// breaking change: providers that can't serve it return a
// `SendResult` with a typed error string like
// `whatsapp_media_unsupported`.

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

// Business-initiated template message. `templateName` +
// `languageCode` identify the pre-approved template; `variables`
// are the ordered positional parameters for the BODY component.
// Header / button parameters are out of scope in the initial P11
// seam — a later push can extend this shape without breaking
// existing callers.
export interface WhatsAppTemplateMessage {
  kind: "template";
  to: string; // E.164
  templateName: string;
  languageCode: string; // e.g. "ar" or "en_US"
  variables?: string[];
}

export type WhatsAppMessage = WhatsAppTextMessage | WhatsAppTemplateMessage;

export interface WhatsAppProvider {
  readonly name: string;
  send(msg: WhatsAppMessage): Promise<SendResult>;
}
