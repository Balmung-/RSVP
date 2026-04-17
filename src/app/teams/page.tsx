import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { Shell } from "@/components/Shell";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { listTeams, teamsEnabled } from "@/lib/teams";

export const dynamic = "force-dynamic";

export default async function TeamsPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!hasRole(me, "admin")) redirect("/");
  if (!teamsEnabled()) notFound();

  const teams = await listTeams();

  return (
    <Shell
      title="Teams"
      crumb="Org units"
      actions={
        <Link href="/teams/new" className="btn btn-primary">
          <Icon name="plus" size={14} />
          New team
        </Link>
      }
    >
      {teams.length === 0 ? (
        <EmptyState
          icon="users"
          title="No teams yet"
          action={{ label: "Create the first team", href: "/teams/new" }}
        >
          Teams group people and campaigns into desks (Royal Protocol, Media, International Relations).
          Assigning a team to a campaign keeps the right people focused and keeps cross-desk work tidy.
        </EmptyState>
      ) : (
        <div className="panel rail overflow-hidden max-w-4xl">
          <table>
            <thead>
              <tr>
                <th scope="col">Team</th>
                <th scope="col">Slug</th>
                <th scope="col" className="text-end">Members</th>
                <th scope="col" className="text-end">Campaigns</th>
              </tr>
            </thead>
            <tbody>
              {teams.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link
                      href={`/teams/${t.id}`}
                      className="inline-flex items-center gap-3 font-medium text-ink-900 hover:underline"
                    >
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: t.color ?? "#8e8e8a" }}
                        aria-hidden
                      />
                      {t.name}
                    </Link>
                    {t.description ? (
                      <div className="text-mini text-ink-400 mt-0.5">{t.description}</div>
                    ) : null}
                  </td>
                  <td className="text-ink-500 font-mono text-mini">{t.slug}</td>
                  <td className="text-end tabular-nums">{t._count.memberships}</td>
                  <td className="text-end tabular-nums">{t._count.campaigns}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
