import { nanoid } from "nanoid";
import type { SendResult, SmsMessage, SmsProvider } from "../types";

export const stubSms: SmsProvider = {
  name: "stub-sms",
  async send(msg: SmsMessage): Promise<SendResult> {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.log(`[sms:stub] → ${msg.to}  ${msg.body.slice(0, 80)}`);
    }
    return { ok: true, providerId: `stub_${nanoid(10)}` };
  },
};
