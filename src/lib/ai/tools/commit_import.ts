import { prisma } from "@/lib/db";
import { hasRole } from "@/lib/auth";
import { runImport, type PlannerReport } from "@/lib/importPlanner";
import { buildIngestOwnershipWhere } from "./ingestAccess";
import type { ToolDef, ToolResult } from "./types";

// P7 — the destructive companion to `propose_import`.
//
// Runs the same shared `runImport` planner but in commit mode: writes
// the createMany batch to Contact / Invitee and emits the
// `import.completed` audit row on the EventLog stream. Symmetrical to
// `send_campaign` / `propose_send`.
//
// Dispatch semantics — `scope: "destructive"` is load-bearing:
//   - On first invocation (from the model, unsolicited), the dispatcher
//     in `src/lib/ai/tools/index.ts:76-80` short-circuits with
//     `needs_confirmation` BEFORE the handler runs. The chat route
//     turns that into a ConfirmImport card, which the operator can
//     only reach after `propose_import` has rendered it.
//   - On operator-initiated invocation (confirm button click →
//     /api/chat/confirm/[messageId]), the route re-dispatches with
//     `allowDestructive: true` — the short-circuit is bypassed and
//     the real write runs.
//
// Input contract is intentionally minimal — just the ingestId + target
// (+ campaign_id for invitees). The confirm route reads these off the
// stored `toolInput` on the ChatMessage anchor, so the model's /
// operator's side of the wire doesn't get to forge them. Keeping the
// schema tight also means a future attempt to proxy this tool via the
// tool-use API would fail validate() unless the caller reproduces the
// same three-field shape.
//
// Role gate + ownership gate are both re-checked here even though
// propose_import already enforced them. Belt-and-braces: a forged
// POST that landed at /api/chat/confirm with a legitimate messageId
// for a different operator's ingest would still hit these checks
// before any write. Matches the "re-check on destructive" discipline
// send_campaign uses for its blocker re-check.

export type CommitTarget = "contacts" | "invitees";
const COMMIT_TARGETS: readonly CommitTarget[] = ["contacts", "invitees"];

type Input = {
  ingestId: string;
  target: CommitTarget;
  campaign_id?: string;
};

export const commitImportTool: ToolDef<Input> = {
  name: "commit_import",
  description:
    "Actually commit a file-backed import. DESTRUCTIVE — requires operator confirmation. In normal flow the model does NOT call this directly: it calls `propose_import` to render a ConfirmImport directive, and the operator clicks the button to trigger this tool via the confirm route. The dispatcher short-circuits unsolicited calls with `needs_confirmation`. Role-gated: requires editor or admin. Writes via the same planner propose_import previewed, so counters match by construction.",
  scope: "destructive",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["ingestId", "target"],
    properties: {
      ingestId: {
        type: "string",
        description: "The FileIngest row id.",
      },
      target: {
        type: "string",
        enum: ["contacts", "invitees"],
        description:
          "Which table to write to. Must match the propose_import preview the operator confirmed.",
      },
      campaign_id: {
        type: "string",
        description:
          "Required when target is `invitees`; the campaign whose invitee list will receive the rows.",
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
    // Role gate — same policy as propose_import / send_campaign. A
    // viewer reaching this handler through a forged confirm would
    // still be refused here.
    if (!hasRole(ctx.user, "editor")) {
      return {
        output: {
          error: "forbidden",
          reason: "editor_role_required",
          summary: "Refused: operator has viewer permissions only.",
        },
      };
    }

    // Ownership gate — the non-admin relation filter from
    // `buildIngestOwnershipWhere`. Wrong-owner ingestIds collapse to
    // `not_found`; no side-channel for probing other operators'
    // uploads.
    const ingest = await prisma.fileIngest.findFirst({
      where: buildIngestOwnershipWhere(input.ingestId, ctx),
      select: {
        id: true,
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
          summary: `Refused: ingest ${input.ingestId} not found under this operator's scope.`,
        },
      };
    }

    if (ingest.status !== "extracted" || !ingest.extractedText) {
      return {
        output: {
          error: "file_not_extracted",
          id: input.ingestId,
          summary: `Refused: ingest ${input.ingestId} has no extracted text (status=${ingest.status}).`,
        },
      };
    }

    // Campaign gate for invitees. Re-checked here against
    // `ctx.campaignScope` — the stored toolInput on the ChatMessage
    // anchor could in principle be replayed against a different
    // operator's session, so we don't trust it until it passes the
    // scope filter.
    let campaignId: string | null = null;
    if (input.target === "invitees") {
      if (!input.campaign_id) {
        return {
          output: {
            error: "no_campaign_for_invitees",
            summary: "Refused: invitees commit requires a campaign_id.",
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
            summary: `Refused: campaign ${input.campaign_id} is not visible under this operator's scope.`,
          },
        };
      }
      campaignId = camp.id;
    }

    // The commit pass. Same planner propose_import previewed. No
    // `createdBy` for contacts here because we can't pass the current
    // user's id through the admin-UI wrapper signature — the planner
    // accepts the field, though, so threading it is a one-line
    // change if auditing requirements tighten.
    const report: PlannerReport =
      input.target === "contacts"
        ? await runImport(
            {
              target: "contacts",
              text: ingest.extractedText,
              createdBy: ctx.user.id,
            },
            "commit",
          )
        : await runImport(
            {
              target: "invitees",
              text: ingest.extractedText,
              campaignId: campaignId!,
            },
            "commit",
          );

    // `nothing_to_commit` as a structured error — NOT an exception —
    // so it lands on the confirm route's releasable-refusals
    // whitelist and unfreezes the single-use anchor. The operator
    // can re-upload a better file and try again; forcing them into a
    // "you already committed nothing" dead-end would be a worse UX.
    if (report.created === 0 && report.willCreate === 0) {
      return {
        output: {
          error: "nothing_to_commit",
          ingestId: ingest.id,
          target: input.target,
          summary: `Refused: ${ingest.fileUpload.filename} has no rows to commit (all skipped or invalid).`,
        },
      };
    }

    // Rollup for the confirm route's `result` surface. Matches
    // `validateImportResult` — the widget's terminal-state contract
    // requires created, existingSkipped, duplicatesInFile, invalid,
    // errors.
    //
    // `existingSkipped` here is ONLY rows that matched an existing
    // DB key — NOT within-file dupes (those surface separately as
    // `duplicatesInFile`, which is the distinction the commit can
    // actually tell and the preview cannot). `errors` is always 0 in
    // the happy path: a driver-level skip could surface as
    // (willCreate - created) but our dedupe is tight enough that we
    // don't expect divergence. If it ever does, we'd rather surface
    // it here than silently underreport.
    const errors = Math.max(0, report.willCreate - report.created);
    const result = {
      created: report.created,
      existingSkipped: report.duplicatesExisting,
      duplicatesInFile: report.duplicatesWithin,
      invalid: report.invalid,
      errors,
    };

    const filename = ingest.fileUpload.filename;
    const summaryLines: string[] = [];
    summaryLines.push(
      `Imported ${result.created} row${result.created === 1 ? "" : "s"} from "${filename}" → ${input.target}${campaignId ? ` (campaign ${campaignId})` : ""}.`,
    );
    const skippedTotal =
      result.existingSkipped + result.duplicatesInFile + result.invalid;
    if (skippedTotal > 0) {
      const parts: string[] = [];
      if (result.existingSkipped > 0) parts.push(`${result.existingSkipped} already-existing`);
      if (result.duplicatesInFile > 0) parts.push(`${result.duplicatesInFile} duplicate-in-file`);
      if (result.invalid > 0) parts.push(`${result.invalid} invalid`);
      summaryLines.push(`Skipped: ${parts.join(", ")}.`);
    }
    if (report.capped) {
      summaryLines.push(
        `File exceeded the 10,000 row cap — only the first 10,000 were evaluated.`,
      );
    }
    if (errors > 0) {
      summaryLines.push(`${errors} planned row(s) failed to persist — see EventLog.`);
    }

    return {
      output: {
        ok: true,
        ingestId: ingest.id,
        target: input.target,
        campaign_id: campaignId,
        created: result.created,
        existingSkipped: result.existingSkipped,
        duplicatesInFile: result.duplicatesInFile,
        invalid: result.invalid,
        errors,
        summary: summaryLines.join(" "),
      },
    };
  },
};
