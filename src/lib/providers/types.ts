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
