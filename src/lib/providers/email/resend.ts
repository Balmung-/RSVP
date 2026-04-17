import type { EmailMessage, EmailProvider, SendResult } from "../types";

export function resend(apiKey: string, from: string, fromName?: string): EmailProvider {
  const fromHeader = fromName ? `${fromName} <${from}>` : from;
  return {
    name: "resend",
    async send(msg: EmailMessage): Promise<SendResult> {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: fromHeader,
          to: [msg.to],
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          reply_to: msg.replyTo,
          headers: msg.headers,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (res.ok && j.id) return { ok: true, providerId: j.id };
      return { ok: false, error: `resend ${res.status}: ${j.message ?? "unknown"}`, retryable: res.status >= 500 };
    },
  };
}
