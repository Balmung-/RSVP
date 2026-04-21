import { DEFAULT_MEMORY_POLICY, type MemoryPolicy } from "./policy";

// P16-B — pure validator for memory writes.
//
// Follows the `widget-validate.ts` / `directive-validate.ts` house
// pattern: a pure function that returns the canonical input shape
// on pass, or `null` on any failure. No I/O, no throws for caller
// mistakes — returning null keeps the validator composable
// (callers can choose to log, throw, or silently skip).
//
// Closed `kind` set: `MEMORY_KINDS`. P16-A left `Memory.kind` as a
// Postgres `String` (no Prisma enum) so expansion is a validator
// change, not a migration. P16-B CLOSES the set at the write seam:
// only "fact" is accepted today. Future slices that need a new
// kind (e.g. "preference" for P16-C retrieval-by-kind) must widen
// this array + update the per-kind tests in one commit. The point
// is that the DB column is never written with an arbitrary string
// even if a misbehaving caller (a future tool, an operator form,
// a stale chat session) tries to smuggle one through.
//
// Length cap: `policy.maxBodyLength` (1024 default). Enforced on
// the raw body length — a caller sending a 2 KB prompt-injected
// blob fails closed. Short memories are the product intent ("team
// prefers morning sends", "VIP tier list is frozen"), not archival
// documents.
//
// Provenance normalisation: sourceSessionId / sourceMessageId /
// createdByUserId are all optional `string | null`. The validator
// normalises `undefined` and `""` to `null` — both would confuse
// Prisma's FK lookup ("record not found" for empty string, a
// type error for undefined when the field is declared nullable).
// Non-empty strings pass through AS-IS (we do not trim IDs; a
// caller passing "  cuid  " has a bug that should fail loudly at
// the FK edge, not be silently scrubbed here).
//
// "Validate, don't rewrite": body is stored AS-IS. The validator
// rejects whitespace-only bodies (by checking `trim().length > 0`)
// but does NOT trim for storage. Upper-layer UI can choose to
// display trimmed; the raw bytes the operator typed go to the DB.

export const MEMORY_KINDS = ["fact"] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export type MemoryWriteInput = {
  teamId: string;
  body: string;
  kind: MemoryKind;
  // Canonical shape uses `null` (not `undefined`) for absent
  // provenance so downstream `prisma.memory.create` consumes the
  // shape verbatim. Schema declares all three as `String?` with
  // `onDelete: SetNull` — `null` is the on-wire representation.
  sourceSessionId: string | null;
  sourceMessageId: string | null;
  createdByUserId: string | null;
};

// ---- primitive helpers ----
// Duplicated from widget-validate.ts on purpose; per that file's
// top-of-file rationale, keeping validators independent avoids
// coupling two trust boundaries. The duplication is tiny.

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isOneOf<T extends string>(
  v: unknown,
  allowed: readonly T[],
): v is T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v);
}

// ---- provenance normaliser ----
//
// Returns the canonical value for a nullable FK field:
//   - key absent / value undefined / value null / value ""   -> null
//   - value is a non-empty string                            -> the string
//   - anything else (number, object, ...)                    -> throws via
//                                                               a caller
//                                                               precheck
//
// The predicate + normaliser are kept separate so the caller can
// short-circuit the validator return on a shape violation
// (`isStringOrNull` fails) and then call `normaliseProvenance` once
// the value is known to be `string | null | undefined`.

function isProvenanceShape(v: unknown): v is string | null | undefined {
  return v === undefined || v === null || typeof v === "string";
}

function normaliseProvenance(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  if (v === "") return null;
  return v;
}

// ---- public entry point ----
//
// Returns the canonical write shape on pass, or `null` on any
// failure (unknown kind, missing required field, oversized body,
// type mismatch on an optional field, ...). Callers that need
// "caller bug, not runtime state" semantics — e.g. a server-only
// write helper that should never see an invalid input in the
// first place — can throw on a null return at their boundary.
//
// Policy override: passing a custom `MemoryPolicy` lets a test or
// a future P16-C retrieval slice retune the max length without
// mutating `DEFAULT_MEMORY_POLICY`. The policy's `defaultKind`
// must be a valid `MemoryKind`; if it isn't, the validator
// fails closed on a caller that didn't supply its own `kind`
// (a policy misconfiguration is treated as a validation failure,
// not a silent fallback to the first kind in the set).

export function validateMemoryWrite(
  input: unknown,
  policy: MemoryPolicy = DEFAULT_MEMORY_POLICY,
): MemoryWriteInput | null {
  if (!isPlainObject(input)) return null;

  // teamId: required, non-empty (and non-whitespace). Mirrors the
  // `buildMemoryListQuery` contract — tenancy must be explicit.
  if (!isNonEmptyString(input.teamId)) return null;
  if (input.teamId.trim().length === 0) return null;

  // body: required, non-empty (after trim), capped at
  // policy.maxBodyLength. The cap applies to the RAW length — a
  // caller can't smuggle a long body by padding with whitespace,
  // because the whitespace counts too.
  if (!isNonEmptyString(input.body)) return null;
  if (input.body.trim().length === 0) return null;
  if (input.body.length > policy.maxBodyLength) return null;

  // kind: optional. If present, must be a string in MEMORY_KINDS.
  // If absent, policy.defaultKind is substituted AND re-checked
  // against MEMORY_KINDS (a misconfigured policy fails closed
  // rather than writing an unknown kind to the DB).
  let kind: string;
  if ("kind" in input && input.kind !== undefined) {
    if (!isString(input.kind)) return null;
    kind = input.kind;
  } else {
    kind = policy.defaultKind;
  }
  if (!isOneOf(kind, MEMORY_KINDS)) return null;

  // provenance: all three are optional + nullable. Shape check
  // first (reject non-string, non-null, non-undefined values),
  // then normalise undefined / null / "" to `null` for the
  // canonical output shape.
  if ("sourceSessionId" in input && !isProvenanceShape(input.sourceSessionId)) {
    return null;
  }
  if ("sourceMessageId" in input && !isProvenanceShape(input.sourceMessageId)) {
    return null;
  }
  if ("createdByUserId" in input && !isProvenanceShape(input.createdByUserId)) {
    return null;
  }
  const sourceSessionId = normaliseProvenance(
    input.sourceSessionId as string | null | undefined,
  );
  const sourceMessageId = normaliseProvenance(
    input.sourceMessageId as string | null | undefined,
  );
  const createdByUserId = normaliseProvenance(
    input.createdByUserId as string | null | undefined,
  );

  return {
    teamId: input.teamId,
    body: input.body,
    kind,
    sourceSessionId,
    sourceMessageId,
    createdByUserId,
  };
}
