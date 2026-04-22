import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Pagination } from "@/components/Pagination";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { getCurrentUser, requireActiveTenantId } from "@/lib/auth";
import { searchContacts, VIP_LABEL, type VipTier, resolveContactOptOuts, contactOptOutState } from "@/lib/contacts";
import { FilterPill, FilterLabel } from "@/components/FilterPill";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

const tierDot: Record<string, string> = {
  royal: "bg-signal-fail",
  minister: "bg-signal-hold",
  vip: "bg-signal-info",
  standard: "bg-ink-300",
};

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: { page?: string; q?: string; tier?: string };
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const tenantId = requireActiveTenantId(me);

  const page = Math.max(1, parseInt(searchParams.page ?? "1", 10) || 1);
  const q = (searchParams.q ?? "").trim();
  const tierRaw = searchParams.tier as VipTier | "all" | undefined;
  const tier = tierRaw && (["royal", "minister", "vip", "standard", "all"] as const).includes(tierRaw as never)
    ? (tierRaw as VipTier | "all")
    : ("all" as const);

  const { total, rows } = await searchContacts({
    tenantId,
    q,
    tier,
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
  });
  const optOutSet = await resolveContactOptOuts(rows);

  const hrefFor = (p: number) => {
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    if (tier !== "all") qs.set("tier", tier);
    qs.set("page", String(p));
    return `/contacts?${qs.toString()}`;
  };

  const tierHref = (t: VipTier | "all") => {
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    if (t !== "all") qs.set("tier", t);
    return `/contacts?${qs.toString()}`;
  };

  if (total === 0 && !q && tier === "all") {
    return (
      <Shell
        title="Contacts"
        crumb="Address book"
        actions={
          <Link href="/contacts/new" className="btn btn-primary">
            <Icon name="plus" size={14} />
            New contact
          </Link>
        }
      >
        <EmptyState
          icon="users"
          title="Build your address book"
          action={{ label: "Add the first contact", href: "/contacts/new" }}
        >
          Contacts are the canonical record for the people you invite — the same
          ambassador across every reception. Tag them, mark VIP tier, note dietary
          and dress, then pull them into any campaign in two clicks.
        </EmptyState>
      </Shell>
    );
  }

  return (
    <Shell
      title="Contacts"
      crumb="Address book"
      actions={
        <Link href="/contacts/new" className="btn btn-primary">
          <Icon name="plus" size={14} />
          New contact
        </Link>
      }
    >
      {/* Horizontal filter strip — search on the left (slim, no panel),
          tier pills inline on the right. Same composition as the other
          list pages so the whole app reads as one. */}
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <form method="get" className="relative flex-1 max-w-md">
          <label className="sr-only" htmlFor="contact-search">Search contacts</label>
          <Icon name="search" size={14} className="absolute start-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            id="contact-search"
            name="q"
            defaultValue={q}
            placeholder="Search name, email, phone, organization, tag"
            className="field ps-9"
          />
          {tier !== "all" ? <input type="hidden" name="tier" value={tier} /> : null}
        </form>
        <FilterLabel>Tier</FilterLabel>
        <div className="flex items-center gap-1">
          <FilterPill href={tierHref("all")} active={tier === "all"}>All</FilterPill>
          {(["royal", "minister", "vip", "standard"] as const).map((t) => (
            <FilterPill key={t} href={tierHref(t)} active={tier === t} dot={tierDot[t]}>
              {VIP_LABEL[t]}
            </FilterPill>
          ))}
        </div>
        {(q || tier !== "all") ? (
          <Link href="/contacts" className="text-mini text-ink-500 hover:text-ink-900">Clear</Link>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <EmptyState icon="search" title="No matches" className="py-16">
          Nothing matches this query. Try a shorter term or a phone snippet.
        </EmptyState>
      ) : (
        <div className="panel rail overflow-hidden">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Organization</th>
                <th scope="col">Tier</th>
                <th scope="col">Email</th>
                <th scope="col">Phone</th>
                <th scope="col" className="text-end">Invited to</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const opt = contactOptOutState(c, optOutSet);
                return (
                <tr key={c.id}>
                  <td>
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/contacts/${c.id}/edit`}
                        className="font-medium text-ink-900 hover:underline"
                      >
                        {c.fullName}
                      </Link>
                      {opt.any ? (
                        <span
                          className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-signal-fail/10 text-signal-fail"
                          title={
                            opt.email && opt.sms
                              ? "Opted out on both channels"
                              : opt.email
                                ? "Opted out on email — SMS still on"
                                : "Opted out on SMS — email still on"
                          }
                        >
                          Opted out
                        </span>
                      ) : null}
                    </div>
                    {c.title ? <div className="text-mini text-ink-400 mt-0.5">{c.title}</div> : null}
                  </td>
                  <td className="text-ink-600">{c.organization ?? <span className="text-ink-300">—</span>}</td>
                  <td>
                    <span className="inline-flex items-center gap-2 text-body text-ink-700">
                      <span className={`dot ${tierDot[c.vipTier] ?? "bg-ink-300"}`} />
                      {VIP_LABEL[c.vipTier as VipTier] ?? c.vipTier}
                    </span>
                  </td>
                  <td className="text-ink-600">{c.email ?? <span className="text-ink-300">—</span>}</td>
                  <td className="text-ink-600 tabular-nums">
                    {c.phoneE164 ?? <span className="text-ink-300">—</span>}
                  </td>
                  <td className="text-end tabular-nums text-ink-600">{c._count.invitees}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageSize={PAGE_SIZE} total={total} hrefFor={hrefFor} />
    </Shell>
  );
}
