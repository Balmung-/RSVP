import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Badge } from "@/components/Badge";
import { getCurrentUser, hasRole } from "@/lib/auth";
import { listUsers } from "@/lib/users";

export const dynamic = "force-dynamic";

const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
const fmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });

const roleTone = { admin: "live", editor: "hold", viewer: "muted" } as const;

export default async function UsersPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!hasRole(me, "admin")) redirect("/");
  const users = await listUsers();

  return (
    <Shell
      title="Team"
      crumb={<span>{users.length} user{users.length === 1 ? "" : "s"}</span>}
      actions={<Link href="/users/new" className="btn-primary">Invite user</Link>}
    >
      <div className="panel rail overflow-hidden">
        <table>
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
              <th scope="col">Last login</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <Link href={`/users/${u.id}/edit`} className="font-medium text-ink-900 hover:underline">
                    {u.email}
                  </Link>
                </td>
                <td className="text-ink-600">{u.fullName ?? <span className="text-ink-300">—</span>}</td>
                <td>
                  <Badge tone={roleTone[u.role as keyof typeof roleTone] ?? "muted"}>{u.role}</Badge>
                </td>
                <td>
                  <Badge tone={u.active ? "live" : "muted"}>{u.active ? "active" : "disabled"}</Badge>
                </td>
                <td className="text-ink-600 tabular-nums text-xs">
                  {u.lastLoginAt ? fmt.format(u.lastLoginAt) : <span className="text-ink-300">never</span>}
                </td>
                <td className="text-right">
                  <Link href={`/users/${u.id}/edit`} className="btn-ghost !px-3 !py-1 text-xs">Edit</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
