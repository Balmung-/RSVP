import { nanoid } from "nanoid";
import type { EmailMessage, EmailProvider, SendResult } from "../types";

// No-op provider. Prints, returns a synthetic id. Swap with a real driver
// by flipping EMAIL_PROVIDER in .env.
export const stubEmail: EmailProvider = {
  name: "stub-email",
  async send(msg: EmailMessage): Promise<SendResult> {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.log(`[email:stub] → ${msg.to}  "${msg.subject}"`);
    }
    return { ok: true, providerId: `stub_${nanoid(10)}` };
  },
};
