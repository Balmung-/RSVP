import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { prisma } from "@/lib/db";
import { requireRole, hasRole, requireActiveTenantId } from "@/lib/auth";
import { sendEmail, sendSms } from "@/lib/delivery";
import { logAction } from "@/lib/audit";
import { setFlash } from "@/lib/flash";
import { readAdminLocale, readAdminCalendar, formatAdminDate } from "@/lib/adminLocale";
import { FilterPill, FilterLabel } from "@/components/FilterPill";
import { InlineStat } from "@/components/Stat";
import { CampaignScopeSelect } from "./CampaignScopeSelect";
import { scopedCampaignWhere, canSeeCampaign } from "@/lib/teams";
import { filterLiveFailures } from "@/lib/deliverability";
import { mapConcurrent } from "@/lib/concurrency";

export const dynamic = "force-dynamic";

// Deliverability view: every Invitation currently in a non-delivered state
// for which no later attempt succeeded on the same (invitee, channel).
// The protocol office uses this to chase bounces and retry failures in
// one place instead of walking from campaign to campaign.

type SearchParams = {
  campaign?: string;
  channel?: string;
  status?: string;
};

async function retryOne(invitationId: string, _fd: FormData) {
  "use server";
  const me = await requireRole("editor");
  const tenantId = requireActiveTenantId(me);
  const inv = await prisma.invitation.findUnique({
    where: { id: invitationId },
    include: { campaign: true, invitee: true },
  });
  if (!inv) {
    setFlash({ kind: "warn", text: "Attempt vanished — it may have been deleted." });
    redirect("/deliverability");
  }
  // Defence in depth: the page-level list is already team-scoped, but a
  // direct POST with an invitation id belonging to another team's
  // campaign would otherwise bypass. Treat team-miss as 404.
  if (!(await canSeeCampaign(me.id, hasRole(me, "admin"), tenantId, inv.campaignId))) {
    setFlash({ kind: "warn", text: "You don't have access to that campaign." });
    redirect("/deliverability");
  }
  const res = inv.channel === "email"
    ? await sendEmail(inv.campaign, inv.invitee)
    : await sendSms(inv.campaign, inv.invitee);
  await logAction({
    kind: res.ok ? "invite.retry.ok" : "invite.retry.fail",
    refType: "invitation",
    refId: inv.id,
    data: { channel: inv.channel, error: res.ok ? null : res.error },
  });
  setFlash(
    res.ok
      ? { kind: "success", text: `Resent to ${inv.invitee.fullName}.` }
      : { kind: "warn", text: `Could not resend: ${res.error ?? "unknown error"}.` },
  );
  redirect("/deliverability");
}

// Retry happens inline in the server action — each provider call is ~500ms+
// and Railway's function timeout is real. We cap to RETRY_BATCH per submit so
// the worst case stays under the ceiling. The remainder stays selected-able
// on the next page load.
const RETRY_BATCH = 50;

async function retryAll(formData: FormData) {
  "use server";
  const me = await requireRole("editor");
  const tenantId = requireActiveTenantId(me);
  const ids = formData.getAll("id").map(String).filter(Boolean);
  if (ids.length === 0) {
    setFlash({ kind: "warn", text: "Pick at least one failure to retry." });
    redirect("/deliverability");
  }
  const capped = ids.slice(0, RETRY_BATCH);
  const deferred = ids.length - capped.length;
  // Team-scope the bulk too: fetch candidates, then drop any whose
  // campaign the caller can't see before we actually send.
  const campaignScope = await scopedCampaignWhere(me.id, hasRole(me, "admin"), tenantId);
  const rows = await prisma.invitation.findMany({
    where: { id: { in: capped }, campaign: campaignScope },
    include: { campaign: true, invitee: true },
  });
  // Parallelize at a conservative 5-wide fan-out so we don't serialize
  // on provider latency but also don't flood a rate-limited SMTP. A
  // 50-item batch at 500ms/send completes in ~5s instead of ~25s.
  let ok = 0;
  let fail = 0;
  const results = await mapConcurrent(rows, 5, async (r) => {
    const res = r.channel === "email"
      ? await sendEmail(r.campaign, r.invitee)
      : await sendSms(r.campaign, r.invitee);
    await logAction({
      kind: res.ok ? "invite.retry.ok" : "invite.retry.fail",
      refType: "invitation",
      refId: r.id,
      data: { channel: r.channel, error: res.ok ? null : res.error, bulk: true },
    });
    return res.ok;
  });
  for (const r of results) if (r) ok++; else fail++;
  const suffix = deferred > 0 ? ` — ${deferred} more selected, click Retry again.` : "";
  setFlash({
    kind: fail === 0 && deferred === 0 ? "success" : "warn",
    text: `Retry finished — ${ok} sent, ${fail} still failed${suffix}`,
  });
  redirect("/deliverability");
}

export default async function Deliverability({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const me = await requireRole("editor");
  const tenantId = requireActiveTenantId(me);
  const locale = readAdminLocale();
  const calendar = readAdminCalendar();

  const channel = searchParams.channel === "email" || searchParams.channel === "sms" ? searchParams.channel : "all";
  const statusFilter =
    searchParams.status === "failed" || searchParams.status === "bounced" ? searchParams.status : "all";
  const campaignId = searchParams.campaign && searchParams.campaign !== "all" ? searchParams.campaign : null;

  // Everything here is filtered through the team scope: failures, the
  // facet query that drives the campaign dropdown, and the retry
  // actions. Admins see every campaign; editors see their teams' plus
  // office-wide (teamId=null).
  const campaignScope = await scopedCampaignWhere(me.id, hasRole(me, "admin"), tenantId);

  // Pull every non-happy Invitation. Scope to the last 60 days so ancient
  // bounces don't drown the view.
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const failures = await prisma.invitation.findMany({
    where: {
      status: statusFilter === "all" ? { in: ["failed", "bounced"] } : statusFilter,
      createdAt: { gte: since },
      ...(channel !== "all" ? { channel } : {}),
      ...(campaignId ? { campaignId } : {}),
      campaign: campaignScope,
    },
    orderBy: { createdAt: "desc" },
    include: {
      campaign: { select: { id: true, name: true } },
      invitee: { select: { id: true, fullName: true, email: true, phoneE164: true } },
    },
    take: 500,
  });

  // Delegate the "no later success" filter to the shared helper so
  // this page, the workspace banner, and the digest all agree on
  // what "live" means.
  const live = await filterLiveFailures(failures);

  // Campaign dropdown — only campaigns that actually have failures in
  // range AND that the caller can see (matches the main list scope).
  const campaignFacets = await prisma.invitation.groupBy({
    by: ["campaignId"],
    where: {
      status: { in: ["failed", "bounced"] },
      createdAt: { gte: since },
      campaign: campaignScope,
    },
    _count: { _all: true },
  });
  const facetIds = campaignFacets.map((c) => c.campaignId);
  const campaignNames = facetIds.length
    ? await prisma.campaign.findMany({
        where: { id: { in: facetIds } },
        select: { id: true, name: true },
      })
    : [];
  const campaignNameById = new Map(campaignNames.map((c) => [c.id, c.name]));

  const emailCount = live.filter((f) => f.channel === "email").length;
  const smsCount = live.filter((f) => f.channel === "sms").length;
  const bouncedCount = live.filter((f) => f.status === "bounced").length;

  const qs = (patch: Partial<SearchParams>) => {
    const next = { ...searchParams, ...patch };
    const entries = Object.entries(next).filter(([, v]) => v && v !== "all");
    return entries.length
      ? `/deliverability?${new URLSearchParams(entries as [string, string][]).toString()}`
      : "/deliverability";
  };

  return (
    <Shell
      title={locale === "ar" ? "قابلية الإرسال" : "Deliverability"}
      crumb={locale === "ar" ? "إخفاقات الإرسال الحيّة" : "Live send failures"}
    >
      <div className="flex flex-wrap items-baseline gap-x-10 gap-y-3 mb-8">
        <InlineStat
          label={locale === "ar" ? "إخفاقات حيّة" : "Live failures"}
          value={live.length}
          tone={live.length > 0 ? "fail" : undefined}
        />
        <InlineStat label={locale === "ar" ? "عبر البريد" : "Email"} value={emailCount} />
        <InlineStat
          label={locale === "ar" ? "عبر الرسائل" : "SMS"}
          value={smsCount}
          hint={bouncedCount ? `${bouncedCount} bounced` : undefined}
        />
      </div>

      {/* One horizontal filter strip — channel, status, campaign-scope.
          Pills live on the line; the campaign dropdown inlines alongside.
          No nested <form>, no separate submit button; the select reloads
          via a small client handler. Reset link appears only when any
          filter is active. */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <FilterLabel>{locale === "ar" ? "القناة" : "Channel"}</FilterLabel>
        <div className="flex items-center gap-1">
          <FilterPill href={qs({ channel: undefined })} active={channel === "all"}>All</FilterPill>
          <FilterPill href={qs({ channel: "email" })} active={channel === "email"}>Email</FilterPill>
          <FilterPill href={qs({ channel: "sms" })} active={channel === "sms"}>SMS</FilterPill>
        </div>
        <FilterLabel>{locale === "ar" ? "الحالة" : "Status"}</FilterLabel>
        <div className="flex items-center gap-1">
          <FilterPill href={qs({ status: undefined })} active={statusFilter === "all"}>All</FilterPill>
          <FilterPill href={qs({ status: "failed" })} active={statusFilter === "failed"}>Failed</FilterPill>
          <FilterPill href={qs({ status: "bounced" })} active={statusFilter === "bounced"}>Bounced</FilterPill>
        </div>
        {campaignNames.length > 0 ? (
          <>
            <FilterLabel>{locale === "ar" ? "الحملة" : "Campaign"}</FilterLabel>
            <CampaignScopeSelect
              campaigns={campaignNames}
              selected={campaignId ?? "all"}
              qs={qs}
            />
          </>
        ) : null}
        {(channel !== "all" || statusFilter !== "all" || campaignId) ? (
          <Link
            href="/deliverability"
            className="text-mini text-ink-500 hover:text-ink-900 ms-auto"
          >
            {locale === "ar" ? "مسح" : "Clear"}
          </Link>
        ) : null}
      </div>

      {live.length === 0 ? (
        <EmptyState icon="circle-check" title={locale === "ar" ? "كل شيء سُلِّم" : "Nothing to chase"}>
          {locale === "ar"
            ? "كل محاولة حديثة وصلت بنجاح."
            : "Every recent attempt either delivered or succeeded on a later retry."}
        </EmptyState>
      ) : (
        <form action={retryAll}>
          <div className="flex items-center justify-between mb-3">
            <p className="text-mini text-ink-500">
              {locale === "ar"
                ? `عرض ${live.length.toLocaleString()} محاولة فاشلة حيّة.`
                : `Showing ${live.length.toLocaleString()} live failed attempt${live.length === 1 ? "" : "s"}.`}
            </p>
            <button className="btn btn-soft text-mini">
              <Icon name="send" size={14} />
              {locale === "ar" ? "إعادة إرسال المحدّد" : "Retry selected"}
            </button>
          </div>
          <ul className="panel divide-y divide-ink-100 overflow-hidden max-w-5xl">
            {live.map((f) => {
              const addr = f.channel === "email" ? f.invitee.email : f.invitee.phoneE164;
              const campaignName = campaignNameById.get(f.campaign.id) ?? f.campaign.name;
              return (
                <li key={f.id} className="px-4 py-3 flex items-start gap-4">
                  <input type="checkbox" name="id" value={f.id} className="mt-1.5" aria-label={`Select ${f.invitee.fullName}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-body text-ink-900 font-medium truncate">{f.invitee.fullName}</span>
                      <span className="text-micro uppercase tracking-wider text-ink-400">{f.channel}</span>
                      <span
                        className={`text-micro uppercase tracking-wider ${f.status === "bounced" ? "text-signal-fail" : "text-signal-hold"}`}
                      >
                        {f.status}
                      </span>
                    </div>
                    <div className="text-mini text-ink-500 mt-0.5 truncate">
                      <Link href={`/campaigns/${f.campaign.id}`} className="hover:text-ink-900 transition-colors">
                        {campaignName}
                      </Link>
                      {addr ? <span className="ms-2 text-ink-400">· {addr}</span> : null}
                      <span className="ms-2 text-ink-400">· {formatAdminDate(f.createdAt, locale, calendar)}</span>
                    </div>
                    {f.error ? (
                      <div className="text-mini text-signal-fail mt-1 break-words max-w-2xl">
                        {f.error}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="submit"
                    formAction={retryOne.bind(null, f.id)}
                    className="btn btn-ghost text-mini shrink-0"
                  >
                    <Icon name="send" size={13} />
                    {locale === "ar" ? "إعادة" : "Retry"}
                  </button>
                </li>
              );
            })}
          </ul>
        </form>
      )}
    </Shell>
  );
}
