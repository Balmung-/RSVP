import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Pagination } from "@/components/Pagination";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole } from "@/lib/auth";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;
const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
const fmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });

export default async function EventsPage({
  searchParams,
}: {
  searchParams: { page?: string; kind?: string; actor?: string };
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!hasRole(me, "admin")) redirect("/");

  const page = Math.max(1, parseInt(searchParams.page ?? "1", 10) || 1);
  const kindFilter = (searchParams.kind ?? "").trim();
  const actorFilter = (searchParams.actor ?? "").trim();

  const where = {
    ...(kindFilter ? { kind: { contains: kindFilter } } : {}),
    ...(actorFilter
      ? actorFilter === "system"
        ? { actorId: null }
        : { actor: { email: { contains: actorFilter, mode: "insensitive" as const } } }
      : {}),
  };

  const [total, rows, kinds] = await Promise.all([
    prisma.eventLog.count({ where }),
    prisma.eventLog.findMany({
      where,
      include: { actor: { select: { email: true, fullName: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    // Top kinds by volume, for the filter chip row.
    prisma.eventLog.groupBy({
      by: ["kind"],
      _count: { _all: true },
      orderBy: { _count: { kind: "desc" } },
      take: 8,
    }),
  ]);

  const hrefFor = (p: number) => {
    const qs = new URLSearchParams();
    if (kindFilter) qs.set("kind", kindFilter);
    if (actorFilter) qs.set("actor", actorFilter);
    qs.set("page", String(p));
    return `/events?${qs.toString()}`;
  };

  return (
    <Shell
      title="Events"
      crumb={
        <span>
          Audit log · {total.toLocaleString()} entries
        </span>
      }
    >
      <form method="get" className="flex flex-wrap items-end gap-3 mb-4">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-ink-400">Kind</span>
          <input
            name="kind"
            className="field max-w-[14rem]"
            defaultValue={kindFilter}
            placeholder="e.g. rsvp.submitted"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-ink-400">Actor</span>
          <input
            name="actor"
            className="field max-w-[14rem]"
            defaultValue={actorFilter}
            placeholder="email or 'system'"
          />
        </label>
        <button className="btn-ghost mb-0.5">Filter</button>
        {kindFilter || actorFilter ? (
          <Link href="/events" className="btn-ghost mb-0.5">Clear</Link>
        ) : null}
      </form>

      {kinds.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 mb-6 text-xs">
          {kinds.map((k) => {
            const qs = new URLSearchParams();
            qs.set("kind", k.kind);
            if (actorFilter) qs.set("actor", actorFilter);
            return (
              <Link
                key={k.kind}
                href={`/events?${qs.toString()}`}
                className={`rounded-full px-3 py-1 ${
                  kindFilter === k.kind
                    ? "bg-ink-900 text-ink-0"
                    : "bg-ink-100 text-ink-600 hover:bg-ink-200"
                }`}
              >
                {k.kind} <span className="opacity-60">· {k._count._all}</span>
              </Link>
            );
          })}
        </div>
      ) : null}

      <div className="panel rail overflow-hidden">
        <table>
          <thead>
            <tr>
              <th scope="col" className="w-44">When</th>
              <th scope="col" className="w-56">Kind</th>
              <th scope="col" className="w-48">Actor</th>
              <th scope="col" className="w-36">Ref</th>
              <th scope="col">Data</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={5} className="py-16 text-center text-ink-400 text-sm">No events match.</td></tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id}>
                  <td className="text-ink-600 tabular-nums text-xs">{fmt.format(r.createdAt)}</td>
                  <td className="font-mono text-xs text-ink-900">{r.kind}</td>
                  <td className="text-ink-600 text-xs">
                    {r.actor ? (
                      <span>{r.actor.email}</span>
                    ) : (
                      <span className="text-ink-400">system</span>
                    )}
                  </td>
                  <td className="text-ink-500 text-xs font-mono">
                    {r.refType ? (
                      <span title={r.refId ?? ""}>
                        {r.refType}
                        {r.refId ? <span className="text-ink-300">·{r.refId.slice(0, 6)}</span> : null}
                      </span>
                    ) : <span className="text-ink-300">—</span>}
                  </td>
                  <td className="text-ink-500 text-xs font-mono truncate max-w-[40ch]">
                    {r.data ?? <span className="text-ink-300">—</span>}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={page} pageSize={PAGE_SIZE} total={total} hrefFor={hrefFor} />
    </Shell>
  );
}
