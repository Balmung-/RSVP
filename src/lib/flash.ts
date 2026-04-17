import { cookies } from "next/headers";

// Cookie-backed flash messages. Server actions write a flash right before
// `redirect()`; the next render reads and clears it, and the Shell renders
// a toast. Survives a single redirect then disappears.

export type FlashKind = "success" | "info" | "warn" | "error";
export type Flash = { kind: FlashKind; text: string; detail?: string };

const COOKIE = "einai_flash";

export function setFlash(flash: Flash) {
  cookies().set(COOKIE, JSON.stringify(flash), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 30,
  });
}

export function consumeFlash(): Flash | null {
  const raw = cookies().get(COOKIE)?.value;
  if (!raw) return null;
  try {
    const f = JSON.parse(raw) as Flash;
    // Clear it immediately so a reload doesn't re-show the toast.
    cookies().set(COOKIE, "", { path: "/", maxAge: 0 });
    if (!f?.kind || !f?.text) return null;
    return f;
  } catch {
    cookies().set(COOKIE, "", { path: "/", maxAge: 0 });
    return null;
  }
}
