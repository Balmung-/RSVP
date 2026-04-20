import { test } from "node:test";
import assert from "node:assert/strict";

import { probeRuntimeConfig } from "../../src/lib/ai/runtime";

// P15-A — runtime health probe.
//
// The /api/health endpoint surfaces this probe so ops can confirm a
// deploy picked up the intended AI backend without having to drive a
// real /api/chat request. The probe MUST be side-effect-free: no SDK
// instantiation, no network. That's why it's a distinct export from
// `resolveRuntime` (which calls the SDK factory). Health endpoints
// run on a short cadence; allocating an Anthropic client on each tick
// would be wasteful and — for OpenRouter — would establish a pool
// without any request demand.
//
// Regression surfaces protected:
//   - Default (no AI_RUNTIME) still reports "anthropic" — a rename
//     here would silently flip live health dashboards and could mask
//     a real prod drift.
//   - "configured: false" carries the same symbolic `reason` the
//     resolver uses, so dashboards key on one set of codes.
//   - "unknown" name is distinct from "anthropic" / "openrouter" —
//     typos in AI_RUNTIME must be visible in the probe output, not
//     silently fall back to the default.
//   - Empty string / whitespace are NOT treated as default — they
//     land in "unknown". Pin current behavior so a future tightening
//     that wants to normalize empty → default trips this tripwire.
//   - Side-effect discipline — probe does not require ANY SDK mock
//     or client fixture to run. A test that has to stub `fetch`
//     or construct a client would reveal the probe instantiating
//     something it should not.

test("probeRuntimeConfig: default (no AI_RUNTIME) + anthropic key → configured", () => {
  const res = probeRuntimeConfig({ ANTHROPIC_API_KEY: "sk-anthropic" });
  assert.deepEqual(res, { name: "anthropic", configured: true });
});

test("probeRuntimeConfig: default (no AI_RUNTIME) + no key → not configured, anthropic reason", () => {
  const res = probeRuntimeConfig({});
  assert.deepEqual(res, {
    name: "anthropic",
    configured: false,
    reason: "anthropic_not_configured",
  });
});

test("probeRuntimeConfig: anthropic + empty-string key → not configured (empty ≡ missing)", () => {
  const res = probeRuntimeConfig({ AI_RUNTIME: "anthropic", ANTHROPIC_API_KEY: "" });
  assert.equal(res.configured, false);
  assert.equal(res.name, "anthropic");
  assert.equal(res.reason, "anthropic_not_configured");
});

test("probeRuntimeConfig: anthropic branch is case-insensitive", () => {
  const res = probeRuntimeConfig({
    AI_RUNTIME: "AnThRoPiC",
    ANTHROPIC_API_KEY: "sk-anthropic",
  });
  assert.equal(res.name, "anthropic");
  assert.equal(res.configured, true);
});

test("probeRuntimeConfig: openrouter + key + model → configured", () => {
  const res = probeRuntimeConfig({
    AI_RUNTIME: "openrouter",
    OPENROUTER_API_KEY: "sk-or",
    OPENROUTER_MODEL: "anthropic/claude-sonnet-4.6",
  });
  assert.deepEqual(res, { name: "openrouter", configured: true });
});

test("probeRuntimeConfig: openrouter + missing key → not configured, openrouter reason", () => {
  const res = probeRuntimeConfig({
    AI_RUNTIME: "openrouter",
    OPENROUTER_MODEL: "anthropic/claude-sonnet-4.6",
  });
  assert.deepEqual(res, {
    name: "openrouter",
    configured: false,
    reason: "openrouter_not_configured",
  });
});

test("probeRuntimeConfig: openrouter + missing model → not configured, openrouter reason", () => {
  const res = probeRuntimeConfig({
    AI_RUNTIME: "openrouter",
    OPENROUTER_API_KEY: "sk-or",
  });
  assert.deepEqual(res, {
    name: "openrouter",
    configured: false,
    reason: "openrouter_not_configured",
  });
});

test("probeRuntimeConfig: openrouter + empty-string model → not configured (empty ≡ missing)", () => {
  const res = probeRuntimeConfig({
    AI_RUNTIME: "openrouter",
    OPENROUTER_API_KEY: "sk-or",
    OPENROUTER_MODEL: "",
  });
  assert.equal(res.configured, false);
  assert.equal(res.name, "openrouter");
  assert.equal(res.reason, "openrouter_not_configured");
});

test("probeRuntimeConfig: openrouter branch is case-insensitive", () => {
  const res = probeRuntimeConfig({
    AI_RUNTIME: "OpenRouter",
    OPENROUTER_API_KEY: "sk-or",
    OPENROUTER_MODEL: "anthropic/claude-sonnet-4.6",
  });
  assert.equal(res.name, "openrouter");
  assert.equal(res.configured, true);
});

test("probeRuntimeConfig: unknown runtime value → name='unknown', unknown_runtime reason", () => {
  const res = probeRuntimeConfig({ AI_RUNTIME: "gpt-next" });
  assert.deepEqual(res, {
    name: "unknown",
    configured: false,
    reason: "unknown_runtime",
  });
});

test("probeRuntimeConfig: empty-string AI_RUNTIME → name='unknown' (pin current behavior)", () => {
  const res = probeRuntimeConfig({ AI_RUNTIME: "" });
  assert.deepEqual(res, {
    name: "unknown",
    configured: false,
    reason: "unknown_runtime",
  });
});

test("probeRuntimeConfig: cross-branch pollution — anthropic default does not pick up OPENROUTER_*", () => {
  const res = probeRuntimeConfig({
    OPENROUTER_API_KEY: "sk-or",
    OPENROUTER_MODEL: "anthropic/claude-sonnet-4.6",
    // AI_RUNTIME unset → default to anthropic, anthropic key missing → not configured
  });
  assert.equal(res.name, "anthropic");
  assert.equal(res.configured, false);
  assert.equal(res.reason, "anthropic_not_configured");
});

test("probeRuntimeConfig: optional analytics headers do not affect the gate", () => {
  const res = probeRuntimeConfig({
    AI_RUNTIME: "openrouter",
    OPENROUTER_API_KEY: "sk-or",
    OPENROUTER_MODEL: "anthropic/claude-sonnet-4.6",
    OPENROUTER_HTTP_REFERER: "http://localhost:3000",
    OPENROUTER_X_TITLE: "Test",
  });
  assert.equal(res.configured, true);
});

test("probeRuntimeConfig: default param reads process.env (brief mutation with try/finally restore)", () => {
  const prior = {
    AI_RUNTIME: process.env.AI_RUNTIME,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL,
  };
  try {
    process.env.AI_RUNTIME = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-test-probe";
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MODEL;
    const res = probeRuntimeConfig();
    assert.equal(res.name, "anthropic");
    assert.equal(res.configured, true);
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else process.env[k] = v;
    }
  }
});

test("probeRuntimeConfig: configured=true shape has no `reason` field (clean success envelope)", () => {
  const res = probeRuntimeConfig({
    AI_RUNTIME: "anthropic",
    ANTHROPIC_API_KEY: "sk-anthropic",
  });
  assert.equal(res.configured, true);
  assert.equal("reason" in res, false);
});

test("probeRuntimeConfig: configured=false shape always carries a `reason`", () => {
  const misses = [
    { AI_RUNTIME: "anthropic" },
    { AI_RUNTIME: "openrouter" },
    { AI_RUNTIME: "gpt-next" },
    {},
  ];
  for (const env of misses) {
    const res = probeRuntimeConfig(env);
    assert.equal(res.configured, false);
    assert.equal(typeof res.reason, "string", `reason missing for env: ${JSON.stringify(env)}`);
  }
});
