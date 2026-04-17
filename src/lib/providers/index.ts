import { stubEmail } from "./email/stub";
import { sendgrid } from "./email/sendgrid";
import { resend } from "./email/resend";
import { stubSms } from "./sms/stub";
import { twilio } from "./sms/twilio";
import { unifonic } from "./sms/unifonic";
import { msegat } from "./sms/msegat";
import type { EmailProvider, SmsProvider } from "./types";

// Single resolution point. Everything else asks the factory — never a driver.
let _email: EmailProvider | null = null;
let _sms: SmsProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (_email) return _email;
  const kind = (process.env.EMAIL_PROVIDER ?? "stub").toLowerCase();
  const from = process.env.EMAIL_FROM ?? "no-reply@localhost";
  const fromName = process.env.EMAIL_FROM_NAME;
  switch (kind) {
    case "sendgrid":
      _email = sendgrid(must("SENDGRID_API_KEY"), from, fromName);
      break;
    case "resend":
      _email = resend(must("RESEND_API_KEY"), from, fromName);
      break;
    case "stub":
    default:
      _email = stubEmail;
  }
  return _email;
}

export function getSmsProvider(): SmsProvider {
  if (_sms) return _sms;
  const kind = (process.env.SMS_PROVIDER ?? "stub").toLowerCase();
  switch (kind) {
    case "twilio":
      _sms = twilio(must("TWILIO_ACCOUNT_SID"), must("TWILIO_AUTH_TOKEN"), must("TWILIO_FROM"));
      break;
    case "unifonic":
      _sms = unifonic(must("UNIFONIC_APP_SID"), must("UNIFONIC_SENDER_NAME"));
      break;
    case "msegat":
      _sms = msegat(must("MSEGAT_API_KEY"), must("MSEGAT_USERNAME"), process.env.SMS_SENDER_ID ?? "GOV");
      break;
    case "stub":
    default:
      _sms = stubSms;
  }
  return _sms;
}

function must(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env: ${key}`);
  return v;
}

export type { EmailProvider, SmsProvider } from "./types";
