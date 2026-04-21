import { DEFAULT_MEMORY_POLICY, type MemoryPolicy } from "./policy";
import type { MemoryWriteInput } from "./validate";

// P16-F — pure form-input parser for the operator memory create
// form.
//
// Split rationale (same as the admin-query / admin-auth pattern):
// the shape decision lives in a pure module so it can be unit-
// tested without React, without FormData, and without the
// Server Action harness. The Server Action calls FormData-side:
// extract raw strings → hand them to this helper → hand the
// canonical shape to `createMemoryForTeam`.
//
// Why not just call `validateMemoryWrite` directly in the action:
// the validator returns `null` on ANY failure, which is the right
// shape for the server-edge write seam (pass-or-fail) but too
// coarse for operator UX. The form helper distinguishes WHICH
// field was wrong ("missing_body" vs "missing_team" vs
// "body_too_long") so the flash message can point the operator at
// the specific fix. Once the form helper succeeds, the returned
// `input` is guaranteed to pass the validator — no double-check
// is needed at the action layer.
//
// Provenance shaping:
//   - `createdByUserId`: set from the authenticated operator.
//   - `sourceSessionId` / `sourceMessageId`: ALWAYS null here.
//     These fields exist for chat-originated memory writes (where
//     the tool dispatcher knows the session + message ids). An
//     operator-form write has no chat context, so both stay null.
//     A future chat-tool write path (see Agent chat.md — the
//     implicit `remember_fact` tool deferred from P16-D) will
//     populate them, but doesn't reshape this helper.
//
// Kind:
//   - Hard-coded to "fact". `MEMORY_KINDS` in `./validate` is a
//     closed set of exactly one value; future widening is a
//     coordinated validator + form + UI change. Passing a kind
//     via form data is deliberately NOT supported — even if the
//     validator allowed it, the UI doesn't expose a selector.
//
// Body:
//   - Stored AS-IS (no trim). Matches the validator's
//     "validate, don't rewrite" posture: we reject whitespace-
//     only bodies (via `trim().length === 0` check) but the raw
//     bytes the operator typed go to the DB. A future export or
//     diff surface doesn't want silently-scrubbed whitespace.
//   - Length cap checked against RAW length (not trimmed). Mirrors
//     `validateMemoryWrite` exactly so a caller can't pass this
//     helper and then fail the validator on a length mismatch.
//
// Team:
//   - Trimmed on extraction. CUIDs don't contain whitespace, so a
//     padded teamId is a caller bug (stray whitespace from a
//     hidden form input) that's safe to scrub silently.

export type CreateMemoryFormArgs = {
  rawBody: unknown;
  rawTeamId: unknown;
  createdByUserId: string;
  policy?: MemoryPolicy;
};

export type CreateMemoryFormResult =
  | { ok: true; input: MemoryWriteInput }
  | {
      ok: false;
      reason: "missing_body" | "missing_team" | "body_too_long";
    };

export function parseCreateMemoryForm(
  args: CreateMemoryFormArgs,
): CreateMemoryFormResult {
  // Defensive: any non-object / missing-fields caller is a bug
  // rather than a valid request. The Server Action is the only
  // caller today and it always passes the four fields; if a
  // future caller slips up, fail closed as "missing_team"
  // (the strictest reason — operator sees "select a team").
  if (!args || typeof args !== "object") {
    return { ok: false, reason: "missing_team" };
  }
  const policy = args.policy ?? DEFAULT_MEMORY_POLICY;
  const teamId =
    typeof args.rawTeamId === "string" ? args.rawTeamId.trim() : "";
  // Body is NOT trimmed for storage. The `missing_body` check
  // uses a trimmed view so a whitespace-only textarea is treated
  // as empty, but the raw value is what lands in `input.body`.
  const body = typeof args.rawBody === "string" ? args.rawBody : "";
  const createdByUserId =
    typeof args.createdByUserId === "string" && args.createdByUserId.length > 0
      ? args.createdByUserId
      : null;

  if (teamId.length === 0) {
    return { ok: false, reason: "missing_team" };
  }
  if (body.trim().length === 0) {
    return { ok: false, reason: "missing_body" };
  }
  if (body.length > policy.maxBodyLength) {
    return { ok: false, reason: "body_too_long" };
  }

  return {
    ok: true,
    input: {
      teamId,
      body,
      kind: "fact",
      sourceSessionId: null,
      sourceMessageId: null,
      createdByUserId,
    },
  };
}
