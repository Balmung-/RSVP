import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { prisma } from "@/lib/db";
import { isAuthed, requireRole } from "@/lib/auth";
import { findDuplicates } from "@/lib/campaigns";

export const dynamic = "force-dynamic";

async function removeInvitee(formData: FormData) {
  "use server";
  await requireRole("editor");
  const id = String(formData.get("id"));
  const campaignId = String(formData.get("campaignId"));
  // deleteMany scoped by campaignId — defends against spoofed id from another campaign.
  await prisma.invitee.deleteMany({ where: { id, campaignId } });
  redirect(`/campaigns/${campaignId}/duplicates`);
}

export default async function DuplicatesPage({ params }: { params: { id: string } }) {
  if (!(await isAuthed())) redirect("/login");
  const c = await prisma.campaign.findUnique({ where: { id: params.id } });
  if (!c) notFound();
  const groups = await findDuplicates(c.id);

  return (
    <Shell
      title="Duplicates"
      crumb={
        <span>
          <Link href="/campaigns" className="hover:underline">Campaigns</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <Link href={`/campaigns/${c.id}`} className="hover:underline">{c.name}</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>Duplicates</span>
        </span>
      }
    >
      {groups.length === 0 ? (
        <div className="panel p-16 text-center text-ink-500">
          <p className="text-sm">No duplicates detected.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4 max-w-4xl">
          {groups.map((g, idx) => (
            <div key={idx} className="panel p-6">
              <div className="text-xs uppercase tracking-wider text-ink-400 mb-4">Match on {g.reason}</div>
              <div className="flex flex-col divide-y divide-ink-100">
                {g.invitees.map((i) => (
                  <div key={i.id} className="flex items-center justify-between py-3">
                    <div>
                      <div className="font-medium text-ink-900">{i.fullName}</div>
                      <div className="text-xs text-ink-400 mt-0.5 flex gap-2">
                        {i.email ? <span>{i.email}</span> : null}
                        {i.email && i.phoneE164 ? <span className="text-ink-300">·</span> : null}
                        {i.phoneE164 ? <span>{i.phoneE164}</span> : null}
                        {i.organization ? (
                          <>
                            <span className="text-ink-300">·</span>
                            <span>{i.organization}</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                    <form action={removeInvitee}>
                      <input type="hidden" name="id" value={i.id} />
                      <input type="hidden" name="campaignId" value={c.id} />
                      <button className="btn-danger !px-3 !py-1 text-xs">Remove</button>
                    </form>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}
