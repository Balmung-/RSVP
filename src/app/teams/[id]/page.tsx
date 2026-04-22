import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Badge } from "@/components/Badge";
import { ConfirmButton } from "@/components/ConfirmButton";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole, requireRole } from "@/lib/auth";
import {
  updateTeam,
  addMember,
  removeMember,
  archiveTeam,
  unarchiveTeam,
  deleteTeamRecord,
  TEAM_ROLES,
  TEAM_ROLE_LABEL,
  teamsEnabled,
  type TeamRole,
} from "@/lib/teams";
import { logAction } from "@/lib/audit";
import { setFlash } from "@/lib/flash";
import { Field } from "@/components/Field";

export const dynamic = "force-dynamic";

async function save(teamId: string, formData: FormData) {
  "use server";
  await requireRole("admin");
  const res = await updateTeam(teamId, {
    name: String(formData.get("name") ?? ""),
    slug: String(formData.get("slug") ?? ""),
    color: String(formData.get("color") ?? ""),
    description: String(formData.get("description") ?? ""),
  });
  if (!res.ok) redirect(`/teams/${teamId}?e=${res.reason}`);
  await logAction({ kind: "team.updated", refType: "team", refId: teamId });
  setFlash({ kind: "success", text: "Team updated" });
  redirect(`/teams/${teamId}`);
}

async function addMemberAction(teamId: string, formData: FormData) {
  "use server";
  await requireRole("admin");
  const userId = String(formData.get("userId"));
  const roleRaw = String(formData.get("role") ?? "member");
  const role: TeamRole = (TEAM_ROLES as readonly string[]).includes(roleRaw) ? (roleRaw as TeamRole) : "member";
  if (!userId) redirect(`/teams/${teamId}`);
  await addMember(teamId, userId, role);
  await logAction({ kind: "team.member_added", refType: "team", refId: teamId, data: { userId, role } });
  redirect(`/teams/${teamId}`);
}

async function removeMemberAction(teamId: string, formData: FormData) {
  "use server";
  await requireRole("admin");
  const userId = String(formData.get("userId"));
  await removeMember(teamId, userId);
  await logAction({ kind: "team.member_removed", refType: "team", refId: teamId, data: { userId } });
  redirect(`/teams/${teamId}`);
}

async function archive(teamId: string, _fd: FormData) {
  "use server";
  await requireRole("admin");
  await archiveTeam(teamId);
  await logAction({ kind: "team.archived", refType: "team", refId: teamId });
  redirect(`/teams`);
}
async function unarchive(teamId: string, _fd: FormData) {
  "use server";
  await requireRole("admin");
  await unarchiveTeam(teamId);
  await logAction({ kind: "team.unarchived", refType: "team", refId: teamId });
  redirect(`/teams/${teamId}`);
}
async function remove(teamId: string, _fd: FormData) {
  "use server";
  await requireRole("admin");
  await deleteTeamRecord(teamId);
  await logAction({ kind: "team.deleted", refType: "team", refId: teamId });
  setFlash({ kind: "warn", text: "Team deleted" });
  redirect(`/teams`);
}

const ERROR_MSG: Record<string, string> = {
  missing_name: "Name is required.",
  duplicate: "Another team has that slug.",
  invalid_slug: "Slug must be lowercase letters, numbers, and hyphens.",
  not_found: "Team not found.",
};

export default async function TeamPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { e?: string };
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!hasRole(me, "admin")) redirect("/");
  if (!teamsEnabled()) notFound();

  const [team, allUsers] = await Promise.all([
    prisma.team.findUnique({
      where: { id: params.id },
      include: {
        memberships: { include: { user: true }, orderBy: [{ role: "asc" }, { createdAt: "asc" }] },
        _count: { select: { campaigns: true } },
      },
    }),
    prisma.user.findMany({
      where: { active: true },
      select: { id: true, email: true, fullName: true },
      orderBy: { email: "asc" },
    }),
  ]);
  if (!team) notFound();

  const memberIds = new Set(team.memberships.map((m) => m.userId));
  const addable = allUsers.filter((u) => !memberIds.has(u.id));
  const error = searchParams.e ? ERROR_MSG[searchParams.e] : null;

  const boundSave = save.bind(null, team.id);
  const boundAdd = addMemberAction.bind(null, team.id);
  const boundRemove = removeMemberAction.bind(null, team.id);
  const boundArchive = archive.bind(null, team.id);
  const boundUnarchive = unarchive.bind(null, team.id);
  const boundDelete = remove.bind(null, team.id);

  return (
    <Shell
      title={team.name}
      crumb={
        <span>
          <Link href="/teams" className="hover:text-ink-900 transition-colors">Teams</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span className="truncate">{team.name}</span>
        </span>
      }
    >
      {team.archivedAt ? (
        <div className="rounded-xl bg-signal-hold/10 border border-signal-hold/30 text-signal-hold px-4 py-3 mb-6 max-w-3xl flex items-center justify-between">
          <span className="text-body">Archived. Hidden from new campaign assignments.</span>
          <form action={boundUnarchive}>
            <button className="btn btn-soft text-mini">Unarchive</button>
          </form>
        </div>
      ) : null}
      {error ? <p role="alert" className="max-w-3xl text-body text-signal-fail mb-6">{error}</p> : null}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-10 max-w-5xl">
        <section>
          <h2 className="text-sub text-ink-900 mb-3">Settings</h2>
          <form action={boundSave} className="panel p-6 grid grid-cols-2 gap-5">
            <Field label="Name" className="col-span-2">
              <input name="name" className="field" required maxLength={100} defaultValue={team.name} />
            </Field>
            <Field label="Slug">
              <input
                name="slug"
                className="field font-mono"
                pattern="^[a-z0-9-]{1,50}$"
                defaultValue={team.slug}
              />
            </Field>
            <Field label="Accent">
              <input name="color" className="field" pattern="^#[0-9A-Fa-f]{3,8}$" defaultValue={team.color ?? ""} />
            </Field>
            <Field label="Description" className="col-span-2">
              <textarea name="description" rows={2} className="field" maxLength={500} defaultValue={team.description ?? ""} />
            </Field>
            <div className="col-span-2 flex items-center justify-end">
              <button className="btn btn-primary">Save</button>
            </div>
          </form>
          <div className="mt-3 flex items-center gap-2">
            {team.archivedAt ? null : (
              <form action={boundArchive}>
                <ConfirmButton tone="default" prompt={`Archive ${team.name}?`}>Archive</ConfirmButton>
              </form>
            )}
            <form action={boundDelete}>
              <ConfirmButton prompt={`Delete ${team.name}? Campaign links are nulled to office-wide.`}>
                Delete
              </ConfirmButton>
            </form>
          </div>
        </section>

        <section>
          <h2 className="text-sub text-ink-900 mb-3">Members</h2>
          <ul className="panel divide-y divide-ink-100 overflow-hidden">
            {team.memberships.length === 0 ? (
              <li className="px-5 py-6 text-body text-ink-400 text-center">No members yet.</li>
            ) : (
              team.memberships.map((m) => (
                <li key={m.id} className="flex items-center justify-between px-5 py-3">
                  <div className="min-w-0">
                    <div className="text-body text-ink-900">{m.user.email}</div>
                    {m.user.fullName ? (
                      <div className="text-mini text-ink-400 mt-0.5">{m.user.fullName}</div>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <Badge tone={m.role === "lead" ? "live" : m.role === "guest" ? "muted" : "wait"}>
                      {TEAM_ROLE_LABEL[m.role as TeamRole] ?? m.role}
                    </Badge>
                    <form action={boundRemove}>
                      <input type="hidden" name="userId" value={m.userId} />
                      <ConfirmButton prompt={`Remove ${m.user.email} from ${team.name}?`}>Remove</ConfirmButton>
                    </form>
                  </div>
                </li>
              ))
            )}
          </ul>

          {addable.length > 0 ? (
            <form action={boundAdd} className="panel mt-4 p-5 grid grid-cols-[1fr_auto_auto] gap-3">
              <Field label="User" className="">
                <select name="userId" className="field" required>
                  {addable.map((u) => (
                    <option key={u.id} value={u.id}>{u.fullName ? `${u.fullName} — ${u.email}` : u.email}</option>
                  ))}
                </select>
              </Field>
              <Field label="Role">
                <select name="role" className="field" defaultValue="member">
                  {TEAM_ROLES.map((r) => (
                    <option key={r} value={r}>{TEAM_ROLE_LABEL[r]}</option>
                  ))}
                </select>
              </Field>
              <div className="flex items-end">
                <button className="btn btn-primary">Add</button>
              </div>
            </form>
          ) : null}
        </section>
      </div>
    </Shell>
  );
}
