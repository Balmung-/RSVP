import { test } from "node:test";
import assert from "node:assert/strict";

import { guardRuntimeOnBoot, registerBootGuard } from "../../src/lib/boot/runtime-guard";

// P15-D — boot-time runtime guard.
//
// The Next.js instrumentation hook calls `guardRuntimeOnBoot()` once
// per server process. In production, a misconfigured AI runtime
// throws at startup — preferable to booting into a state where every
// /api/chat request 503s and ops only notices after an operator
// complaint. In dev/test, the guard warns and continues so local
// work can proceed without an AI key.
//
// Regression surfaces protected:
//   - Production + misconfigured → onFatal invoked (default throws)
//   - Non-production + misconfigured → warning logged, boot continues
//   - Configured → info log, `passed` action, onFatal NOT called
//   - Log shape is machine-parseable (stable key=value format for
//     aggregators like Datadog / Loki / CloudWatch)
//   - Env is injected (no mutation of process.env across tests)
//   - Logger is injected (no stdout leakage in test runs)
//   - onFatal is injected (test assertions run instead of
//     process.exit terminating the runner)
//   - NODE_ENV matching is strict: "production" is prod; "Production"
//     / "prod" / unset / "" are all non-production (pin current
//     behavior so a future relaxation trips this tripwire)

function makeLogger() {
  const calls: { level: "info" | "error"; message: string }[] = [];
  return {
    calls,
    logger: {
      info: (m: string) => calls.push({ level: "info", message: m }),
      error: (m: string) => calls.push({ level: "error", message: m }),
    },
  };
}

function makeFatalSpy() {
  const calls: string[] = [];
  return {
    calls,
    onFatal: (m: string) => {
      calls.push(m);
    },
  };
}

test("guardRuntimeOnBoot: production + configured → passed, no fatal", () => {
  const { logger, calls: logCalls } = makeLogger();
  const { onFatal, calls: fatalCalls } = makeFatalSpy();
  const res = guardRuntimeOnBoot({
    env: { NODE_ENV: "production", ANTHROPIC_API_KEY: "sk-prod" },
    logger,
    onFatal,
  });
  assert.equal(res.action, "passed");
  assert.equal(res.mode, "production");
  assert.equal(res.probe.configured, true);
  assert.equal(fatalCalls.length, 0, "onFatal must not fire on configured boot");
  assert.equal(logCalls.length, 1);
  assert.equal(logCalls[0].level, "info");
  assert.match(logCalls[0].message, /\[runtime-boot\] ai\.name=anthropic configured=true/);
});

test("guardRuntimeOnBoot: non-production + configured → passed, no fatal", () => {
  const { logger, calls: logCalls } = makeLogger();
  const { onFatal, calls: fatalCalls } = makeFatalSpy();
  const res = guardRuntimeOnBoot({
    env: { NODE_ENV: "development", ANTHROPIC_API_KEY: "sk-dev" },
    logger,
    onFatal,
  });
  assert.equal(res.action, "passed");
  assert.equal(res.mode, "non-production");
  assert.equal(fatalCalls.length, 0);
  assert.equal(logCalls[0].level, "info");
});

test("guardRuntimeOnBoot: production + missing anthropic key → fatal fires, error logged", () => {
  const { logger, calls: logCalls } = makeLogger();
  const { onFatal, calls: fatalCalls } = makeFatalSpy();
  const res = guardRuntimeOnBoot({
    env: { NODE_ENV: "production" },
    logger,
    onFatal,
  });
  assert.equal(res.action, "fatal");
  assert.equal(res.mode, "production");
  assert.equal(res.probe.configured, false);
  assert.equal(res.probe.reason, "anthropic_not_configured");
  assert.equal(fatalCalls.length, 1, "onFatal must fire exactly once");
  assert.match(fatalCalls[0], /ai\.name=anthropic configured=false reason=anthropic_not_configured/);
  assert.equal(logCalls.length, 1);
  assert.equal(logCalls[0].level, "error");
  // Prod fatal log must NOT carry the "non-production boot continues" suffix
  assert.equal(logCalls[0].message.includes("non-production"), false);
});

test("guardRuntimeOnBoot: production + missing openrouter model → fatal fires with openrouter reason", () => {
  const { logger, calls: logCalls } = makeLogger();
  const { onFatal, calls: fatalCalls } = makeFatalSpy();
  const res = guardRuntimeOnBoot({
    env: {
      NODE_ENV: "production",
      AI_RUNTIME: "openrouter",
      OPENROUTER_API_KEY: "sk-or",
    },
    logger,
    onFatal,
  });
  assert.equal(res.action, "fatal");
  assert.equal(res.probe.reason, "openrouter_not_configured");
  assert.equal(fatalCalls.length, 1);
  assert.match(fatalCalls[0], /reason=openrouter_not_configured/);
  assert.equal(logCalls[0].level, "error");
});

test("guardRuntimeOnBoot: non-production + missing key → warned, onFatal NOT fired", () => {
  const { logger, calls: logCalls } = makeLogger();
  const { onFatal, calls: fatalCalls } = makeFatalSpy();
  const res = guardRuntimeOnBoot({
    env: { NODE_ENV: "development" },
    logger,
    onFatal,
  });
  assert.equal(res.action, "warned");
  assert.equal(res.mode, "non-production");
  assert.equal(res.probe.configured, false);
  assert.equal(fatalCalls.length, 0, "onFatal must not fire in non-production");
  assert.equal(logCalls.length, 1);
  assert.equal(logCalls[0].level, "error");
  // Non-prod error log should carry the boot-continues annotation
  assert.match(logCalls[0].message, /non-production boot continues/);
});

test("guardRuntimeOnBoot: NODE_ENV=test + missing key → warned (test runs are non-production)", () => {
  const { logger, calls: logCalls } = makeLogger();
  const { onFatal, calls: fatalCalls } = makeFatalSpy();
  const res = guardRuntimeOnBoot({
    env: { NODE_ENV: "test" },
    logger,
    onFatal,
  });
  assert.equal(res.action, "warned");
  assert.equal(fatalCalls.length, 0);
  assert.equal(logCalls[0].level, "error");
});

test("guardRuntimeOnBoot: NODE_ENV unset → non-production (pin current behavior)", () => {
  const { logger } = makeLogger();
  const { onFatal, calls: fatalCalls } = makeFatalSpy();
  const res = guardRuntimeOnBoot({
    env: { ANTHROPIC_API_KEY: "sk-any" },
    logger,
    onFatal,
  });
  assert.equal(res.mode, "non-production");
  assert.equal(res.action, "passed");
  assert.equal(fatalCalls.length, 0);
});

test("guardRuntimeOnBoot: NODE_ENV='' → non-production (empty string is not prod)", () => {
  const { logger } = makeLogger();
  const { onFatal, calls: fatalCalls } = makeFatalSpy();
  const res = guardRuntimeOnBoot({
    env: { NODE_ENV: "", ANTHROPIC_API_KEY: "sk-any" },
    logger,
    onFatal,
  });
  assert.equal(res.mode, "non-production");
  assert.equal(fatalCalls.length, 0);
});

test("guardRuntimeOnBoot: NODE_ENV='Production' (capitalized) → NOT production (strict match)", () => {
  // Pin current behavior: strict === "production". Any future
  // relaxation to case-insensitive matching trips this test so the
  // change is explicit.
  const { logger } = makeLogger();
  const { onFatal, calls: fatalCalls } = makeFatalSpy();
  const res = guardRuntimeOnBoot({
    env: { NODE_ENV: "Production" },
    logger,
    onFatal,
  });
  assert.equal(res.mode, "non-production");
  assert.equal(res.action, "warned");
  assert.equal(fatalCalls.length, 0);
});

test("guardRuntimeOnBoot: NODE_ENV='prod' (abbreviated) → NOT production", () => {
  const { logger } = makeLogger();
  const { onFatal, calls: fatalCalls } = makeFatalSpy();
  const res = guardRuntimeOnBoot({
    env: { NODE_ENV: "prod", ANTHROPIC_API_KEY: "sk-any" },
    logger,
    onFatal,
  });
  assert.equal(res.mode, "non-production");
  assert.equal(fatalCalls.length, 0);
});

test("guardRuntimeOnBoot: default onFatal throws (prod misconfig aborts startup)", () => {
  // Default onFatal MUST throw so Next.js register() fails startup.
  // Otherwise a misconfigured deploy would boot into a broken state.
  const { logger } = makeLogger();
  assert.throws(
    () =>
      guardRuntimeOnBoot({
        env: { NODE_ENV: "production" },
        logger,
        // no onFatal — exercises default
      }),
    /runtime-boot.*configured=false.*reason=anthropic_not_configured/,
  );
});

test("guardRuntimeOnBoot: log message is machine-parseable (stable key=value format)", () => {
  const { logger, calls: logCalls } = makeLogger();
  const { onFatal } = makeFatalSpy();
  guardRuntimeOnBoot({
    env: {
      NODE_ENV: "production",
      AI_RUNTIME: "openrouter",
      OPENROUTER_API_KEY: "sk-or",
      OPENROUTER_MODEL: "anthropic/claude-sonnet-4.6",
    },
    logger,
    onFatal,
  });
  assert.equal(logCalls.length, 1);
  const msg = logCalls[0].message;
  // Prefix is stable for log-aggregator filters
  assert.ok(msg.startsWith("[runtime-boot] "), `prefix check: ${msg}`);
  // Fields are space-separated key=value pairs
  assert.match(msg, /ai\.name=openrouter/);
  assert.match(msg, /configured=true/);
  // No unquoted commas or embedded whitespace in values
  assert.equal(msg.includes(","), false);
});

test("guardRuntimeOnBoot: GuardResult.probe matches probeRuntimeConfig output", () => {
  // Result exposes the probe verbatim so callers (tests, future
  // diagnostics) can inspect `name`, `configured`, `reason` without
  // re-running the probe.
  const { logger } = makeLogger();
  const { onFatal } = makeFatalSpy();
  const res = guardRuntimeOnBoot({
    env: {
      NODE_ENV: "development",
      AI_RUNTIME: "openrouter",
      OPENROUTER_API_KEY: "sk-or",
      OPENROUTER_MODEL: "anthropic/claude-sonnet-4.6",
    },
    logger,
    onFatal,
  });
  assert.deepEqual(res.probe, { name: "openrouter", configured: true });
});

test("guardRuntimeOnBoot: default logger is console (brief capture + restore)", () => {
  // Exercises the default-logger path without asserting exact
  // stdout contents — we just confirm the call reaches the console
  // without throwing. Keeps the default-param branch covered by
  // the suite.
  const origLog = console.log;
  const origErr = console.error;
  const seen: string[] = [];
  console.log = (m: unknown) => {
    seen.push(String(m));
  };
  console.error = (m: unknown) => {
    seen.push(String(m));
  };
  try {
    const { onFatal } = makeFatalSpy();
    guardRuntimeOnBoot({
      env: { NODE_ENV: "development", ANTHROPIC_API_KEY: "sk-dev" },
      onFatal,
    });
    assert.equal(seen.length, 1);
    assert.match(seen[0], /\[runtime-boot\]/);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
});

test("registerBootGuard: production + misconfig → hard-exits with code 1", () => {
  // Next.js 14 catches throws from register() and keeps the process
  // alive serving 500s. The wrapper MUST hard-exit in production so
  // the platform sees a crash loop. The guard's throw still fires
  // (belt-and-suspenders for test-stub exit) — this test asserts
  // the exit spy was called with code 1.
  const exitCalls: number[] = [];
  const { logger } = makeLogger();
  assert.throws(
    () =>
      registerBootGuard({
        env: { NODE_ENV: "production" },
        exit: (code: number) => {
          exitCalls.push(code);
        },
        guard: (opts) => guardRuntimeOnBoot({ ...opts, logger }),
      }),
    /runtime-boot.*configured=false/,
  );
  assert.equal(exitCalls.length, 1, "exit must fire exactly once in prod + misconfig");
  assert.equal(exitCalls[0], 1, "exit code must be 1 so platform treats it as crash");
});

test("registerBootGuard: production + configured → no exit, no throw", () => {
  const exitCalls: number[] = [];
  const { logger } = makeLogger();
  registerBootGuard({
    env: { NODE_ENV: "production", ANTHROPIC_API_KEY: "sk-prod" },
    exit: (code: number) => {
      exitCalls.push(code);
    },
    guard: (opts) => guardRuntimeOnBoot({ ...opts, logger }),
  });
  assert.equal(exitCalls.length, 0, "healthy boot must not call exit");
});

test("registerBootGuard: non-production + misconfig → no exit, no throw (guard warns)", () => {
  // In non-production the guard warns and doesn't throw — so the
  // wrapper's try/catch is unreachable and exit is not called.
  const exitCalls: number[] = [];
  const { logger } = makeLogger();
  registerBootGuard({
    env: { NODE_ENV: "development" },
    exit: (code: number) => {
      exitCalls.push(code);
    },
    guard: (opts) => guardRuntimeOnBoot({ ...opts, logger }),
  });
  assert.equal(exitCalls.length, 0, "dev boot must never call exit");
});

test("registerBootGuard: unexpected throw in non-production propagates (no exit, re-throw)", () => {
  // Defensive pin: if a future refactor makes guardRuntimeOnBoot
  // throw in non-production (a bug), the wrapper must not silently
  // swallow the error. It should re-throw so Next's logs surface it.
  const exitCalls: number[] = [];
  assert.throws(
    () =>
      registerBootGuard({
        env: { NODE_ENV: "development" },
        exit: (code: number) => {
          exitCalls.push(code);
        },
        guard: () => {
          throw new Error("unexpected");
        },
      }),
    /unexpected/,
  );
  assert.equal(exitCalls.length, 0, "non-production must not exit even on unexpected throw");
});

test("guardRuntimeOnBoot: default env is process.env (brief mutation with try/finally restore)", () => {
  // Confirms the default-env-param branch picks up live env.
  const prior = {
    NODE_ENV: process.env.NODE_ENV,
    AI_RUNTIME: process.env.AI_RUNTIME,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  const { logger } = makeLogger();
  const { onFatal, calls: fatalCalls } = makeFatalSpy();
  try {
    // Cast through Record because @types/node types NODE_ENV as a
    // narrow string-literal union (readonly from TypeScript's view).
    const writableEnv = process.env as Record<string, string | undefined>;
    writableEnv.NODE_ENV = "development";
    writableEnv.AI_RUNTIME = "anthropic";
    writableEnv.ANTHROPIC_API_KEY = "sk-env-test";
    const res = guardRuntimeOnBoot({ logger, onFatal });
    assert.equal(res.action, "passed");
    assert.equal(res.mode, "non-production");
    assert.equal(fatalCalls.length, 0);
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else process.env[k] = v;
    }
  }
});
