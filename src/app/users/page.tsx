import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Badge } from "@/components/Badge";
import { getCurrentUser, hasPlatformRole, hasTenantRole } from "@/lib/auth";
import { listTenantUsers } from "@/lib/tenants";

export const dynamic = "force-dynamic";

const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
const fmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });

const roleTone = { owner: "live", admin: "hold", editor: "wait", viewer: "muted" } as const;

export default async function UsersPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!hasTenantRole(me, "admin")) redirect("/chat");
  if (!me.activeTenantId || !me.activeTenantName) redirect("/tenants");

  const members = await listTenantUsers(me.activeTenantId);
  const canCreateOwner = hasPlatformRole(me, "admin");

  return (
    <Shell
      title="People"
      crumb={<span>{me.activeTenantName} · {members.length} member{members.length === 1 ? "" : "s"}</span>}
      actions={<Link href="/users/new" className="btn-primary">Invite person</Link>}
    >
      <div className="panel rail overflow-hidden">
        <table>
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Name</th>
              <th scope="col">Workspace role</th>
              <th scope="col">Account</th>
              <th scope="col">Last login</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.userId}>
                <td>
                  <Link href={`/users/${m.userId}/edit`} className="font-medium text-ink-900 hover:underline">
                    {m.user.email}
                  </Link>
                </td>
                <td className="text-ink-600">{m.user.fullName ?? <span className="text-ink-300">—</span>}</td>
                <td>
                  <Badge tone={roleTone[m.role as keyof typeof roleTone] ?? "muted"}>{m.role}</Badge>
                </td>
                <td>
                  <Badge tone={m.user.active ? "live" : "muted"}>
                    {m.user.active ? "active" : "disabled"}
                  </Badge>
                </td>
                <td className="text-ink-600 tabular-nums text-xs">
                  {m.user.lastLoginAt ? fmt.format(m.user.lastLoginAt) : <span className="text-ink-300">never</span>}
                </td>
                <td className="text-right">
                  <Link href={`/users/${m.userId}/edit`} className="btn-ghost !px-3 !py-1 text-xs">Manage</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-400 mt-4">
        Workspace roles are tenant-scoped. Global platform admins can still open a workspace and assign an
        owner; workspace admins can invite editors and viewers only{canCreateOwner ? ", while platform admins can also assign owners" : ""}.
      </p>
    </Shell>
  );
}
