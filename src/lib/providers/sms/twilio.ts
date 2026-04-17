import type { SendResult, SmsMessage, SmsProvider } from "../types";

export function twilio(accountSid: string, authToken: string, from: string): SmsProvider {
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  return {
    name: "twilio",
    async send(msg: SmsMessage): Promise<SendResult> {
      const body = new URLSearchParams({ To: msg.to, From: from, Body: msg.body });
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        },
      );
      const j = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
      if (res.ok && j.sid) return { ok: true, providerId: j.sid };
      return { ok: false, error: `twilio ${res.status}: ${j.message ?? "unknown"}`, retryable: res.status >= 500 };
    },
  };
}
