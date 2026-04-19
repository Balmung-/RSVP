import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveRuntime } from "../../src/lib/ai/runtime";

// P1 — runtime selector.
//
// The chat route resolves once per request and translates a failed
// resolution into a 503. These tests pin:
//   (a) default backend is anthropic (no env flip required for the
//       pre-P1 behavior),
//   (b) missing API keys produce a typed failure instead of a thrown
//       exception deep inside a streaming loop,
//   (c) the openrouter slot is reserved and declines until P2.
//
// Environment is passed in rather than read from `process.env` so we
// don't have to mutate shared state across parallel node:test runs.

test("resolveRuntime: defaults to anthropic when AI_RUNTIME is unset", () => {
  const res = resolveRuntime({ ANTHROPIC_API_KEY: "sk-anthropic" });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.runtime.name, "anthropic");
});

test("resolveRuntime: accepts AI_RUNTIME=anthropic (case-insensitive)", () => {
  const res = resolveRuntime({
    AI_RUNTIME: "AnThRoPiC",
    ANTHROPIC_API_KEY: "sk-anthropic",
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.runtime.name, "anthropic");
});

test("resolveRuntime: anthropic without API key → anthropic_not_configured", () => {
  const res = resolveRuntime({ AI_RUNTIME: "anthropic" });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, "anthropic_not_configured");
});

test("resolveRuntime: openrouter slot is reserved and declines until P2", () => {
  // Even with a key set, the openrouter runtime isn't wired yet —
  // the selector MUST refuse rather than construct a half-runtime
  // that would blow up on first stream event.
  const res = resolveRuntime({
    AI_RUNTIME: "openrouter",
    OPENROUTER_API_KEY: "sk-or",
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, "openrouter_not_configured");
});

test("resolveRuntime: unknown backend → unknown_runtime", () => {
  const res = resolveRuntime({
    AI_RUNTIME: "mistral",
    ANTHROPIC_API_KEY: "sk-anthropic",
  });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, "unknown_runtime");
});
