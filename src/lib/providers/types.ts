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
