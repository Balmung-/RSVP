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
