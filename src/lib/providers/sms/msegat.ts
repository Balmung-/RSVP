import type { SendResult, SmsMessage, SmsProvider } from "../types";

// Msegat — another SA provider. JSON API.
export function msegat(apiKey: string, userName: string, senderId: string): SmsProvider {
  return {
    name: "msegat",
    async send(msg: SmsMessage): Promise<SendResult> {
      const res = await fetch("https://www.msegat.com/gw/sendsms.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userName,
          apiKey,
          numbers: msg.to.replace(/^\+/, ""),
          userSender: senderId,
          msg: msg.body,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { code?: number | string; id?: string; message?: string };
      if (res.ok && String(j.code) === "1") {
        return { ok: true, providerId: String(j.id ?? "msegat_ok") };
      }
      return { ok: false, error: `msegat ${res.status}: ${j.message ?? "unknown"}`, retryable: res.status >= 500 };
    },
  };
}
