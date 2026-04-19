import { stubEmail } from "./email/stub";
import { sendgrid } from "./email/sendgrid";
import { resend } from "./email/resend";
import { gmail } from "./email/gmail";
import { stubSms } from "./sms/stub";
import { twilio } from "./sms/twilio";
import { unifonic } from "./sms/unifonic";
import { msegat } from "./sms/msegat";
import { taqnyat } from "./sms/taqnyat";
import { whatsappTwilio } from "./sms/whatsapp";
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
    case "gmail":
      // Gmail doesn't use EMAIL_FROM — the From address is the
      // connected mailbox from the OAuthAccount row. fromName is
      // still passed through for display-name consistency across
      // internal audits. The client_id/secret here are the OAuth
      // client credentials (same ones wired to /api/oauth/google/*),
      // needed to refresh expired access tokens at send time.
      _email = gmail({
        clientId: must("GOOGLE_OAUTH_CLIENT_ID"),
        clientSecret: must("GOOGLE_OAUTH_CLIENT_SECRET"),
        fromName,
      });
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
    case "whatsapp":
    case "whatsapp-twilio":
      _sms = whatsappTwilio(
        must("TWILIO_ACCOUNT_SID"),
        must("TWILIO_AUTH_TOKEN"),
        must("WHATSAPP_FROM"),
      );
      break;
    case "unifonic":
      _sms = unifonic(must("UNIFONIC_APP_SID"), must("UNIFONIC_SENDER_NAME"));
      break;
    case "msegat":
      _sms = msegat(must("MSEGAT_API_KEY"), must("MSEGAT_USERNAME"), process.env.SMS_SENDER_ID ?? "GOV");
      break;
    case "taqnyat":
      // Saudi provider; Bearer-token auth, JSON API. Sender ID is
      // an account-provisioned short name (e.g. "GOV", "EINAI") —
      // Taqnyat enforces ownership at send time, so we don't
      // validate here.
      _sms = taqnyat(must("TAQNYAT_SMS_TOKEN"), must("TAQNYAT_SMS_SENDER"));
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
