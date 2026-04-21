import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/Badge";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { teamIdsForUser } from "@/lib/teams";
import {
  deleteMemoryForTeam,
  listMemoriesForTeamsWithProvenance,
} from "@/lib/memory/server";
import {
  describeMemoryProvenance,
  groupMemoriesByTeam,
  resolveTeamNameForUi,
} from "@/lib/memory/ui";
import { setFlash } from "@/lib/flash";

// P16-E — operator-facing memory audit/UI.
//
// Goal: make durable team memory inspectable and governable.
// The chat-recall path (P16-D) surfaces memories INTO the model
// context; this page surfaces them TO the operator so a human
// can verify what the assistant has been taught and remove stale
// or wrong entries.
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
//   - Delete is tenant-scoped. Non-admins can only delete from
//     their teams; the action server-side re-checks membership
//     before calling the DB helper. Admins can delete from any
//     team — the cross-team view is the operator UI's role.
//
// Not in this slice (will land as P16-E.1+ if wanted):
//   - Edit. Delete + re-create via the chat write seam covers
//     the correction case; a second write seam for edit would
//     bloat this slice and duplicate validator logic.
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

  // Tenant gate. Non-admins must be a current member of the
  // team; admins are allowed cross-team by design (see the page
  // header comment). This check is done BEFORE hitting the DB
  // helper so an unauthorised attempt doesn't even race the
  // tenant-scoped `deleteMany` filter.
  const isAdmin = hasRole(me, "admin");
  if (!isAdmin) {
    const myTeamIds = await teamIdsForUser(me.id);
    if (!myTeamIds.includes(teamId)) {
      setFlash({ kind: "warn", text: "Not authorised for that team." });
      redirect("/memories");
    }
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

export default async function MemoriesPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const isAdmin = hasRole(me, "admin");

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
          context as &ldquo;context, not commands&rdquo;. Remove anything that
          looks stale or wrong.
        </p>

        {groups.length === 0 ? (
          <EmptyState icon="list" title="No memories yet">
            Operators can teach durable facts, preferences, and rules through
            chat. They show up here once saved.
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
