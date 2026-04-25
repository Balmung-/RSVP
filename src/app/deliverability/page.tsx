import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { prisma } from "@/lib/db";
import { requireRole, hasRole, requireActiveTenantId } from "@/lib/auth";
import { sendEmail, sendSms, sendWhatsApp } from "@/lib/delivery";
import { logAction } from "@/lib/audit";
import { setFlash } from "@/lib/flash";
import { readAdminLocale, readAdminCalendar, formatAdminDate } from "@/lib/adminLocale";
import { FilterPill, FilterLabel } from "@/components/FilterPill";
import { InlineStat } from "@/components/Stat";
import { CampaignScopeSelect, buildDeliverabilityHref } from "./CampaignScopeSelect";
import { scopedCampaignWhere, canSeeCampaign } from "@/lib/teams";
import { filterLiveFailures } from "@/lib/deliverability";
import { mapConcurrent } from "@/lib/concurrency";
import { buildDispatchFlash } from "@/lib/campaign-send-feedback";

export const dynamic = "force-dynamic";

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
  if (!(await canSeeCampaign(me.id, hasRole(me, "admin"), tenantId, inv.campaignId))) {
    setFlash({ kind: "warn", text: "You don't have access to that campaign." });
    redirect("/deliverability");
  }
  const res =
    inv.channel === "email"
      ? await sendEmail(inv.campaign, inv.invitee)
      : inv.channel === "sms"
        ? await sendSms(inv.campaign, inv.invitee)
        : await sendWhatsApp(inv.campaign, inv.invitee);
  await logAction({
    kind: res.ok ? "invite.retry.ok" : "invite.retry.fail",
    refType: "invitation",
    refId: inv.id,
    data: { channel: inv.channel, error: res.ok ? null : res.error },
  });
  setFlash(
    res.ok
      ? { kind: "success", text: `Resent to ${inv.invitee.fullName}.` }
      : { kind: "warn", text: `Could not resend.`, detail: res.error ?? "unknown error" },
  );
  redirect("/deliverability");
}

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
  const campaignScope = await scopedCampaignWhere(me.id, hasRole(me, "admin"), tenantId);
  const rows = await prisma.invitation.findMany({
    where: { id: { in: capped }, campaign: campaignScope },
    include: { campaign: true, invitee: true },
  });

  let email = 0;
  let sms = 0;
  let whatsapp = 0;
  let failed = 0;
  const failureCounts = new Map<string, { channel: "email" | "sms" | "whatsapp"; error: string; count: number }>();

  const results = await mapConcurrent(rows, 5, async (row) => {
    const res =
      row.channel === "email"
        ? await sendEmail(row.campaign, row.invitee)
        : row.channel === "sms"
          ? await sendSms(row.campaign, row.invitee)
          : await sendWhatsApp(row.campaign, row.invitee);
    await logAction({
      kind: res.ok ? "invite.retry.ok" : "invite.retry.fail",
      refType: "invitation",
      refId: row.id,
      data: { channel: row.channel, error: res.ok ? null : res.error, bulk: true },
    });
    return res;
  });

  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    const row = rows[i];
    if (res.ok) {
      if (row.channel === "email") email++;
      else if (row.channel === "sms") sms++;
      else whatsapp++;
      continue;
    }
    failed++;
    const error = (res.error ?? "unknown error").slice(0, 300);
    const key = `${row.channel}:${error}`;
    const existing = failureCounts.get(key);
    if (existing) existing.count++;
    else {
      failureCounts.set(key, {
        channel: row.channel as "email" | "sms" | "whatsapp",
        error,
        count: 1,
      });
    }
  }

  const flash = buildDispatchFlash({
    kind: "retry",
    result: {
      email,
      sms,
      whatsapp,
      skipped: 0,
      failed,
      failureReasons: [...failureCounts.values()],
    },
  });
  const suffix = deferred > 0 ? ` ${deferred} more selected — click Retry again.` : "";
  setFlash({
    kind: flash.kind,
    text: `${flash.text}${suffix}`,
    detail: flash.detail,
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

  const channel =
    searchParams.channel === "email" ||
    searchParams.channel === "sms" ||
    searchParams.channel === "whatsapp"
      ? searchParams.channel
      : "all";
  const statusFilter =
    searchParams.status === "failed" || searchParams.status === "bounced" ? searchParams.status : "all";
  const campaignId = searchParams.campaign && searchParams.campaign !== "all" ? searchParams.campaign : null;

  const campaignScope = await scopedCampaignWhere(me.id, hasRole(me, "admin"), tenantId);
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

  const live = await filterLiveFailures(failures);

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
  const whatsappCount = live.filter((f) => f.channel === "whatsapp").length;
  const bouncedCount = live.filter((f) => f.status === "bounced").length;

  const qs = (patch: Partial<SearchParams>) => buildDeliverabilityHref(searchParams, patch);

  return (
    <Shell
      title={locale === "ar" ? "قابلية الإرسال" : "Deliverability"}
      crumb={locale === "ar" ? "إخفاقات الإرسال الحية" : "Live send failures"}
    >
      <div className="mb-8 flex flex-wrap items-baseline gap-x-10 gap-y-3">
        <InlineStat
          label={locale === "ar" ? "إخفاقات حية" : "Live failures"}
          value={live.length}
          tone={live.length > 0 ? "fail" : undefined}
        />
        <InlineStat label={locale === "ar" ? "عبر البريد" : "Email"} value={emailCount} />
        <InlineStat
          label={locale === "ar" ? "عبر الرسائل" : "SMS"}
          value={smsCount}
          hint={bouncedCount ? `${bouncedCount} bounced` : undefined}
        />
        <InlineStat label={locale === "ar" ? "واتساب" : "WhatsApp"} value={whatsappCount} />
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <FilterLabel>{locale === "ar" ? "القناة" : "Channel"}</FilterLabel>
        <div className="flex items-center gap-1">
          <FilterPill href={qs({ channel: undefined })} active={channel === "all"}>All</FilterPill>
          <FilterPill href={qs({ channel: "email" })} active={channel === "email"}>Email</FilterPill>
          <FilterPill href={qs({ channel: "sms" })} active={channel === "sms"}>SMS</FilterPill>
          <FilterPill href={qs({ channel: "whatsapp" })} active={channel === "whatsapp"}>WhatsApp</FilterPill>
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
              searchParams={searchParams}
            />
          </>
        ) : null}
        {(channel !== "all" || statusFilter !== "all" || campaignId) ? (
          <Link href="/deliverability" className="ms-auto text-mini text-ink-500 hover:text-ink-900">
            {locale === "ar" ? "مسح" : "Clear"}
          </Link>
        ) : null}
      </div>

      {live.length === 0 ? (
        <EmptyState icon="circle-check" title={locale === "ar" ? "كل شيء سُلِّم" : "Nothing to chase"}>
          {locale === "ar"
            ? "كل محاولة حديثة وصلت بنجاح."
            : "Every recent attempt either delivered or succeeded on a later retry."}
        </EmptyState>
      ) : (
        <form action={retryAll}>
          <div className="mb-3 flex items-center justify-between">
            <p className="text-mini text-ink-500">
              {locale === "ar"
                ? `عرض ${live.length.toLocaleString()} محاولة فاشلة حية.`
                : `Showing ${live.length.toLocaleString()} live failed attempt${live.length === 1 ? "" : "s"}.`}
            </p>
            <button className="btn btn-soft text-mini">
              <Icon name="send" size={14} />
              {locale === "ar" ? "إعادة إرسال المحدّد" : "Retry selected"}
            </button>
          </div>
          <ul className="panel max-w-5xl divide-y divide-ink-100 overflow-hidden">
            {live.map((f) => {
              const addr = f.channel === "email" ? f.invitee.email : f.invitee.phoneE164;
              const campaignName = campaignNameById.get(f.campaign.id) ?? f.campaign.name;
              return (
                <li key={f.id} className="flex items-start gap-4 px-4 py-3">
                  <input type="checkbox" name="id" value={f.id} className="mt-1.5" aria-label={`Select ${f.invitee.fullName}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-body font-medium text-ink-900">{f.invitee.fullName}</span>
                      <span className="text-micro uppercase tracking-wider text-ink-400">{f.channel}</span>
                      <span
                        className={`text-micro uppercase tracking-wider ${f.status === "bounced" ? "text-signal-fail" : "text-signal-hold"}`}
                      >
                        {f.status}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-mini text-ink-500">
                      <Link href={`/campaigns/${f.campaign.id}`} className="transition-colors hover:text-ink-900">
                        {campaignName}
                      </Link>
                      {addr ? <span className="ms-2 text-ink-400">· {addr}</span> : null}
                      <span className="ms-2 text-ink-400">· {formatAdminDate(f.createdAt, locale, calendar)}</span>
                    </div>
                    {f.error ? (
                      <div className="mt-1 max-w-3xl whitespace-pre-wrap break-words text-mini text-signal-fail">
                        {f.error}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="submit"
                    formAction={retryOne.bind(null, f.id)}
                    className="btn btn-ghost shrink-0 text-mini"
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
