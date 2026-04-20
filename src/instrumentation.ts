import { registerBootGuard } from "@/lib/boot/runtime-guard";

// Next.js 14.2 instrumentation hook. Called once per server process
// on startup.
//
// Requires `experimental.instrumentationHook: true` in next.config.js —
// without the flag Next 14 silently skips this module and the guard
// never runs. (Stable / default-on in Next 15.)
//
// `registerBootGuard` runs the AI-runtime config check and, in
// production, hard-exits on misconfig. Throwing alone isn't enough:
// Next 14 catches register()'s throw, logs "Failed to prepare
// server", and keeps the process alive serving 500s for every
// request — worse than the silent-503 it's meant to prevent. Hard
// exit lets the platform (Railway/Vercel/Docker) see a crash loop
// and surface the failed deploy.
//
// Non-production boot warns and continues so local dev can iterate
// on non-chat surfaces without an AI key.
export function register() {
  registerBootGuard();
}
