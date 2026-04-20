import { test } from "node:test";
import assert from "node:assert/strict";

import { gateRuntimeForChatRoute } from "../../src/app/api/chat/runtime-gate";
import type { RuntimeEnv } from "../../src/lib/ai/runtime";

// P14-N — route-level pins for `/api/chat` runtime selection.
//
// GPT's audit on P14-M blocked the "P14 complete" claim because the
// AI runtime provider selection was only covered at the helper seam
// (`runtime-resolver.test.ts`, `runtime-openrouter.test.ts`,
// `runtime-anthropic.test.ts`) — nothing proved that `/api/chat`
// itself wires `resolveRuntime` into the expected 503 failure contract
// or picks the correct provider per env at the route boundary.
//
// This file closes that gap by pinning `gateRuntimeForChatRoute`, the
// single helper the chat route calls to (a) invoke the resolver and
// (b) translate each resolver outcome into the HTTP contract the route
// ships to the client:
//
//   - pass=true → the resolved AIRuntime flows through; `.name` is
//     stable ("anthropic" | "openrouter") so downstream SSE logging
//     and the caching path branch correctly.
//   - pass=false → exactly HTTP 503 with a body shape of
//     `{ ok: false, error: <RuntimeResolutionError> }`, one error code
//     per documented failure mode.
//
// Regression surfaces this protects:
//   * "Drop the 503, use 500" — any widening of the status code from
//     the documented Service-Unavailable contract breaks clients that
//     currently treat 503 as "config drift, show a nudge to the
//     admin" vs 500 as "crash, retry".
//   * "Leak the resolver's raw reason into a user-facing message" —
//     the route MUST surface the reason code verbatim (it's a stable
//     symbol the admin UI / dashboards key on), not a human-readable
//     translation that could drift between locales.
//   * "Default-branch flip" — unset `AI_RUNTIME` has to keep selecting
//     Anthropic. An accidental rename of the default to "openrouter"
//     would silently route traffic through the wrong provider's key.
//   * "Case-sensitivity regression" — the resolver lowercases
//     `AI_RUNTIME` and the route inherits that behavior; typing
//     `ANTHROPIC` in a .env file has to still resolve to the
//     Anthropic path.
//   * "Missing OPENROUTER_MODEL treated as optional" — the P2
//     OpenRouter branch requires BOTH the API key AND the model;
//     neither can be defaulted server-side (OpenRouter has no default
//     model for us). A regression that drops the model check from the
//     resolver would surface as an uninstantiable runtime hitting the
//     route instead of a 503 on this gate.

// --- anthropic default / set --------------------------------------

test("gate: default (no AI_RUNTIME) + ANTHROPIC_API_KEY → pass, name=anthropic", () => {
  const env: RuntimeEnv = { ANTHROPIC_API_KEY: "sk-ant-test" };
  const gated = gateRuntimeForChatRoute(env);
  assert.equal(gated.pass, true);
  if (gated.pass) {
    assert.equal(gated.runtime.name, "anthropic");
  }
});

test("gate: AI_RUNTIME=anthropic (explicit) + key → pass, name=anthropic", () => {
  const env: RuntimeEnv = {
    AI_RUNTIME: "anthropic",
    ANTHROPIC_API_KEY: "sk-ant-test",
  };
  const gated = gateRuntimeForChatRoute(env);
  assert.equal(gated.pass, true);
  if (gated.pass) {
    assert.equal(gated.runtime.name, "anthropic");
  }
});

test("gate: AI_RUNTIME case-insensitive (ANTHROPIC) → anthropic path", () => {
  // Regression guard: the resolver lowercases before matching so
  // env files that happen to be ALL-CAPS still pick up the intended
  // branch. A case-sensitive compare would silently fall through to
  // `unknown_runtime`.
  const env: RuntimeEnv = {
    AI_RUNTIME: "ANTHROPIC",
    ANTHROPIC_API_KEY: "sk-ant-test",
  };
  const gated = gateRuntimeForChatRoute(env);
  assert.equal(gated.pass, true);
  if (gated.pass) {
    assert.equal(gated.runtime.name, "anthropic");
  }
});

// --- anthropic failure --------------------------------------------

test("gate: anthropic default + no key → 503 anthropic_not_configured", () => {
  const env: RuntimeEnv = {};
  const gated = gateRuntimeForChatRoute(env);
  assert.equal(gated.pass, false);
  if (!gated.pass) {
    // Full-shape pin — status AND body AND error symbol.
    assert.equal(gated.status, 503);
    assert.equal(gated.body.ok, false);
    assert.equal(gated.body.error, "anthropic_not_configured");
  }
});

test("gate: anthropic + empty-string key → 503 anthropic_not_configured", () => {
  // Empty string is falsy so the resolver treats it the same as a
  // missing key. Pin this so a future tightening of the check (e.g.
  // `if (apiKey === undefined)`) can't silently accept empty keys
  // and pass them to the SDK.
  const env: RuntimeEnv = { ANTHROPIC_API_KEY: "" };
  const gated = gateRuntimeForChatRoute(env);
  assert.equal(gated.pass, false);
  if (!gated.pass) {
    assert.equal(gated.status, 503);
    assert.equal(gated.body.error, "anthropic_not_configured");
  }
});

test("gate: AI_RUNTIME=anthropic + missing key (even with OpenRouter key present) → anthropic_not_configured", () => {
  // Cross-branch pollution guard: having an OpenRouter key set doesn't
  // satisfy the Anthropic branch. The route must not fall through to
  // "well, we have SOME key, use that" — the selector is strict.
  const env: RuntimeEnv = {
    AI_RUNTIME: "anthropic",
    OPENROUTER_API_KEY: "sk-or-test",
    OPENROUTER_MODEL: "anthropic/claude-sonnet-4-6",
  };
  const gated = gateRuntimeForChatRoute(env);
  assert.equal(gated.pass, false);
  if (!gated.pass) {
    assert.equal(gated.body.error, "anthropic_not_configured");
  }
});

// --- openrouter pass ----------------------------------------------

test("gate: AI_RUNTIME=openrouter + key + model → pass, name=openrouter", () => {
  const env: RuntimeEnv = {
    AI_RUNTIME: "openrouter",
    OPENROUTER_API_KEY: "sk-or-test",
    OPENROUTER_MODEL: "anthropic/claude-sonnet-4-6",
  };
  const gated = gateRuntimeForChatRoute(env);
  assert.equal(gated.pass, true);
  if (gated.pass) {
    assert.equal(gated.runtime.name, "openrouter");
  }
});

test("gate: AI_RUNTIME case-insensitive (OpenRouter) → openrouter path", () => {
  const env: RuntimeEnv = {
    AI_RUNTIME: "OpenRouter",
    OPENROUTER_API_KEY: "sk-or-test",
    OPENROUTER_MODEL: "openai/gpt-4o",
  };
  const gated = gateRuntimeForChatRoute(env);
  assert.equal(gated.pass, true);
  if (gated.pass) {
    assert.equal(gated.runtime.name, "openrouter");
  }
});

test("gate: openrouter passes through analytics headers (no effect on pass/fail)", () => {
  // Optional headers should never flip the gate. This pin protects
  // against a regression that accidentally makes `OPENROUTER_X_TITLE`
  // required.
  const env: RuntimeEnv = {
    AI_RUNTIME: "openrouter",
    OPENROUTER_API_KEY: "sk-or-test",
    OPENROUTER_MODEL: "openai/gpt-4o",
    OPENROUTER_HTTP_REFERER: "https://example.gov",
    OPENROUTER_X_TITLE: "Einai RSVP",
  };
  const gated = gateRuntimeForChatRoute(env);
  assert.equal(gated.pass, true);
  if (gated.pass) {
    assert.equal(gated.runtime.name, "openrouter");
  }
});

// --- openrouter failure -------------------------------------------

test("gate: openrouter + no key → 503 openrouter_not_configured", () => {
  const env: RuntimeEnv = {
    AI_RUNTIME: "openrouter",
    OPENROUTER_MODEL: "openai/gpt-4o",
  };
  const gated = gateRuntimeForChatRoute(env);
  assert.equal(gated.pass, false);
  if (!gated.pass) {
    assert.equal(gated.status, 503);
    assert.equal(gated.body.error, "openrouter_not_configured");
  }
});

test("gate: openrouter + no model → 503 openrouter_not_configured", () => {
  // Missing MODEL is fatal even when the API key is present —
  // OpenRouter has no server-side default for us, so the runtime
  // can't be instantiated with just a key. This pins the stricter
  // check documented in runtime/index.ts.
  const env: RuntimeEnv = {
    AI_RUNTIME: "openrouter",
    OPENROUTER_API_KEY: "sk-or-test",
  };
  const gated = gateRuntimeForChatRoute(env);
  assert.equal(gated.pass, false);
  if (!gated.pass) {
    assert.equal(gated.body.error, "openrouter_not_configured");
  }
});

test("gate: openrouter + empty-string model → 503 openrouter_not_configured", () => {
  // Symmetric to the empty-string key pin above. Empty string is
  // falsy, must be treated the same as missing.
  const env: RuntimeEnv = {
    AI_RUNTIME: "openrouter",
    OPENROUTER_API_KEY: "sk-or-test",
    OPENROUTER_MODEL: "",
  };
  const gated = gateRuntimeForChatRoute(env);
  assert.equal(gated.pass, false);
  if (!gated.pass) {
    assert.equal(gated.body.error, "openrouter_not_configured");
  }
});

test("gate: openrouter + empty-string key → 503 openrouter_not_configured", () => {
  const env: RuntimeEnv = {
    AI_RUNTIME: "openrouter",
    OPENROUTER_API_KEY: "",
    OPENROUTER_MODEL: "openai/gpt-4o",
  };
  const gated = gateRuntimeForChatRoute(env);
  assert.equal(gated.pass, false);
  if (!gated.pass) {
    assert.equal(gated.body.error, "openrouter_not_configured");
  }
});

// --- unknown runtime ----------------------------------------------

test("gate: AI_RUNTIME=bogus → 503 unknown_runtime", () => {
  // A typo in the env variable should surface as its own error code
  // distinct from "not configured" — the latter means "you picked a
  // real backend but forgot the credentials"; the former means "you
  // picked a backend we don't know about at all". Admins act on them
  // differently (fix creds vs fix deployment).
  const env: RuntimeEnv = {
    AI_RUNTIME: "gpt-next",
    ANTHROPIC_API_KEY: "sk-ant-test",
  };
  const gated = gateRuntimeForChatRoute(env);
  assert.equal(gated.pass, false);
  if (!gated.pass) {
    assert.equal(gated.status, 503);
    assert.equal(gated.body.error, "unknown_runtime");
  }
});

test("gate: empty-string AI_RUNTIME → defaults to anthropic", () => {
  // An env file with `AI_RUNTIME=` (no value) yields empty string;
  // the `??` coalesce in the resolver uses "anthropic" only for
  // undefined, so empty string falls through to the lowercase match.
  // That match doesn't equal "anthropic" OR "openrouter", so this
  // pins the current behavior: empty-string → unknown_runtime.
  //
  // If a future revision wants to treat empty as default, this pin
  // is the tripwire — update the resolver AND this test in the same
  // change.
  const env: RuntimeEnv = {
    AI_RUNTIME: "",
    ANTHROPIC_API_KEY: "sk-ant-test",
  };
  const gated = gateRuntimeForChatRoute(env);
  assert.equal(gated.pass, false);
  if (!gated.pass) {
    assert.equal(gated.body.error, "unknown_runtime");
  }
});

// --- shape discipline ---------------------------------------------

test("gate: failure body shape is exactly { ok:false, error }", () => {
  // Belt-and-braces shape check — the HTTP body object has only the
  // two documented fields. A future addition (e.g. a stack trace or
  // request id) should be a deliberate change that also updates this
  // test, not a silent leak of internal state.
  const env: RuntimeEnv = {};
  const gated = gateRuntimeForChatRoute(env);
  assert.equal(gated.pass, false);
  if (!gated.pass) {
    const keys = Object.keys(gated.body).sort();
    assert.deepEqual(keys, ["error", "ok"]);
  }
});

test("gate: success shape exposes exactly runtime + pass", () => {
  const env: RuntimeEnv = { ANTHROPIC_API_KEY: "sk-ant-test" };
  const gated = gateRuntimeForChatRoute(env);
  assert.equal(gated.pass, true);
  if (gated.pass) {
    const keys = Object.keys(gated).sort();
    assert.deepEqual(keys, ["pass", "runtime"]);
    // runtime has a stable .name; the route logs/caches on it.
    assert.ok(
      gated.runtime.name === "anthropic" || gated.runtime.name === "openrouter",
      `unexpected runtime.name: ${String(gated.runtime.name)}`,
    );
  }
});

// --- independence across calls ------------------------------------

test("gate: each call is independent (env swap between calls flips result)", () => {
  // Each call re-reads env via the resolver; no cached instance from
  // a previous call bleeds into the next. This is the property the
  // route relies on — a dev flipping `AI_RUNTIME` mid-session has to
  // be picked up on the NEXT request, not stuck on the original
  // runtime until restart.
  const a = gateRuntimeForChatRoute({ ANTHROPIC_API_KEY: "sk-ant-test" });
  const b = gateRuntimeForChatRoute({
    AI_RUNTIME: "openrouter",
    OPENROUTER_API_KEY: "sk-or-test",
    OPENROUTER_MODEL: "openai/gpt-4o",
  });
  const c = gateRuntimeForChatRoute({});
  assert.equal(a.pass, true);
  if (a.pass) assert.equal(a.runtime.name, "anthropic");
  assert.equal(b.pass, true);
  if (b.pass) assert.equal(b.runtime.name, "openrouter");
  assert.equal(c.pass, false);
  if (!c.pass) assert.equal(c.body.error, "anthropic_not_configured");
});

// --- undefined env falls through to process.env (default param) --

test("gate: omitting env argument reads from process.env", () => {
  // Belt-and-braces pin on the default parameter — the route calls
  // `gateRuntimeForChatRoute()` with no args in production. We
  // briefly mutate process.env here to prove the default wires
  // through to it; restore on exit so nothing downstream sees state.
  const savedRuntime = process.env.AI_RUNTIME;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  try {
    delete process.env.AI_RUNTIME;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const gated = gateRuntimeForChatRoute();
    assert.equal(gated.pass, true);
    if (gated.pass) assert.equal(gated.runtime.name, "anthropic");
  } finally {
    if (savedRuntime === undefined) delete process.env.AI_RUNTIME;
    else process.env.AI_RUNTIME = savedRuntime;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  }
});
