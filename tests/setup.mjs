// Test-harness preload for `tsx --test`.
//
// A few test files import modules that transitively pull in
// `src/lib/auth.ts`, which wraps `getCurrentUser` in React 18's
// `cache()`. Under Next.js (RSC) that export is populated by the
// React Server Components runtime; under a plain Node/tsx CJS load
// the `cache` export is undefined and calling it throws at module
// evaluation time, before any test body runs.
//
// We don't exercise `getCurrentUser` from tests — the tests touch
// pure helpers — but simply importing the module graph evaluates
// `cache(async () => ...)`. Polyfilling `cache` to an identity
// function is enough to let module evaluation succeed; the wrapped
// function is never invoked by the tests. No production code path
// is affected: Next.js's runtime replaces this shim before any
// request lands.
//
// Wired in via `tsx --import ./tests/setup.mjs --test ...` in the
// npm `test` script. Keeping this file .mjs rather than .ts so it
// can run with zero transpile cost as the very first thing.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const react = require("react");
if (typeof react.cache !== "function") {
  react.cache = (fn) => fn;
}
