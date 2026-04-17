import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "node:crypto";

// Single password + HMAC cookie. Replace with SAML / Nafath later without touching callers.

const COOKIE = "einai_admin";
const MAX_AGE = 60 * 60 * 8; // 8h

function sign(payload: string): string {
  const secret = process.env.SESSION_SECRET ?? "dev-secret";
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function authenticate(password: string): boolean {
  const expected = process.env.ADMIN_PASSWORD ?? "";
  if (!expected) return false;
  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function issueSession() {
  const payload = `${Date.now()}`;
  const token = `${payload}.${sign(payload)}`;
  cookies().set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export function clearSession() {
  cookies().set(COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

export function isAuthed(): boolean {
  const c = cookies().get(COOKIE);
  if (!c) return false;
  const [ts, sig] = c.value.split(".");
  if (!ts || !sig) return false;
  const age = Date.now() - Number(ts);
  if (!Number.isFinite(age) || age < 0 || age > MAX_AGE * 1000) return false;
  const expected = sign(ts);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
