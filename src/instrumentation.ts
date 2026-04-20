import { guardRuntimeOnBoot } from "@/lib/boot/runtime-guard";

// Next.js 14.2 instrumentation hook. Called once per server process
// on startup. The runtime guard validates AI backend env and throws
// in NODE_ENV=production when the selected backend is missing keys —
// so a broken deploy fails to start instead of booting into a state
// where every /api/chat request 503s. Non-production boot continues
// with a warning so dev can iterate on non-chat surfaces.
export function register() {
  guardRuntimeOnBoot();
}
