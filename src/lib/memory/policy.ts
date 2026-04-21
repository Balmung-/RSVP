// P16-A — durable memory policy.
//
// A single, typed policy object controls every knob that future
// P16 slices will lean on (body length cap, default kind, list
// limits, ...). Today the values are conservative defaults — no
// behavior change in the repo, because nothing yet reads a memory
// or writes one. The policy exists now so P16-B/C/D/E don't have
// to sprinkle magic numbers into the tool/route/UI code; they
// pull from this single source.
//
// Shape discipline:
//   - Frozen object (`as const`) so callers can't mutate the
//     default inadvertently.
//   - `memoryPolicyFromEnv(env)` reads optional overrides for the
//     few knobs that will eventually be environment-tunable
//     (e.g. the list cap on very large tenants). P16-A does NOT
//     read any env yet; the function is scaffolded so later
//     slices don't reshape its signature.
//
// Why this lives in its own module (not alongside the query
// builder): P16-C (retrieval/ranking) and P16-B (write seam)
// will both consume the policy, but they don't share the query
// code. Keeping the policy in its own file means neither slice
// has to pull in the Prisma query shape just to read a number.

export type MemoryPolicy = {
  // Application-level cap on Memory.body length. Enforced by the
  // P16-B write seam — the Postgres column is unbounded so a
  // bypass writes through, but every sanctioned write path must
  // call the validator that consults this value. 1024 chars is
  // the default because memories are meant to be terse ("operator
  // prefers morning campaign sends"), not archival documents.
  maxBodyLength: number;

  // Default `Memory.kind` when a writer doesn't supply one.
  // P16-A pins "fact" as the baseline. P16-B's validator will
  // enforce a closed set of accepted kinds; this default must be
  // a member of that set.
  defaultKind: string;

  // `buildMemoryListQuery(teamId)` uses this when the caller
  // doesn't specify a limit. Small enough that naive prompt
  // injection in a future recall slice stays within the context
  // budget; large enough that the team's core facts fit.
  listDefaultLimit: number;

  // Hard ceiling on caller-supplied limits. `buildMemoryListQuery`
  // clamps to this, so a caller passing `{ limit: 100_000 }` can't
  // hose the DB. P16-C's retrieval slice may tune this downward
  // based on token budget; raising it requires an explicit
  // policy change.
  listMaxLimit: number;

  // P16-C — default row count for the RECALL path (prompt
  // injection / ranked retrieval). Distinct from `listDefaultLimit`
  // because recall feeds a token-budgeted context window, not an
  // operator UI. 10 is conservative; P16-D can raise it if prompt
  // context headroom allows.
  recallDefaultLimit: number;

  // P16-C — hard ceiling on caller-supplied recall limits.
  // Strictly smaller than `listMaxLimit` because recall rows go
  // into the model's prompt context. Even at max body length
  // (`maxBodyLength`), 25 rows is ~25 KB of memory text before
  // any non-memory context, which is already near the practical
  // upper bound for useful recall. A caller passing
  // `{ limit: 1_000 }` to the recall path clamps to this value.
  recallMaxLimit: number;

  // P16-C.1 — hard ceiling on the DB-level `take` for the recall
  // path. Distinct from `recallMaxLimit` because the recall
  // builder OVERFETCHES: it scans more rows than the user's final
  // limit so the ranker's post-fetch dedup has headroom to
  // backfill unique memories when the newest N rows include
  // duplicates (the pathological case is an operator repeatedly
  // editing the same hot fact, which otherwise crowds out older
  // uniques).
  //
  // Invariant chain: `recallMaxLimit <= recallScanMaxLimit
  // <= listMaxLimit`. 100 is chosen so:
  //   - at max user limit (25), scan budget is fully consumed
  //     (25 * 4 = 100), tolerating 3 duplicates per delivered row;
  //   - the worst-case fetch payload is ~100 KB (100 rows *
  //     1024-char body cap), still negligible vs chat context;
  //   - it stays well below `listMaxLimit` so the "list is the
  //     wide read path" framing is preserved.
  recallScanMaxLimit: number;
};

// Immutable defaults. Every future policy consumer that wants
// something non-default should build a new policy explicitly
// rather than mutating this object.
export const DEFAULT_MEMORY_POLICY: MemoryPolicy = Object.freeze({
  maxBodyLength: 1024,
  defaultKind: "fact",
  listDefaultLimit: 50,
  listMaxLimit: 200,
  recallDefaultLimit: 10,
  recallMaxLimit: 25,
  recallScanMaxLimit: 100,
});

// Scaffolded for future env-driven overrides. P16-A returns the
// defaults verbatim; the function signature takes an `env` map
// rather than reading `process.env` directly so future tests can
// inject values without touching the live environment.
export function memoryPolicyFromEnv(
  _env: Record<string, string | undefined> = process.env,
): MemoryPolicy {
  // Intentional: no env reads in P16-A. Pinning this at the
  // defaults now means P16-B/C can wire specific overrides
  // without reshaping the call sites. The `_env` parameter is
  // kept so the signature is stable across the tranche.
  return DEFAULT_MEMORY_POLICY;
}
