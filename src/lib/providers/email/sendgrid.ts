import type { EmailMessage, EmailProvider, SendResult } from "../types";

// Thin SendGrid adapter. Turn on by setting EMAIL_PROVIDER=sendgrid and
// SENDGRID_API_KEY. No SDK — just fetch, for zero extra surface.
export function sendgrid(apiKey: string, from: string, fromName?: string): EmailProvider {
  return {
    name: "sendgrid",
    async send(msg: EmailMessage): Promise<SendResult> {
      const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: msg.to }] }],
          from: { email: from, name: fromName },
          reply_to: msg.replyTo ? { email: msg.replyTo } : undefined,
          subject: msg.subject,
          content: [
            ...(msg.text ? [{ type: "text/plain", value: msg.text }] : []),
            { type: "text/html", value: msg.html },
          ],
          headers: msg.headers,
        }),
      });
      if (res.status === 202) {
        return { ok: true, providerId: res.headers.get("x-message-id") ?? "sg_unknown" };
      }
      const body = await res.text().catch(() => "");
      return { ok: false, error: `sendgrid ${res.status}: ${body.slice(0, 300)}`, retryable: res.status >= 500 };
    },
  };
}
