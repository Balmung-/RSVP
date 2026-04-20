import {
  resolveRuntime,
  type AIRuntime,
  type RuntimeEnv,
  type RuntimeResolutionError,
} from "@/lib/ai/runtime";

// P14-N — route-level gate around `resolveRuntime`.
//
// The chat route used to inline the translation from the resolver's
// `{ ok: false, reason }` discriminated failure into a 503 response:
//
//    const runtimeResolution = resolveRuntime();
//    if (!runtimeResolution.ok) {
//      return NextResponse.json(
//        { ok: false, error: runtimeResolution.reason },
//        { status: 503 },
//      );
//    }
//    const runtime = runtimeResolution.runtime;
//
// That wiring — "map the three resolver failure reasons to 503 + an
// `error` field carrying the reason verbatim, otherwise pass the
// runtime through" — is the contract the route exposes to the client.
// The resolver itself is already covered at the helper seam
// (`tests/unit/runtime-resolver.test.ts`), but the *route* behavior
// (which status code, which body shape, which env flips select which
// provider) was previously inlined where no unit test could reach it
// without spinning up Next.js.
//
// Pulling the translation out into this pure helper means:
//   1. The route becomes a thin one-liner: call `gateRuntimeForChatRoute`,
//      branch on `pass`, return either the 503 response or the runtime.
//   2. A unit test can assert the full HTTP contract — status code,
//      body shape, AND the selected runtime's `name` — from the
//      synthetic `RuntimeEnv` inputs that mirror the three documented
//      branches (anthropic / openrouter / unknown) + their failure
//      modes. See `tests/unit/chat-route-runtime.test.ts`.
//   3. A regression that widens or narrows the HTTP contract (e.g.
//      drops the 503 in favor of a 500, or strips the `error` field)
//      has exactly one seam to update, not a route file buried deep
//      inside a 600-line streaming handler.
//
// The helper accepts an optional env so tests can simulate env states
// without mutating `process.env`. Production caller passes nothing and
// picks up the live env via `resolveRuntime`'s own default.

export type RuntimeGateResult =
  | { pass: true; runtime: AIRuntime }
  | {
      pass: false;
      status: 503;
      body: { ok: false; error: RuntimeResolutionError };
    };

export function gateRuntimeForChatRoute(env?: RuntimeEnv): RuntimeGateResult {
  const res = resolveRuntime(env);
  if (!res.ok) {
    return {
      pass: false,
      status: 503,
      body: { ok: false, error: res.reason },
    };
  }
  return { pass: true, runtime: res.runtime };
}
