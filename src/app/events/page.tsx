import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Pagination } from "@/components/Pagination";
import { Icon } from "@/components/Icon";
import { FilterPill } from "@/components/FilterPill";
import { prisma } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;
const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
const fmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });

export default async function EventsPage({
  searchParams,
}: {
  searchParams: { page?: string; kind?: string; actor?: string };
}) {
  await requirePlatformAdmin();

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
    // Top kinds by volume under the current filter — keeps the chips
    // meaningful when a specific actor is selected.
    prisma.eventLog.groupBy({
      where,
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
      {/* One slim row for the two text filters — no labels, just
          placeholders — and one row of kind chips with inline counts.
          The chips ARE the discovery mechanism; the inputs are there
          for when you already know what you want. */}
      <form method="get" className="mb-4 flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-xs">
          <Icon name="filter" size={13} className="absolute start-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            name="kind"
            className="field ps-8 py-1.5 text-mini"
            defaultValue={kindFilter}
            placeholder="kind · e.g. rsvp.submitted"
          />
        </div>
        <div className="relative flex-1 max-w-xs">
          <Icon name="user" size={13} className="absolute start-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            name="actor"
            className="field ps-8 py-1.5 text-mini"
            defaultValue={actorFilter}
            placeholder="actor · email or 'system'"
          />
        </div>
        <button className="btn btn-ghost text-mini">Filter</button>
        {(kindFilter || actorFilter) ? (
          <Link href="/events" className="text-mini text-ink-500 hover:text-ink-900">Clear</Link>
        ) : null}
      </form>

      {kinds.length > 0 ? (
        <div className="mb-6 flex flex-wrap gap-1">
          {kinds.map((k) => {
            const qs = new URLSearchParams();
            qs.set("kind", k.kind);
            if (actorFilter) qs.set("actor", actorFilter);
            return (
              <FilterPill
                key={k.kind}
                href={`/events?${qs.toString()}`}
                active={kindFilter === k.kind}
              >
                {k.kind} · {k._count._all}
              </FilterPill>
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
