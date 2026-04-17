import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Contacts() {
  if (!isAuthed()) redirect("/login");
  const top = await prisma.invitee.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { campaign: { select: { name: true } } },
  });
  return (
    <Shell title="Contacts" crumb={<span>Across all campaigns</span>}>
      <div className="panel rail overflow-hidden">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Campaign</th>
            </tr>
          </thead>
          <tbody>
            {top.map((i) => (
              <tr key={i.id}>
                <td className="font-medium text-ink-900">{i.fullName}</td>
                <td className="text-ink-600">{i.email ?? <span className="text-ink-300">—</span>}</td>
                <td className="text-ink-600 tabular-nums">{i.phoneE164 ?? <span className="text-ink-300">—</span>}</td>
                <td className="text-ink-600">{i.campaign.name}</td>
              </tr>
            ))}
            {top.length === 0 ? (
              <tr><td colSpan={4} className="py-16 text-center text-ink-400 text-sm">No contacts yet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
