// Pure pre-claim classifier for the `/api/chat/confirm/[messageId]`
// route. Sits BEFORE the atomic single-use claim (which lives inside
// runConfirmSend / runConfirmImport) and decides whether a confirm
// attempt is even coherent enough to dispatch.
//
// Four denial branches + one success branch:
//
//   1. `wrong_tool` — the row's toolName isn't in ANCHOR_MAP, so we
//      don't know which destructive tool the attempt targeted. Audits
//      under the GENERIC `ai.denied.confirm` kind because we can't
//      resolve a per-tool denied kind.
//   2. `anchor_was_error` — the row's propose_* call itself failed
//      (e.g. `forbidden`, `not_found`). A confirm on a failed propose
//      is a UI-layer bug and has no coherent action to re-dispatch.
//   3. `already_confirmed` — the row's `confirmedAt` is already set,
//      so the single-use anchor has been consumed. Fast-path check
//      skipping the expensive toolInput parse + ctx build.
//   4. `corrupt_input` — `row.toolInput` doesn't JSON.parse. The
//      destructive tool's `validate()` would reject anything unexpected,
//      but failing the parse BEFORE reaching validate() keeps the
//      audit trail distinct (parse-failure vs schema-rejection).
//
// All four denial branches emit audit events via `logAction` in the
// route. Extracting the decision here makes each branch's audit kind,
// status code, error code, and payload shape unit-testable without
// spinning up Next / prisma / auth. The route becomes a thin
// outcome-to-side-effect switch.
//
// Contract guarantees pinned by tests (see confirm-preclaim.test.ts):
//   - `wrong_tool` audits under `ai.denied.confirm`, all others under
//     `anchorConfig.deniedAuditKind` (per-tool).
//   - `already_confirmed` uses status 409; the other three use 400.
//   - `data.reason` on every denial is the literal denial code —
//     greppable in the audit stream.
//   - On `ok`, anchorConfig is the full ANCHOR_MAP entry (carries the
//     destructiveTool + confirmAuditKind + deniedAuditKind used by
//     the downstream runConfirm* flow).
//   - On `ok` with no toolInput, parsedInput defaults to `{}` (same
//     behaviour as the pre-P14-B' inline code path — commit_import
//     and send_campaign both accept `{}` as a degenerate empty input
//     and reject via their own validate()).

// ---- anchor registry ----
//
// The two proposal anchors today: propose_send → send_campaign, and
// propose_import → commit_import. Keeping this as a closed literal
// lets TypeScript catch the "added a flow but forgot to wire audit
// kinds" regression at the type level; a runtime test in the
// classifier spec pins the map's contents against drift.

export type AnchorConfig = {
  destructiveTool: "send_campaign" | "commit_import";
  confirmAuditKind: "ai.confirm.send_campaign" | "ai.confirm.commit_import";
  deniedAuditKind: "ai.denied.send_campaign" | "ai.denied.commit_import";
};

export const ANCHOR_MAP: Record<string, AnchorConfig> = {
  propose_send: {
    destructiveTool: "send_campaign",
    confirmAuditKind: "ai.confirm.send_campaign",
    deniedAuditKind: "ai.denied.send_campaign",
  },
  propose_import: {
    destructiveTool: "commit_import",
    confirmAuditKind: "ai.confirm.commit_import",
    deniedAuditKind: "ai.denied.commit_import",
  },
};

// ---- classifier types ----

// Minimal shape of the anchor row we need to classify. Smaller than
// the full Prisma ChatMessage record so test fixtures don't have to
// satisfy unrelated columns (content, createdAt, etc.) — that drift
// has been a real source of friction in other test files.
export type PreClaimRow = {
  toolName: string | null;
  toolInput: string | null;
  isError: boolean;
  confirmedAt: Date | null;
  sessionId: string;
};

// Every known denial code the route surfaces. Keeping these as a union
// means adding a new denial branch forces a compile-time update to
// this type AND to the discriminated-union outcome below.
export type PreClaimDenialError =
  | "wrong_tool"
  | "anchor_was_error"
  | "already_confirmed"
  | "corrupt_input";

// Audit kind for a denial. `ai.denied.confirm` is the generic fallback
// used ONLY by `wrong_tool` (we don't know which destructive tool
// would have run); the per-tool denied kinds come from the ANCHOR_MAP
// entry.
export type PreClaimDenialAuditKind =
  | "ai.denied.confirm"
  | "ai.denied.send_campaign"
  | "ai.denied.commit_import";

export type PreClaimOutcome =
  | {
      kind: "ok";
      anchorConfig: AnchorConfig;
      parsedInput: unknown;
    }
  | {
      kind: "denied";
      error: PreClaimDenialError;
      status: 400 | 409;
      auditKind: PreClaimDenialAuditKind;
      // The full `data` payload the route passes to logAction.
      // Shape varies per denial branch — union of all shapes would
      // explode the type without adding safety. Tests pin the exact
      // keys per branch.
      auditData: Record<string, unknown>;
    };

// ---- classify ----
//
// Pure function over the row + messageId. The route does the prisma
// lookup + auth, passes the result here, and based on the outcome
// either fires `logAction(...)` + a NextResponse or proceeds to build
// ctx + call runConfirm*.
export function classifyPreClaim(args: {
  row: PreClaimRow;
  messageId: string;
}): PreClaimOutcome {
  const { row, messageId } = args;

  // (1) wrong_tool — toolName is null or not in ANCHOR_MAP. Note: we
  // use `row.toolName` as the key even though it's typed `string | null`
  // — looking up `undefined` in a `Record<string, ...>` returns undefined
  // (same as a missing key), so a null toolName trips the same branch
  // as an unknown toolName. Both surface as `wrong_tool`.
  const anchorConfig = row.toolName ? ANCHOR_MAP[row.toolName] : undefined;
  if (!anchorConfig) {
    return {
      kind: "denied",
      error: "wrong_tool",
      status: 400,
      auditKind: "ai.denied.confirm",
      auditData: {
        via: "confirm",
        reason: "wrong_tool",
        messageId,
        toolName: row.toolName,
      },
    };
  }

  // (2) anchor_was_error — the propose_* row itself failed. A confirm
  // on a failed propose is a UI-layer bug (the confirm button
  // shouldn't have rendered). Refuse loudly under the per-tool denied
  // kind so the audit stream carries the destructive tool that would
  // have been targeted.
  if (row.isError) {
    return {
      kind: "denied",
      error: "anchor_was_error",
      status: 400,
      auditKind: anchorConfig.deniedAuditKind,
      auditData: {
        via: "confirm",
        reason: "anchor_was_error",
        messageId,
      },
    };
  }

  // (3) already_confirmed fast-path. Race-unsafe on its own (two
  // parallel requests can both see confirmedAt=null here); the atomic
  // claim inside runConfirm* is the real guard. This skip path exists
  // so the common "refreshed the tab, clicked again" case returns 409
  // without paying for the toolInput parse + ctx build.
  if (row.confirmedAt) {
    return {
      kind: "denied",
      error: "already_confirmed",
      status: 409,
      auditKind: anchorConfig.deniedAuditKind,
      auditData: {
        via: "confirm",
        reason: "already_confirmed",
        messageId,
        confirmedAt: row.confirmedAt.toISOString(),
      },
    };
  }

  // (4) corrupt_input — toolInput didn't JSON.parse. An anchor row
  // with a null toolInput is valid: commit_import and send_campaign
  // both accept a degenerate empty input and reject via validate().
  // Only a string that fails JSON.parse trips this branch.
  let parsedInput: unknown = {};
  if (row.toolInput) {
    try {
      parsedInput = JSON.parse(row.toolInput);
    } catch {
      return {
        kind: "denied",
        error: "corrupt_input",
        status: 400,
        auditKind: anchorConfig.deniedAuditKind,
        auditData: {
          via: "confirm",
          reason: "corrupt_input",
          messageId,
        },
      };
    }
  }

  return {
    kind: "ok",
    anchorConfig,
    parsedInput,
  };
}
