import { authenticator } from "otplib";
import QRCode from "qrcode";

// TOTP helpers. Wrap otplib so callers don't have to know the defaults.
// Uses SHA-1, 30s window, 6-digit codes (the Google Authenticator shape).

authenticator.options = { window: 1 }; // accept code from one step before or after

export function generateSecret(): string {
  return authenticator.generateSecret();
}

export function otpauthUri(user: { email: string }, secret: string, issuer: string): string {
  return authenticator.keyuri(user.email, issuer, secret);
}

export async function qrForSecret(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 256,
    color: { dark: "#141414", light: "#ffffff" },
  });
}

export function verifyTotp(token: string, secret: string): boolean {
  try {
    return authenticator.verify({ token: token.replace(/\s+/g, ""), secret });
  } catch {
    return false;
  }
}
