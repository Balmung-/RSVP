import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Pagination } from "@/components/Pagination";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

export default async function Contacts({
  searchParams,
}: {
  searchParams: { page?: string; q?: string };
}) {
  if (!isAuthed()) redirect("/login");
  const page = Math.max(1, parseInt(searchParams.page ?? "1", 10) || 1);
  const q = (searchParams.q ?? "").trim();
  const where = q
    ? {
        OR: [
          { fullName: { contains: q, mode: "insensitive" as const } },
          { email: { contains: q, mode: "insensitive" as const } },
          { phoneE164: { contains: q } },
        ],
      }
    : {};
  const [total, rows] = await Promise.all([
    prisma.invitee.count({ where }),
    prisma.invitee.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { campaign: { select: { name: true } } },
    }),
  ]);

  const hrefFor = (p: number) => {
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    qs.set("page", String(p));
    return `/contacts?${qs.toString()}`;
  };

  return (
    <Shell title="Contacts" crumb={<span>Across all campaigns</span>}>
      <form method="get" className="mb-4">
        <label className="sr-only" htmlFor="contact-search">Search contacts</label>
        <input
          id="contact-search"
          name="q"
          defaultValue={q}
          placeholder="Search name, email, phone"
          className="field max-w-md"
        />
      </form>
      <div className="panel rail overflow-hidden">
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Phone</th>
              <th scope="col">Campaign</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id}>
                <td className="font-medium text-ink-900">{i.fullName}</td>
                <td className="text-ink-600">{i.email ?? <span className="text-ink-300">—</span>}</td>
                <td className="text-ink-600 tabular-nums">{i.phoneE164 ?? <span className="text-ink-300">—</span>}</td>
                <td className="text-ink-600">{i.campaign.name}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-16 text-center text-ink-400 text-sm">
                  {q ? "No matches." : "No contacts yet."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <Pagination page={page} pageSize={PAGE_SIZE} total={total} hrefFor={hrefFor} />
    </Shell>
  );
}
