import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { hasRole } from "@/lib/auth";
import { runImport, type PlannerReport } from "@/lib/importPlanner";
import { parseContactsText } from "@/lib/contact";
import { confirmImportWidgetKey } from "../widgetKeys";
import { buildIngestOwnershipWhere } from "./ingestAccess";
import type { ToolDef, ToolResult } from "./types";

// P7 — preview a file-backed import, WITHOUT committing.
//
// Symmetrical to `propose_send`. Reads an extracted FileIngest,
// runs the shared `runImport` planner in preview mode, and emits a
// `confirm_import` widget with the expected counters the operator
// can sanity-check before clicking Confirm. The destructive write
// is `commit_import`, which the confirm route dispatches with
// `allowDestructive: true` after atomically claiming the anchor.
//
// Why the planner and not `reviewIngest`? `reviewIngest` is a
// preview PARSER that samples rows and reports `new / existing_match`
// using dedupe semantics that don't match the real commit's
// semantics (global Contact.dedupKey vs. per-campaign
// Invitee.dedupKey). A widget that read its counters from the review
// and its rows from the planner would surface numbers the commit
// never agrees with — that's the exact preview/commit trust gap the
// confirmation gate exists to close. The planner in `preview` mode
// runs the full-file pipeline and short-circuits only the final
// `createMany` + `EventLog` write, so every counter displayed here
// equals what a commit would produce, byte-for-byte, against the
// same DB state.
//
// WidgetKey `confirm.import.${target}.${ingestId}` — one in-flight
// preview per (target, ingest) pair. A second propose_import for the
// same pair upserts the same card with refreshed counters; a pivot
// between targets (contacts ↔ invitees) on the same file gets a
// separate anchor, so an operator can have a contacts preview AND
// an invitees preview coexisting on the dashboard.
//
// Scope note — `scope: "read"` despite the role gate. The preview
// itself never writes. Marking this destructive would short-circuit
// the dispatcher and prevent the operator from EVER seeing the
// expected counters. See index.ts:66 for the interception rule.

// Only "contacts" and "invitees" are commitable in P7. `campaign_metadata`
// stays review-only — a metadata commit is a Campaign-row mutation, which
// `draft_campaign` already owns.
export type CommitTarget = "contacts" | "invitees";
const COMMIT_TARGETS: readonly CommitTarget[] = ["contacts", "invitees"];

type Input = {
  ingestId: string;
  target: CommitTarget;
  campaign_id?: string;
};

export const proposeImportTool: ToolDef<Input> = {
  name: "propose_import",
  description:
    "Preview an import WITHOUT committing. Runs the real write pipeline in preview mode over the file's full extracted text and emits a `confirm_import` directive the operator can review before clicking Confirm. Re-run to refresh counters after another editor changed the DB. Does NOT write — the destructive commit_import happens on a separate confirm click. Role-gated: requires editor or admin. Supported targets are `contacts` and `invitees` only; for invitees the `campaign_id` must be supplied and must be in the operator's scope.",
  scope: "read",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["ingestId", "target"],
    properties: {
      ingestId: {
        type: "string",
        description:
          "The FileIngest row id — same id `review_file_import` and `summarize_file` take; extract from the composer's bracketed `[file: … ingestId: <cuid>]` token.",
      },
      target: {
        type: "string",
        enum: ["contacts", "invitees"],
        description:
          "Which table the commit will write to. `contacts` writes to the global contact book; `invitees` writes to a specific campaign's invitee list (requires campaign_id). `campaign_metadata` is not supported — use draft_campaign for that path.",
      },
      campaign_id: {
        type: "string",
        description:
          "Required when target is `invitees`; the campaign whose invitee list will receive the rows. Must be visible under the operator's scope. Ignored when target is `contacts`.",
      },
    },
  },
  validate(raw): Input {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("expected_object");
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.ingestId !== "string" || r.ingestId.trim().length === 0) {
      throw new Error("ingestId_required");
    }
    if (
      typeof r.target !== "string" ||
      !(COMMIT_TARGETS as readonly string[]).includes(r.target)
    ) {
      throw new Error("target:contacts_or_invitees_required");
    }
    const out: Input = {
      ingestId: r.ingestId.trim(),
      target: r.target as CommitTarget,
    };
    if (typeof r.campaign_id === "string" && r.campaign_id.length > 0) {
      out.campaign_id = r.campaign_id;
    }
    return out;
  },
  async handler(input, ctx): Promise<ToolResult> {
    // Role gate: a viewer seeing a ConfirmImport they couldn't actually
    // confirm would be worse than a clean refusal. Same policy as
    // propose_send.
    if (!hasRole(ctx.user, "editor")) {
      return {
        output: {
          error: "forbidden",
          reason: "editor_role_required",
          summary:
            "Cannot propose an import: this operator has viewer permissions only.",
        },
      };
    }

    // Ownership gate — same relation filter `summarize_file` and
    // `review_file_import` use. Non-admins see only their own uploads;
    // wrong-owner ingestIds collapse to "not found" so there's no
    // side-channel for probing other operators' ids.
    const ingest = await prisma.fileIngest.findFirst({
      where: buildIngestOwnershipWhere(input.ingestId, ctx),
      select: {
        id: true,
        fileUploadId: true,
        status: true,
        extractedText: true,
        fileUpload: { select: { filename: true } },
      },
    });
    if (!ingest) {
      return {
        output: {
          error: "not_found",
          id: input.ingestId,
          summary: `No ingest record found for id ${input.ingestId}.`,
        },
      };
    }

    const filename = ingest.fileUpload.filename;

    // Campaign gate for invitees. AND-compose with ctx.campaignScope
    // so a non-admin asking about a campaign outside their team
    // collapses to `campaign_not_found` — same discipline as
    // campaign_detail / propose_send. Contacts target has no
    // campaign to check, so we skip the lookup and thread
    // campaign_id as null on the widget.
    //
    // Both missing-campaign and out-of-scope-campaign return plain
    // text only (no widget). Rationale: without a resolved campaign
    // there is no destructive target to anchor a ConfirmImport card
    // to, and `confirmImportWidgetKey` rejects an invitees target
    // with `campaignId=null` at the formula level. Returning a
    // blocked widget with `campaign_id: null` would also fail
    // `validateConfirmImport`'s cross-field check on (target,
    // campaign_id). Surfacing this as text keeps any previously-
    // emitted ready ConfirmImport for a different campaign on the
    // dashboard untouched — that card is still a valid destructive
    // anchor, and superseding it with a no-op would be a worse UX.
    let campaignId: string | null = null;
    if (input.target === "invitees") {
      if (!input.campaign_id) {
        return {
          output: {
            error: "no_campaign_for_invitees",
            summary:
              "Cannot preview invitees import: campaign_id is required. Pick a campaign and re-run the preview.",
          },
        };
      }
      const camp = await prisma.campaign.findFirst({
        where: {
          AND: [ctx.campaignScope, { id: input.campaign_id }],
        },
        select: { id: true },
      });
      if (!camp) {
        return {
          output: {
            error: "campaign_not_found",
            id: input.campaign_id,
            summary: `Cannot preview invitees import: campaign ${input.campaign_id} is not visible under the current scope.`,
          },
        };
      }
      campaignId = camp.id;
    }

    // File-status gate. An ingest whose extraction never succeeded
    // has no text to plan against — short-circuit with a blocker so
    // the widget explains WHY instead of emitting zeroes.
    if (ingest.status !== "extracted" || !ingest.extractedText) {
      return emitEarlyBlockerWidget(ingest, filename, input.target, campaignId, [
        "file_not_extracted",
      ]);
    }

    // Column / total-row summary straight off the CSV parser. The
    // planner doesn't expose these — they're UI-only fields the
    // widget uses to tell the operator what shape of file they're
    // about to commit.
    const parsed = parseContactsText(ingest.extractedText);
    const columns = parsed.length > 0 ? Object.keys(parsed[0]!) : [];
    const totalRows = parsed.length;

    if (totalRows === 0) {
      // Parser found no data rows (header-only, all-blank, or the
      // text isn't CSV-shaped at all). No commit can be planned.
      return emitEarlyBlockerWidget(ingest, filename, input.target, campaignId, [
        "file_unstructured",
      ]);
    }

    // The preview pass. Same planner commit uses; same counters fall
    // out. Contacts path is createdBy-null here because preview
    // never writes — the real `createdBy` is stamped by commit_import
    // from `ctx.user.id`.
    const report: PlannerReport =
      input.target === "contacts"
        ? await runImport(
            { target: "contacts", text: ingest.extractedText, createdBy: null },
            "preview",
          )
        : await runImport(
            {
              target: "invitees",
              text: ingest.extractedText,
              campaignId: campaignId!,
            },
            "preview",
          );

    // Blockers for the preview → confirm gate. Ordering matters —
    // the widget renders them in array order, and `nothing_to_commit`
    // is the one case where the operator should see "everything's
    // fine, but there's nothing to write" rather than a recoverable
    // error.
    const blockers: string[] = [];
    if (report.willCreate === 0) {
      blockers.push("nothing_to_commit");
    }

    // Rollup for `expected` — the validator requires exactly
    // {newRows, existingSkipped, conflicts, invalid}. We fold
    // within-file dupes into `existingSkipped` because from the
    // operator's perspective both are "rows we won't create, please
    // fix the file or re-upload" — the distinction matters to the
    // write (and surfaces in commit_import's `result.duplicatesInFile`)
    // but would be extra noise on the preview card. `conflicts` is
    // always 0 here: the planner's dedupe is key-identity, not a
    // merge with field-level conflict detection.
    const expected = {
      newRows: report.willCreate,
      existingSkipped: report.duplicatesExisting + report.duplicatesWithin,
      conflicts: 0,
      invalid: report.invalid,
    };

    const state: "ready" | "blocked" = blockers.length > 0 ? "blocked" : "ready";

    const summaryLines: string[] = [];
    summaryLines.push(
      `Propose import for "${filename}" → ${input.target}${campaignId ? ` (campaign ${campaignId})` : ""}: ${totalRows} row${totalRows === 1 ? "" : "s"}.`,
    );
    summaryLines.push(
      `Would create ${expected.newRows}; skip ${expected.existingSkipped} existing/duplicate; reject ${expected.invalid} invalid.`,
    );
    if (report.capped) {
      summaryLines.push(
        `File exceeds the ${10_000} row cap — planner evaluated the first 10,000.`,
      );
    }
    if (blockers.length > 0) {
      summaryLines.push(`Blockers: ${blockers.join(", ")}.`);
    }
    summaryLines.push(
      `A ConfirmImport card has been rendered. The operator must click Confirm to actually commit — this tool does not write.`,
    );

    const props = {
      fileUploadId: ingest.fileUploadId,
      ingestId: ingest.id,
      filename,
      target: input.target,
      campaign_id: campaignId,
      columns,
      sampledRows: 0,
      totalRows,
      expected,
      blockers,
      state,
    };

    return {
      output: {
        ok: true,
        ingestId: ingest.id,
        target: input.target,
        campaign_id: campaignId,
        totalRows,
        expected,
        blockers,
        summary: summaryLines.join("\n"),
      },
      widget: {
        widgetKey: confirmImportWidgetKey(input.target, ingest.id, campaignId),
        kind: "confirm_import",
        slot: "action",
        props,
      },
    };
  },
};

// Build a blocked-state `confirm_import` widget for the early-exit
// paths that ran AFTER the campaign gate — `file_not_extracted` and
// `file_unstructured`. Both guarantee a resolved `campaignId` (a
// non-null string for invitees, null for contacts), so the widget key
// formula and the `validateConfirmImport` cross-field check on
// (target, campaign_id) both accept the payload.
//
// `no_campaign_for_invitees` does NOT route through here — it has
// no resolved campaign to key against, so the tool returns plain
// text only (see the campaign gate above).
function emitEarlyBlockerWidget(
  ingest: { id: string; fileUploadId: string },
  filename: string,
  target: CommitTarget,
  campaignId: string | null,
  blockers: string[],
): ToolResult {
  const props = {
    fileUploadId: ingest.fileUploadId,
    ingestId: ingest.id,
    filename,
    target,
    campaign_id: campaignId,
    columns: [] as string[],
    sampledRows: 0,
    totalRows: 0,
    expected: { newRows: 0, existingSkipped: 0, conflicts: 0, invalid: 0 },
    blockers,
    state: "blocked" as const,
  };
  return {
    output: {
      ok: false,
      ingestId: ingest.id,
      target,
      campaign_id: campaignId,
      blockers,
      summary: `Cannot preview import for "${filename}": ${blockers.join(", ")}.`,
    },
    widget: {
      widgetKey: confirmImportWidgetKey(target, ingest.id, campaignId),
      kind: "confirm_import",
      slot: "action",
      props,
    },
  };
}
