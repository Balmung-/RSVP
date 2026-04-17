import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { Shell } from "@/components/Shell";
import { getCurrentUser, hasRole, requireRole } from "@/lib/auth";
import { createTeam, teamsEnabled } from "@/lib/teams";
import { logAction } from "@/lib/audit";
import { setFlash } from "@/lib/flash";

export const dynamic = "force-dynamic";

const ERROR_MSG: Record<string, string> = {
  missing_name: "Name is required.",
  duplicate: "A team with that slug already exists.",
  invalid_slug: "Slug must be lowercase letters, numbers, and hyphens.",
};

async function create(formData: FormData) {
  "use server";
  await requireRole("admin");
  const res = await createTeam({
    name: String(formData.get("name") ?? ""),
    slug: String(formData.get("slug") ?? ""),
    color: String(formData.get("color") ?? ""),
    description: String(formData.get("description") ?? ""),
  });
  if (!res.ok) redirect(`/teams/new?e=${res.reason}`);
  await logAction({ kind: "team.created", refType: "team", refId: res.teamId });
  setFlash({ kind: "success", text: "Team created" });
  redirect(`/teams/${res.teamId}`);
}

export default async function NewTeam({ searchParams }: { searchParams: { e?: string } }) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!hasRole(me, "admin")) redirect("/");
  if (!teamsEnabled()) notFound();

  const error = searchParams.e ? ERROR_MSG[searchParams.e] : null;

  return (
    <Shell
      title="New team"
      crumb={
        <span>
          <Link href="/teams" className="hover:text-ink-900 transition-colors">Teams</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>New</span>
        </span>
      }
    >
      <form action={create} className="panel p-10 max-w-2xl grid grid-cols-2 gap-6">
        {error ? <p role="alert" className="col-span-2 text-body text-signal-fail">{error}</p> : null}
        <Field label="Name" className="col-span-2">
          <input name="name" className="field" required maxLength={100} placeholder="Royal Protocol" />
        </Field>
        <Field label="Slug (lowercase, hyphens)">
          <input
            name="slug"
            className="field font-mono"
            pattern="^[a-z0-9-]{1,50}$"
            placeholder="royal-protocol"
          />
        </Field>
        <Field label="Accent color (hex)">
          <input name="color" className="field" pattern="^#[0-9A-Fa-f]{3,8}$" placeholder="#b91c1c" />
        </Field>
        <Field label="Description" className="col-span-2">
          <textarea name="description" rows={2} className="field" maxLength={500} />
        </Field>
        <div className="col-span-2 flex items-center justify-end gap-3 pt-2">
          <Link href="/teams" className="btn btn-ghost">Cancel</Link>
          <button className="btn btn-primary">Create team</button>
        </div>
      </form>
    </Shell>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-micro uppercase text-ink-400">{label}</span>
      {children}
    </label>
  );
}
