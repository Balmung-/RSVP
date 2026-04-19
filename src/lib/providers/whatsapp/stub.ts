import type { SendResult, WhatsAppProvider } from "../types";

// Dev / test WhatsApp provider. Returns a synthetic success with a
// deterministic id so local flows don't need a real BSP token.
// Intentionally does NOT validate template/session discipline — the
// stub's job is to let the rest of the stack run; real policy
// enforcement lives on Meta's side.
export const stubWhatsApp: WhatsAppProvider = {
  name: "stub-whatsapp",
  async send(): Promise<SendResult> {
    return { ok: true, providerId: `stub_wa_${Date.now()}` };
  },
};
