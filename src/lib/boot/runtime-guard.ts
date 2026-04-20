import { probeRuntimeConfig, type RuntimeProbe } from "@/lib/ai/runtime";

// Boot-time runtime guard. In production, a misconfigured AI runtime
// throws here so the server fails to start instead of booting into a
// broken state where every /api/chat request 503s and operators only
// notice after the first user complaint. In non-production the guard
// warns and boots through, so dev can iterate on non-chat surfaces
// without a live AI key.
//
// Shape is dependency-injected:
//   - `env` defaults to process.env
//   - `logger` defaults to console (info/error split)
//   - `onFatal` defaults to throw (Next.js treats a throw from
//     instrumentation's register() as a fatal startup error)
//
// Tests inject stubs for all three so the guard can be exercised
// without mutating process.env, leaking to stdout, or tearing down
// the test runner.

export type BootLogger = {
  info: (message: string) => void;
  error: (message: string) => void;
};

export type BootFatal = (message: string) => void;

export type GuardOptions = {
  env?: { NODE_ENV?: string } & Record<string, string | undefined>;
  logger?: BootLogger;
  onFatal?: BootFatal;
};

export type GuardAction = "passed" | "warned" | "fatal";

export type GuardResult = {
  probe: RuntimeProbe;
  mode: "production" | "non-production";
  action: GuardAction;
};

export function guardRuntimeOnBoot(opts: GuardOptions = {}): GuardResult {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const logger: BootLogger = opts.logger ?? {
    info: (m) => console.log(m),
    error: (m) => console.error(m),
  };
  const onFatal: BootFatal =
    opts.onFatal ??
    ((m) => {
      throw new Error(m);
    });

  const probe = probeRuntimeConfig(env);
  const isProd = env.NODE_ENV === "production";
  const mode: GuardResult["mode"] = isProd ? "production" : "non-production";

  if (probe.configured) {
    logger.info(`[runtime-boot] ai.name=${probe.name} configured=true`);
    return { probe, mode, action: "passed" };
  }

  const msg = `[runtime-boot] ai.name=${probe.name} configured=false reason=${probe.reason}`;

  if (isProd) {
    logger.error(msg);
    onFatal(msg);
    // Reached only when `onFatal` is a test stub that neither throws
    // nor exits. Production default throws, so this path is dead in
    // real deploys. Kept so the function has a defined return in
    // TypeScript's view (onFatal is typed `void`, not `never`).
    return { probe, mode, action: "fatal" };
  }

  logger.error(`${msg} — non-production boot continues`);
  return { probe, mode, action: "warned" };
}

// Next.js 14 contract: throws from `register()` are CAUGHT by the
// server and logged as "Failed to prepare server", but the process
// stays alive and every request returns 500. That's not fail-fast —
// it's a live container with no healthy code path, which looks like
// a working deploy to naive uptime checks.
//
// `registerBootGuard` is the Next-facing wrapper that the
// instrumentation hook actually calls. It runs the pure guard, and
// when the guard throws in production it ALSO hard-exits so the
// platform (Railway / Vercel / plain Docker) sees a crash loop and
// surfaces the failed deploy.
//
// The exit function is injectable so unit tests can assert it was
// called without the test runner itself exiting.

export type BootExit = (code: number) => void;

export type RegisterOptions = {
  guard?: (opts?: GuardOptions) => GuardResult;
  exit?: BootExit;
  env?: GuardOptions["env"];
};

export function registerBootGuard(opts: RegisterOptions = {}): void {
  const guard = opts.guard ?? guardRuntimeOnBoot;
  const exit: BootExit = opts.exit ?? ((code) => process.exit(code));
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  try {
    guard({ env });
  } catch (err) {
    // The guard only throws in production + misconfigured. Next.js
    // catches this throw and keeps serving 500s, so we hard-exit
    // after logging. In non-production the guard doesn't throw, so
    // this catch block is unreachable there.
    if (env.NODE_ENV === "production") {
      exit(1);
    }
    // Re-throw is a belt-and-suspenders for test doubles whose
    // `exit` stub does not actually terminate. In real prod, exit(1)
    // kills the process first and this throw never runs.
    throw err;
  }
}
