import type { SendResult, SmsMessage, SmsProvider } from "../types";

// Taqnyat SMS — Saudi provider, JSON API with Bearer auth.
//
// Docs: https://dev.taqnyat.sa/ar/doc/sms/
//
// Contract highlights the adapter has to honor:
//   - Send endpoint: POST https://api.taqnyat.sa/v1/messages
//   - Auth:          Authorization: Bearer <TAQNYAT_SMS_TOKEN>
//   - Recipients:    international format WITHOUT leading `+` or `00`
//                    (e.g. E.164 `+966500000000` -> `966500000000`)
//   - Body fields:   `recipients: string[]`, `body: string`,
//                    `sender: string`
//   - Success:       HTTP 2xx with `statusCode: 201` and a
//                    `messageId` (or `requestId`) we forward as the
//                    SendResult providerId.
//   - Failure:       non-2xx, OR 2xx with a non-201 statusCode. The
//                    response body usually carries `message` /
//                    `statusDescription` we surface in the error
//                    string; retryable classification keys off HTTP
//                    status only (>=500 is retryable).
//
// The adapter is deliberately defensive about response field names
// (messageId | requestId | id). Taqnyat's JSON has been consistent
// with `messageId` in the public docs, but a silent schema tweak on
// their side shouldn't take the send path down — we accept the
// first non-empty identifier.

export function taqnyat(token: string, sender: string): SmsProvider {
  return {
    name: "taqnyat",
    async send(msg: SmsMessage): Promise<SendResult> {
      const recipient = normalizeRecipient(msg.to);
      const res = await fetch("https://api.taqnyat.sa/v1/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          recipients: [recipient],
          body: msg.body,
          sender,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        statusCode?: number | string;
        messageId?: string | number;
        requestId?: string | number;
        id?: string | number;
        message?: string;
        statusDescription?: string;
      };
      const id = firstNonEmptyId(j);
      // Taqnyat returns 201 on success inside a 2xx HTTP response.
      // We accept either: an HTTP 2xx with a 201 statusCode body OR
      // any HTTP 2xx that carries an identifier — the latter guards
      // against a minor schema shift where statusCode was dropped.
      if (res.ok && (String(j.statusCode) === "201" || id)) {
        return { ok: true, providerId: id ?? "taqnyat_ok" };
      }
      const msgText = j.message ?? j.statusDescription ?? "unknown";
      return {
        ok: false,
        error: `taqnyat ${res.status}: ${msgText}`,
        retryable: res.status >= 500,
      };
    },
  };
}

// Strip the leading `+` or `00` if present, keeping digits only.
// Taqnyat rejects both prefixes per their recipient format rules.
// We don't attempt country-code inference — callers pass E.164, so
// a `+966...` becomes `966...` and a bare `966...` is passed through.
export function normalizeRecipient(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("+")) return trimmed.slice(1);
  if (trimmed.startsWith("00")) return trimmed.slice(2);
  return trimmed;
}

function firstNonEmptyId(j: {
  messageId?: string | number;
  requestId?: string | number;
  id?: string | number;
}): string | null {
  const candidates = [j.messageId, j.requestId, j.id];
  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    const s = String(c);
    if (s.length > 0) return s;
  }
  return null;
}
