import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";
import { importInvitees } from "@/lib/campaigns";

export const dynamic = "force-dynamic";

async function runImport(formData: FormData) {
  "use server";
  if (!(await isAuthed())) redirect("/login");
  const id = String(formData.get("id"));
  const raw = String(formData.get("raw") ?? "");
  if (!raw.trim()) redirect(`/campaigns/${id}/import?e=empty`);
  const report = await importInvitees(id, raw);
  const qs = new URLSearchParams({
    created: String(report.created),
    dupW: String(report.duplicatesWithin),
    dupE: String(report.duplicatesExisting),
    bad: String(report.invalid),
    capped: String(report.capped),
  });
  redirect(`/campaigns/${id}?${qs.toString()}`);
}

const EXAMPLE = `full_name,title,organization,email,phone,locale,guests
H.E. Dr. Saad Al-Faisal,Minister,Ministry of Culture,saad@example.gov.sa,+966501234567,ar,2
Jane Harrison,,British Embassy,jane@ukmission.sa,+442071234567,en,1
محمد العتيبي,وكيل,وزارة السياحة,,+966551112223,ar,0`;

export default async function ImportPage({ params }: { params: { id: string } }) {
  if (!(await isAuthed())) redirect("/login");
  const c = await prisma.campaign.findUnique({ where: { id: params.id } });
  if (!c) notFound();

  return (
    <Shell
      title="Import contacts"
      crumb={
        <span>
          <Link href="/" className="hover:underline">Campaigns</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <Link href={`/campaigns/${c.id}`} className="hover:underline">{c.name}</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>Import</span>
        </span>
      }
    >
      <form action={runImport} className="panel p-10 max-w-4xl">
        <input type="hidden" name="id" value={c.id} />
        <div className="mb-6">
          <h2 className="text-base font-medium tracking-tight">Paste a CSV or TSV</h2>
          <p className="text-sm text-ink-500 mt-1">
            Required: <code className="text-ink-700">full_name</code> and at least one of{" "}
            <code className="text-ink-700">email</code> / <code className="text-ink-700">phone</code>.
            Duplicates (by email or phone) are detected automatically — within this paste and against
            existing invitees.
          </p>
        </div>
        <textarea
          name="raw"
          rows={14}
          defaultValue=""
          placeholder={EXAMPLE}
          className="field font-mono text-xs leading-relaxed"
          required
        />
        <div className="mt-6 flex items-center justify-between">
          <span className="text-xs text-ink-400">
            Supported columns: full_name, title, organization, email, phone, locale, guests, tags, notes
          </span>
          <div className="flex gap-3">
            <Link href={`/campaigns/${c.id}`} className="btn-ghost">Cancel</Link>
            <button className="btn-primary">Import</button>
          </div>
        </div>
      </form>
    </Shell>
  );
}
