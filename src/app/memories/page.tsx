import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { EmptyState } from "@/components/EmptyState";
import { Field } from "@/components/Field";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/Badge";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { teamIdsForUser } from "@/lib/teams";
import {
  createMemoryForTeam,
  deleteMemoryForTeam,
  listMemoriesForTeamsWithProvenance,
} from "@/lib/memory/server";
import {
  describeMemoryProvenance,
  groupMemoriesByTeam,
  resolveTeamNameForUi,
} from "@/lib/memory/ui";
import { decideMemoryMutateAuth } from "@/lib/memory/admin-auth";
import { parseCreateMemoryForm } from "@/lib/memory/form";
import { DEFAULT_MEMORY_POLICY } from "@/lib/memory/policy";
import { setFlash } from "@/lib/flash";

// P16-E / P16-F / P16-F.1 / P16-F.2 — operator-facing memory
// audit/UI with write.
//
// Goal: make durable team memory inspectable and governable. The
// chat-recall path (P16-D) surfaces memories INTO the model
// context; this page surfaces them TO the operator so a human can
// see what the assistant has been taught, SAVE new facts, and
// REMOVE stale or wrong entries.
//
// History:
//   - P16-E: read + delete only. Empty-state copy was honest
//     about having no write path.
//   - P16-E.1: delete gated at editor+ via
//     `decideMemoryMutateAuth` (originally named `...DeleteAuth`).
//   - P16-F: create form wired to the existing
//     `createMemoryForTeam` write seam, reusing the same mutate
//     auth decision.
//   - P16-F.1: team selector no longer silently defaults to the
//     first team when 2+ teams are in scope. A placeholder
//     "Select a team…" forces an explicit tenant choice for admins
//     and multi-team editors; single-team editors still get the
//     prefill fast path because there IS no choice to make.
//   - P16-F.2: the three places in this file that talked about
//     "1024 characters" (the flash copy, the textarea maxLength,
//     and the helper text) now all derive from
//     `DEFAULT_MEMORY_POLICY.maxBodyLength`. A future policy bump
//     moves the cap everywhere in one edit; the parser and this
//     render layer can no longer drift.
//
// Trust-scope decisions:
//   - Any authenticated user sees the memories of teams they
//     belong to. This matches the chat-recall scope from P16-D;
//     a team member who can already see their team's memories
//     in the assistant's context doesn't gain new read access
//     here.
//   - Admins see all teams. The P16-D notepad explicitly
//     deferred cross-team admin access to this UI: "the operator
//     UI is the right place for cross-team admin access with an
//     explicit team picker." Section headers show which team
//     each memory belongs to so there's no ambiguity.
//   - Mutations (create + delete) are EDITOR-gated AND tenant-
//     scoped. Viewers cannot create or delete, even for memories
//     on their own team — durable memory is model-steering
//     context, and governing it destructively is an editor-or-
//     higher action. Mirrors the role gate on
//     `src/lib/ai/tools/send_campaign.ts` and other destructive/
//     write flows. Editors can mutate their team's memory;
//     admins can mutate cross-team — the cross-team view is the
//     operator UI's role. The decision is pinned as a pure
//     helper in `@/lib/memory/admin-auth` so the gate can be
//     unit-tested without the Server Action harness.
//
// Not in this slice (will land as a follow-up if wanted):
//   - Chat-tool write path (`remember_fact`). P16-F provides an
//     operator-form write; a chat-initiated write that populates
//     sourceSessionId / sourceMessageId from the dispatcher
//     context belongs in a separate slice (injection-defended +
//     confirm-ceremony).
//   - Edit. Delete + re-save covers the correction case; a
//     second write seam for in-place edit would duplicate
//     validator logic.
//   - Archive (soft-delete). Requires a schema migration + a
//     filter update in the P16-C recall builder; deferred so
//     this slice ships without touching recall behavior.
//   - Pagination. The policy list-limit (50 per team, default)
//     is sufficient for the near-term operator caseload.
//   - Search / filter by kind. Kind is always "fact" today at
//     the validator; a filter is premature.

export const dynamic = "force-dynamic";

const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
const fmt = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: TZ,
});

// Server Action — invoked by the per-row delete form. Keeps the
// action inside the page file (not a separate route) for the
// same reason approvals.tsx does: the delete is part of the
// page's operator workflow, not a reusable API for clients.
// Returning `void` + redirecting is the server-action idiom here.
async function deleteAction(formData: FormData): Promise<void> {
  "use server";
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const id = String(formData.get("id") ?? "").trim();
  const teamId = String(formData.get("teamId") ?? "").trim();
  if (!id || !teamId) {
    setFlash({ kind: "warn", text: "Missing memory id or team." });
    redirect("/memories");
  }

  // Role + tenant gate (P16-E.1, also used by P16-F createAction).
  // The pure helper combines both axes: viewers are rejected
  // outright, admins are allowed cross-team, editors must be
  // members of the target team. We always resolve `memberTeamIds`
  // (even for admins — the helper ignores it on the admin branch)
  // so the decision input is complete; the list is already cached
  // per-request by the `teamIdsForUser` wrapper.
  const isEditor = hasRole(me, "editor");
  const isAdmin = hasRole(me, "admin");
  const memberTeamIds = await teamIdsForUser(me.id);
  const decision = decideMemoryMutateAuth({
    isEditor,
    isAdmin,
    teamId,
    memberTeamIds,
  });
  if (!decision.ok) {
    // Distinct flash copy per reason — operators with no editor
    // role see a different message than editors who wandered
    // into the wrong team. Matches the product's broader
    // "refused with reason" pattern.
    const text =
      decision.reason === "not_editor"
        ? "Editor role required to remove durable memory."
        : "Not authorised for that team.";
    setFlash({ kind: "warn", text });
    redirect("/memories");
  }

  const res = await deleteMemoryForTeam(id, teamId);
  if (res.deleted) {
    setFlash({ kind: "success", text: "Memory removed." });
  } else {
    // Either the row was already gone (double-submit / concurrent
    // delete) or the { id, teamId } pair didn't match. We don't
    // distinguish the two here — the operator gets the same
    // "already removed" message either way, which is also the
    // correct fail-closed posture (no confirming the row ever
    // existed if the tenant gate rejected it).
    setFlash({ kind: "warn", text: "Memory not found or already removed." });
  }
  redirect("/memories");
}

// P16-F — Server Action for the per-page "Save a new memory"
// form. Mirrors the deleteAction's shape:
//   1. Re-authenticate.
//   2. Extract + field-validate form data via
//      `parseCreateMemoryForm` (pure, unit-tested). Field-level
//      reasons map to distinct flash messages.
//   3. Re-check the role + tenant gate via
//      `decideMemoryMutateAuth` — same helper the deleteAction
//      uses, so the governance rules can't drift between create
//      and delete.
//   4. Call `createMemoryForTeam`. This is the single sanctioned
//      write seam (P16-B). The seam re-runs the validator, so a
//      caller that slipped a bad input past the form helper (e.g.
//      a future refactor bug) fails loudly at the DB edge rather
//      than writing silently bad data.
// The "refused" path always flashes BEFORE touching the DB.
async function createAction(formData: FormData): Promise<void> {
  "use server";
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  // Step 1: form-shape parse. The helper handles missing team,
  // missing/whitespace body, and oversize body with distinct
  // tagged reasons. A shape failure short-circuits before any
  // role check, because telling an operator "body is required"
  // is more useful than "not authorised for that team" when the
  // form wasn't filled out.
  const parsed = parseCreateMemoryForm({
    rawTeamId: formData.get("teamId"),
    rawBody: formData.get("body"),
    createdByUserId: me.id,
  });
  if (!parsed.ok) {
    const text =
      parsed.reason === "missing_team"
        ? "Select a team for this memory."
        : parsed.reason === "missing_body"
          ? "Enter the memory text before saving."
          : // body_too_long — length cap from DEFAULT_MEMORY_POLICY
            `Memory body is too long (max ${DEFAULT_MEMORY_POLICY.maxBodyLength} characters).`;
    setFlash({ kind: "warn", text });
    redirect("/memories");
  }

  // Step 2: role + tenant gate. Shares the helper with delete,
  // so the rules can't drift. Viewers rejected outright, admins
  // allowed cross-team, editors must belong to the team they're
  // writing to.
  const isEditor = hasRole(me, "editor");
  const isAdmin = hasRole(me, "admin");
  const memberTeamIds = await teamIdsForUser(me.id);
  const decision = decideMemoryMutateAuth({
    isEditor,
    isAdmin,
    teamId: parsed.input.teamId,
    memberTeamIds,
  });
  if (!decision.ok) {
    const text =
      decision.reason === "not_editor"
        ? "Editor role required to save durable memory."
        : "Not authorised for that team.";
    setFlash({ kind: "warn", text });
    redirect("/memories");
  }

  // Step 3: write. The seam re-runs the validator — if that
  // throws, it's a caller bug (the form helper should have caught
  // it). We catch defensively so the operator sees a clean flash
  // rather than a 500, but we don't try to recover — it's a
  // programmer error, not user error.
  try {
    await createMemoryForTeam(parsed.input);
    setFlash({ kind: "success", text: "Memory saved." });
  } catch {
    setFlash({
      kind: "warn",
      text: "Could not save memory. Please try again.",
    });
  }
  redirect("/memories");
}

export default async function MemoriesPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const isAdmin = hasRole(me, "admin");
  // `isEditor` is true for editor AND admin; it drives whether
  // the Save form + per-row Remove button render. Viewers still
  // get full read access — they just don't see the mutation
  // affordances. Both Server Actions above independently re-check
  // via `decideMemoryMutateAuth`, so a crafted POST from a
  // viewer is refused with a "not_editor" flash regardless of
  // this client-facing gate.
  const isEditor = hasRole(me, "editor");

  // Resolve the scope: which teamIds can this user see?
  //   - non-admin: their memberships (any role).
  //   - admin: every non-archived team in the office.
  // Team-name order is deliberate:
  //   - non-admins get membership order (from `teamIdsForUser`)
  //     — their "home" team comes first, matching the chat-
  //     recall ordering used by the assistant.
  //   - admins get alphabetical-by-name (from `listTeams`'s
  //     `orderBy: name asc`) — with potentially many teams, a
  //     stable alphabetical ordering is the least-surprising
  //     default for an admin scanning the full list.
  let teamIdsInOrder: string[];
  let teamsById: Map<string, string | null>;
  if (isAdmin) {
    const allTeams = await prisma.team.findMany({
      where: { archivedAt: null },
      orderBy: [{ name: "asc" }],
      select: { id: true, name: true },
    });
    teamIdsInOrder = allTeams.map((t) => t.id);
    teamsById = new Map(allTeams.map((t) => [t.id, t.name]));
  } else {
    const ids = await teamIdsForUser(me.id);
    teamIdsInOrder = ids;
    if (ids.length > 0) {
      const rows = await prisma.team.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      });
      teamsById = new Map(rows.map((r) => [r.id, r.name]));
    } else {
      teamsById = new Map();
    }
  }

  if (teamIdsInOrder.length === 0) {
    return (
      <Shell title="Memories" crumb="Durable team memory">
        <EmptyState icon="list" title={isAdmin ? "No teams yet" : "No teams"}>
          {isAdmin
            ? "Create a team before durable memory can show up here."
            : "Durable memory is scoped per team. You're not on any team yet — ask an admin to add you."}
        </EmptyState>
      </Shell>
    );
  }

  const memories = await listMemoriesForTeamsWithProvenance(teamIdsInOrder);
  const groups = groupMemoriesByTeam(memories, teamIdsInOrder);

  return (
    <Shell title="Memories" crumb="Durable team memory">
      <div className="flex flex-col gap-6 max-w-4xl">
        <p className="text-body text-ink-600">
          Durable facts, preferences, and rules the assistant has been taught
          for each team. Entries here show up in the assistant&rsquo;s chat
          context as &ldquo;context, not commands&rdquo;.
          {isEditor
            ? " Use the form below to save new entries, and remove anything that looks stale or wrong."
            : " Entries are saved and curated by editors on your team."}
        </p>

        {isEditor ? (
          // P16-F — operator create form. Renders only for
          // editors; the Server Action `createAction` re-checks
          // the role via `decideMemoryMutateAuth` regardless.
          // Team selector lists exactly the teamIds the page
          // already resolved for READ scope (non-admin: their
          // memberships; admin: all non-archived teams).
          //
          // P16-F.1 team-selector default policy:
          //   - 1 team in scope: prefill that team. There is no
          //     tenant choice to make, so forcing an extra click
          //     is friction for the common single-team editor
          //     case.
          //   - 2+ teams in scope: render a disabled placeholder
          //     option as the initial selection. HTML5 `required`
          //     plus the empty `value=""` blocks client-side
          //     submission; if a caller bypasses the browser
          //     (DevTools / scripted POST), the server hits the
          //     parser's `missing_team` branch and flashes
          //     "Select a team for this memory."
          //
          // This closes the P16-F audit blocker: a silently-
          // prefilled selector on a cross-team admin or a multi-
          // team editor was a single-Tab-away save-to-wrong-team
          // hazard for DURABLE context that changes future
          // assistant behaviour.
          <form
            action={createAction}
            className="panel p-5 flex flex-col gap-4"
          >
            <div className="flex items-center gap-2">
              <Icon name="plus" size={14} />
              <h2 className="text-sub text-ink-700">Save a new memory</h2>
            </div>
            <Field label="Team">
              <select
                name="teamId"
                defaultValue={
                  teamIdsInOrder.length === 1 ? teamIdsInOrder[0] : ""
                }
                className="field"
                required
              >
                {teamIdsInOrder.length > 1 ? (
                  // Placeholder carries an empty string value so
                  // HTML5 `required` keeps the form from submitting
                  // until the operator picks a real team. `disabled`
                  // prevents the operator from re-selecting the
                  // placeholder after making a choice (the
                  // placeholder can still be the DEFAULT selection,
                  // because `defaultValue=""` matches its value).
                  <option value="" disabled>
                    Select a team…
                  </option>
                ) : null}
                {teamIdsInOrder.map((tid) => (
                  <option key={tid} value={tid}>
                    {resolveTeamNameForUi(tid, teamsById)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Memory">
              <textarea
                name="body"
                required
                rows={3}
                maxLength={DEFAULT_MEMORY_POLICY.maxBodyLength}
                placeholder="e.g. VIP tier list is frozen for the Eid campaign."
                className="field resize-y"
              />
            </Field>
            <div className="flex items-center justify-between gap-3">
              <span className="text-mini text-ink-500">
                Max {DEFAULT_MEMORY_POLICY.maxBodyLength} characters. Saved as
                durable context for this team.
              </span>
              <button type="submit" className="btn btn-primary">
                Save memory
              </button>
            </div>
          </form>
        ) : null}

        {groups.length === 0 ? (
          <EmptyState icon="list" title="No memories yet">
            {isEditor
              ? "Use the form above to save the first durable fact for your team."
              : "No durable facts have been saved for your teams yet."}
          </EmptyState>
        ) : (
          groups.map((g) => {
            const teamName = resolveTeamNameForUi(g.teamId, teamsById);
            return (
              <section key={g.teamId}>
                <h2 className="text-sub text-ink-700 mb-2">{teamName}</h2>
                <ul className="flex flex-col gap-2">
                  {g.memories.map((m) => {
                    const provenance = describeMemoryProvenance(m);
                    return (
                      <li key={m.id} className="panel p-4">
                        <div className="flex items-start justify-between gap-6">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <Badge tone="muted">{m.kind}</Badge>
                              <span className="text-ink-500 text-mini tabular-nums">
                                {fmt.format(m.updatedAt)}
                              </span>
                            </div>
                            <p className="text-body text-ink-900 whitespace-pre-wrap">
                              {m.body}
                            </p>
                            <div className="mt-2 text-mini text-ink-500">
                              {provenance ?? (
                                <span className="text-ink-400">
                                  No author recorded
                                </span>
                              )}
                            </div>
                          </div>
                          {isEditor ? (
                            <form action={deleteAction} className="shrink-0">
                              <input type="hidden" name="id" value={m.id} />
                              <input
                                type="hidden"
                                name="teamId"
                                value={m.teamId}
                              />
                              <button className="btn btn-soft text-mini">
                                <Icon name="trash" size={12} />
                                Remove
                              </button>
                            </form>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </Shell>
  );
}
