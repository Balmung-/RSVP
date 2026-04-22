import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { requirePlatformAdmin, setActiveTenant } from "@/lib/auth";
import { listTenants } from "@/lib/tenants";

export const dynamic = "force-dynamic";

async function openTenant(formData: FormData) {
  "use server";
  await requirePlatformAdmin();
  const tenantId = String(formData.get("tenantId") ?? "");
  if (tenantId) await setActiveTenant(tenantId);
  redirect("/users");
}

export default async function TenantsPage() {
  await requirePlatformAdmin();
  const tenants = await listTenants();

  return (
    <Shell
      title="Workspaces"
      crumb={`${tenants.length} workspace${tenants.length === 1 ? "" : "s"}`}
      actions={<Link href="/tenants/new" className="btn-primary">New workspace</Link>}
    >
      <div className="panel rail overflow-hidden">
        <table>
          <thead>
            <tr>
              <th scope="col">Workspace</th>
              <th scope="col">Slug</th>
              <th scope="col">Locale</th>
              <th scope="col" className="text-end">Members</th>
              <th scope="col" className="text-end">Sessions</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((tenant) => (
              <tr key={tenant.id}>
                <td className="font-medium text-ink-900">{tenant.name}</td>
                <td className="text-ink-500 font-mono text-mini">{tenant.slug}</td>
                <td className="text-ink-600 uppercase">{tenant.locale}</td>
                <td className="text-end tabular-nums">{tenant._count.memberships}</td>
                <td className="text-end tabular-nums">{tenant._count.sessions}</td>
                <td className="text-right">
                  <form action={openTenant}>
                    <input type="hidden" name="tenantId" value={tenant.id} />
                    <button className="btn-ghost !px-3 !py-1 text-xs">Open workspace</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
