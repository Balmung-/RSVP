import type { SendResult, SmsMessage, SmsProvider } from "../types";

// Unifonic — a common SA provider. Auth via AppSid.
export function unifonic(appSid: string, senderName: string): SmsProvider {
  return {
    name: "unifonic",
    async send(msg: SmsMessage): Promise<SendResult> {
      const body = new URLSearchParams({
        AppSid: appSid,
        SenderID: senderName,
        Recipient: msg.to.replace(/^\+/, ""),
        Body: msg.body,
      });
      const res = await fetch("https://el.cloud.unifonic.com/rest/SMS/messages", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const j = (await res.json().catch(() => ({}))) as {
        success?: string;
        data?: { MessageID?: string };
        message?: string;
      };
      if (res.ok && j.success === "true" && j.data?.MessageID) {
        return { ok: true, providerId: String(j.data.MessageID) };
      }
      return { ok: false, error: `unifonic ${res.status}: ${j.message ?? "unknown"}`, retryable: res.status >= 500 };
    },
  };
}
