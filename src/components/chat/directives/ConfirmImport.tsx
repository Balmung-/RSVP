"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import type { FormatContext } from "./CampaignList";

// P7 — renders the `confirm_import` widget emitted by `propose_import`.
// The operator sees the resolved target (contacts / invitees) + the
// expected counters the planner computed in preview mode, then clicks
// Confirm to trigger the destructive `commit_import` tool through
// `/api/chat/confirm/<messageId>`.
//
// Design mirrors ConfirmSend:
//   - Amber "irreversible action" chrome scaling to the severity.
//   - Counters first. The expected strip is the first thing below
//     the header — the skim path is "what file, how many rows, click".
//   - Blockers are hard gates. `nothing_to_commit`, `file_not_extracted`,
//     `file_unstructured`, `no_campaign_for_invitees` all disable the
//     button and surface a specific fix hint.
//   - Terminal states are visually distinct. `done` morphs to an
//     emerald banner carrying the actual committed counters
//     (`created` / `existingSkipped` / `duplicatesInFile` / `invalid` /
//     `errors`); `error` morphs to a rose banner with the refusal
//     code and a live Retry button (when anchor + not blocked).
//
// Wiring: the Confirm button POSTs to `/api/chat/confirm/<messageId>`
// with no body. The server reads the stored propose_import input,
// re-dispatches `commit_import` with `allowDestructive: true`,
// persists a synthetic assistant summary turn, and returns JSON. On
// success we morph the footer in-place so a second click can't
// re-commit; on failure we surface an inline error and leave the
// button live for retry. `messageId` absent is treated as a hard
// disable — matches the ConfirmSend convention for stale hydrations.

export type ConfirmImportProps = {
  fileUploadId: string;
  ingestId: string;
  filename: string;
  target: "contacts" | "invitees";
  // Required on the `invitees` target (an invitee row must belong to
  // some campaign) and null on `contacts` (contacts are global). The
  // validator enforces this cross-field invariant server-side.
  campaign_id: string | null;
  columns: string[];
  sampledRows: number;
  totalRows: number;
  expected: {
    newRows: number;
    existingSkipped: number;
    // `conflicts` is always 0 in P7 — the planner does key-identity
    // dedupe, not field-level merge. Kept on the shape because the
    // validator requires it and to reserve the seam for a future
    // conflict-resolution pass.
    conflicts: number;
    invalid: number;
  };
  blockers: string[];
  // State drives the render. Same five-state machine `confirm_send`
  // uses — see `CONFIRM_STATES` in `widget-validate.ts`.
  state: "ready" | "blocked" | "submitting" | "done" | "error";
  // Terminal-state payloads.
  result?: {
    created: number;
    existingSkipped: number;
    duplicatesInFile: number;
    invalid: number;
    errors: number;
  };
  error?: string;
  summary?: string;
};

// Blocker codes the server emits on propose_import / commit_import.
// Each maps to a human-readable fix hint so the operator sees WHY
// they can't commit without having to remember the code mapping.
const BLOCKER_LABEL: Record<string, string> = {
  file_not_extracted:
    "The file's text couldn't be extracted — re-upload or try a different format",
  file_unstructured:
    "The file doesn't contain structured rows — check the header and delimiter",
  no_campaign_for_invitees:
    "Invitees import needs a campaign — pick a campaign and re-run the preview",
  campaign_not_found:
    "The target campaign is not visible under this operator's scope",
  nothing_to_commit:
    "No rows would be created — every row is already existing, a within-file duplicate, or invalid",
};

function formatBlocker(raw: string): string {
  return BLOCKER_LABEL[raw] ?? raw;
}

// Refusal codes the commit_import handler returns in `error` on
// structured-refusal paths. Most overlap with blockers (the preview
// and commit whitelists share semantics); a few are commit-only
// (`forbidden` can land here if the operator's role changed between
// propose and confirm, and `handler_error:*` is the generic catch-
// all the dispatcher uses for uncaught throws).
const ERROR_LABEL: Record<string, string> = {
  forbidden: "Refused: operator has viewer permissions only",
  not_found: "Refused: ingest not found under this operator's scope",
  campaign_not_found: "Refused: campaign no longer visible",
  no_campaign_for_invitees: "Refused: invitees commit requires a campaign",
  file_not_extracted: "Refused: the file's text is no longer available",
  nothing_to_commit: "Refused: no rows would be created",
  needs_confirmation: "Internal: anchor routing lost — refresh and retry",
  already_confirmed:
    "Already confirmed — refresh to see the outcome of the prior click",
};

function formatError(raw: string): string {
  if (raw.startsWith("handler_error:")) {
    return `Internal error during commit — ${raw.slice("handler_error:".length)}`;
  }
  if (raw.startsWith("invalid_input:")) {
    return `Invalid input — ${raw.slice("invalid_input:".length)}`;
  }
  return ERROR_LABEL[raw] ?? raw;
}

type ImportState =
  | { phase: "idle" }
  | { phase: "sending" }
  | {
      phase: "done";
      summary: string;
      created: number;
      existingSkipped: number;
      duplicatesInFile: number;
      invalid: number;
      errors: number;
    }
  | { phase: "error"; error: string };

// Project persisted widget state into the local ImportState that
// drives the render. Matches ConfirmSend's `deriveSendState` pattern:
// `ready` / `blocked` / `submitting` all collapse to idle; `done` +
// `error` are terminal and carry their payload.
function deriveImportState(props: ConfirmImportProps): ImportState {
  if (props.state === "done" && props.result) {
    return {
      phase: "done",
      summary: props.summary ?? "Import complete.",
      created: props.result.created,
      existingSkipped: props.result.existingSkipped,
      duplicatesInFile: props.result.duplicatesInFile,
      invalid: props.result.invalid,
      errors: props.result.errors,
    };
  }
  if (props.state === "error") {
    return { phase: "error", error: props.error ?? "unknown" };
  }
  return { phase: "idle" };
}

// Pure predicate for whether the confirm/retry button should accept a
// click. Mirrors `isConfirmSendClickable` — exported so tests cover
// the state matrix without a full React render.
//
// Two clickable regimes:
//   1. Initial confirm: idle + anchor + not-blocked + at least one
//      expected newRow. Without newRows the commit refuses with
//      `nothing_to_commit` anyway — no point in the round trip.
//   2. Retry after refusal: error + anchor + not-blocked. If the
//      preview is now blocked (e.g. `file_not_extracted` showed up
//      on a fresh propose_import because the underlying ingest
//      rotted), retry must NOT be clickable; the operator has to
//      refresh the preview first.
export function isConfirmImportClickable(params: {
  phase: ImportState["phase"];
  hasAnchor: boolean;
  hasBlockers: boolean;
  expectedNewRows: number;
}): boolean {
  if (
    params.phase === "idle" &&
    params.hasAnchor &&
    !params.hasBlockers &&
    params.expectedNewRows > 0
  ) {
    return true;
  }
  if (
    params.phase === "error" &&
    params.hasAnchor &&
    !params.hasBlockers
  ) {
    return true;
  }
  return false;
}

function targetLabel(target: ConfirmImportProps["target"]): string {
  return target === "contacts" ? "contacts" : "invitees";
}

export function ConfirmImport({
  props,
  messageId,
}: {
  props: ConfirmImportProps;
  fmt: FormatContext;
  messageId?: string;
}) {
  const [state, setState] = useState<ImportState>(() =>
    deriveImportState(props),
  );
  useEffect(() => {
    setState(deriveImportState(props));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    props.state,
    props.error,
    props.summary,
    props.result?.created,
    props.result?.existingSkipped,
    props.result?.duplicatesInFile,
    props.result?.invalid,
    props.result?.errors,
  ]);

  const hasBlockers = props.blockers.length > 0;
  const hasAnchor = typeof messageId === "string" && messageId.length > 0;
  const clickable = isConfirmImportClickable({
    phase: state.phase,
    hasAnchor,
    hasBlockers,
    expectedNewRows: props.expected.newRows,
  });

  async function onConfirm() {
    if (!hasAnchor) return;
    setState({ phase: "sending" });
    try {
      const res = await fetch(`/api/chat/confirm/${messageId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (!res.ok) {
        const err =
          (body && typeof body === "object" && "error" in body
            ? String((body as Record<string, unknown>).error)
            : null) ?? `http_${res.status}`;
        setState({ phase: "error", error: err });
        return;
      }
      const b = (body ?? {}) as {
        ok?: boolean;
        summary?: string;
        result?: {
          created?: number;
          existingSkipped?: number;
          duplicatesInFile?: number;
          invalid?: number;
          errors?: number;
        };
        error?: string;
      };
      if (b.ok === false) {
        const err =
          typeof b.error === "string" ? b.error : "import_failed";
        setState({ phase: "error", error: err });
        return;
      }
      const r = b.result ?? {};
      setState({
        phase: "done",
        summary:
          typeof b.summary === "string" ? b.summary : "Import complete.",
        created: typeof r.created === "number" ? r.created : 0,
        existingSkipped:
          typeof r.existingSkipped === "number" ? r.existingSkipped : 0,
        duplicatesInFile:
          typeof r.duplicatesInFile === "number" ? r.duplicatesInFile : 0,
        invalid: typeof r.invalid === "number" ? r.invalid : 0,
        errors: typeof r.errors === "number" ? r.errors : 0,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "network_error";
      setState({ phase: "error", error: msg });
    }
  }

  const scopeLabel =
    props.target === "invitees" && props.campaign_id
      ? `${targetLabel(props.target)} · campaign ${props.campaign_id}`
      : targetLabel(props.target);

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 overflow-hidden">
      <div className="px-3 py-1.5 text-[11px] font-medium text-amber-900 uppercase tracking-wide border-b border-amber-200 flex items-center justify-between">
        <span>Confirm import — destructive action</span>
        <span className="font-normal normal-case tracking-normal text-amber-700">
          target: {scopeLabel}
        </span>
      </div>

      <div className="px-3 py-2 bg-white">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
          <span className="font-medium text-slate-900 text-base">
            {props.filename}
          </span>
          <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-slate-100 text-slate-700">
            {props.totalRows} row{props.totalRows === 1 ? "" : "s"}
          </span>
          {props.columns.length > 0 && (
            <span className="text-slate-500 truncate">
              columns: {props.columns.join(", ")}
            </span>
          )}
        </div>
      </div>

      <div className="px-3 py-2 border-t border-amber-100 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs bg-white">
        <div>
          <div className="text-slate-500">Will create</div>
          <div className="tabular-nums text-slate-900 font-medium">
            {props.expected.newRows}
          </div>
        </div>
        <div>
          <div className="text-slate-500">Already existing</div>
          <div className="tabular-nums text-slate-900">
            {props.expected.existingSkipped}
          </div>
        </div>
        <div>
          <div className="text-slate-500">Conflicts</div>
          <div className="tabular-nums text-slate-900">
            {props.expected.conflicts}
          </div>
        </div>
        <div>
          <div className="text-slate-500">Invalid</div>
          <div className="tabular-nums text-slate-900">
            {props.expected.invalid}
          </div>
        </div>
      </div>

      {hasBlockers && (
        <div className="px-3 py-2 border-t border-amber-100 bg-rose-50 text-xs text-rose-900">
          <div className="font-medium mb-1">
            Cannot commit — resolve these first:
          </div>
          <ul className="list-disc ms-4 space-y-0.5">
            {props.blockers.map((b) => (
              <li key={b}>{formatBlocker(b)}</li>
            ))}
          </ul>
        </div>
      )}

      {state.phase === "done" ? (
        <div className="px-3 py-2 border-t border-emerald-200 bg-emerald-50 text-xs text-emerald-900 space-y-0.5">
          <div className="font-medium">
            Imported {state.created} row{state.created === 1 ? "" : "s"}.
          </div>
          <div className="text-emerald-800">{state.summary}</div>
          {(state.existingSkipped > 0 ||
            state.duplicatesInFile > 0 ||
            state.invalid > 0 ||
            state.errors > 0) && (
            <div className="text-emerald-700 text-[11px] tabular-nums">
              {state.existingSkipped > 0 &&
                `${state.existingSkipped} already-existing`}
              {state.duplicatesInFile > 0 &&
                (state.existingSkipped > 0 ? " · " : "") +
                  `${state.duplicatesInFile} duplicate-in-file`}
              {state.invalid > 0 &&
                (state.existingSkipped > 0 || state.duplicatesInFile > 0
                  ? " · "
                  : "") + `${state.invalid} invalid`}
              {state.errors > 0 &&
                (state.existingSkipped > 0 ||
                state.duplicatesInFile > 0 ||
                state.invalid > 0
                  ? " · "
                  : "") + `${state.errors} failed`}
            </div>
          )}
        </div>
      ) : (
        <div className="px-3 py-2 border-t border-amber-200 bg-amber-50 flex items-center justify-between gap-3">
          <div className="text-[11px] text-amber-800 min-w-0 flex-1">
            {state.phase === "error" ? (
              <span className="text-rose-700">
                {formatError(state.error)}. Try again or refresh the card.
              </span>
            ) : !hasAnchor ? (
              <span>
                Missing confirmation anchor — refresh to reload the card.
              </span>
            ) : hasBlockers ? (
              <span>Resolve blockers before confirming.</span>
            ) : props.expected.newRows === 0 ? (
              <span>No new rows to create — nothing to commit.</span>
            ) : (
              <span>
                Click Confirm to import. This action cannot be undone.
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              void onConfirm();
            }}
            disabled={!clickable}
            title={
              !hasAnchor
                ? "Missing confirmation anchor"
                : hasBlockers
                  ? "Resolve blockers before confirming"
                  : state.phase === "sending"
                    ? "Importing…"
                    : props.expected.newRows === 0
                      ? "No rows to create"
                      : "Import now"
            }
            className={clsx(
              "rounded px-3 py-1.5 text-sm font-medium whitespace-nowrap",
              clickable
                ? "bg-amber-600 text-white hover:bg-amber-700"
                : state.phase === "sending"
                  ? "bg-amber-200 text-amber-900 opacity-80 cursor-wait"
                  : "bg-slate-100 text-slate-400 cursor-not-allowed",
            )}
          >
            {state.phase === "sending"
              ? "Importing…"
              : state.phase === "error"
                ? "Retry"
                : `Import ${props.expected.newRows} row${props.expected.newRows === 1 ? "" : "s"}`}
          </button>
        </div>
      )}
    </div>
  );
}
