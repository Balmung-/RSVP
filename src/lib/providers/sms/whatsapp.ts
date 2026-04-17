import type { SendResult, SmsMessage, SmsProvider } from "../types";

// WhatsApp via Twilio. Same account + auth token as the SMS driver, but
// both From and To are prefixed with "whatsapp:". Twilio requires the
// sender number to be enrolled in the WhatsApp Business API sandbox or
// a production WhatsApp Sender; set WHATSAPP_FROM to the full E.164
// number of your WhatsApp sender.

export function whatsappTwilio(
  accountSid: string,
  authToken: string,
  from: string,
): SmsProvider {
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const fromAddr = from.startsWith("whatsapp:") ? from : `whatsapp:${from}`;
  return {
    name: "whatsapp-twilio",
    async send(msg: SmsMessage): Promise<SendResult> {
      const to = msg.to.startsWith("whatsapp:") ? msg.to : `whatsapp:${msg.to}`;
      const body = new URLSearchParams({ To: to, From: fromAddr, Body: msg.body });
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
      return { ok: false, error: `whatsapp ${res.status}: ${j.message ?? "unknown"}`, retryable: res.status >= 500 };
    },
  };
}
