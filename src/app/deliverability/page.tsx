import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { prisma } from "@/lib/db";
import { requireRole } from "@/lib/auth";
import { sendEmail, sendSms } from "@/lib/delivery";
import { logAction } from "@/lib/audit";
import { setFlash } from "@/lib/flash";
import { readAdminLocale, readAdminCalendar, adminDict, formatAdminDate } from "@/lib/adminLocale";

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
  await requireRole("editor");
  const inv = await prisma.invitation.findUnique({
    where: { id: invitationId },
    include: { campaign: true, invitee: true },
  });
  if (!inv) {
    setFlash({ kind: "warn", text: "Attempt vanished — it may have been deleted." });
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

async function retryAll(formData: FormData) {
  "use server";
  await requireRole("editor");
  const ids = formData.getAll("id").map(String).filter(Boolean);
  if (ids.length === 0) {
    setFlash({ kind: "warn", text: "Pick at least one failure to retry." });
    redirect("/deliverability");
  }
  const rows = await prisma.invitation.findMany({
    where: { id: { in: ids } },
    include: { campaign: true, invitee: true },
  });
  let ok = 0;
  let fail = 0;
  for (const r of rows) {
    const res = r.channel === "email"
      ? await sendEmail(r.campaign, r.invitee)
      : await sendSms(r.campaign, r.invitee);
    if (res.ok) ok++; else fail++;
    await logAction({
      kind: res.ok ? "invite.retry.ok" : "invite.retry.fail",
      refType: "invitation",
      refId: r.id,
      data: { channel: r.channel, error: res.ok ? null : res.error, bulk: true },
    });
  }
  setFlash({
    kind: fail === 0 ? "success" : "warn",
    text: `Retry finished — ${ok} sent, ${fail} still failed.`,
  });
  redirect("/deliverability");
}

export default async function Deliverability({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireRole("editor");
  const locale = readAdminLocale();
  const calendar = readAdminCalendar();
  const T = adminDict(locale);

  const channel = searchParams.channel === "email" || searchParams.channel === "sms" ? searchParams.channel : "all";
  const statusFilter =
    searchParams.status === "failed" || searchParams.status === "bounced" ? searchParams.status : "all";
  const campaignId = searchParams.campaign && searchParams.campaign !== "all" ? searchParams.campaign : null;

  // Pull every non-happy Invitation. Scope to the last 60 days so ancient
  // bounces don't drown the view.
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const failures = await prisma.invitation.findMany({
    where: {
      status: statusFilter === "all" ? { in: ["failed", "bounced"] } : statusFilter,
      createdAt: { gte: since },
      ...(channel !== "all" ? { channel } : {}),
      ...(campaignId ? { campaignId } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      campaign: { select: { id: true, name: true } },
      invitee: { select: { id: true, fullName: true, email: true, phoneE164: true } },
    },
    take: 500,
  });

  // A failure is "live" only if nothing later succeeded on that (invitee,
  // channel). A quick index pass over the same list handles the common
  // case; for anything else we fall back to a single grouped query.
  const laterOk = await prisma.invitation.groupBy({
    by: ["inviteeId", "channel"],
    where: {
      inviteeId: { in: failures.map((f) => f.inviteeId) },
      status: { in: ["sent", "delivered"] },
    },
    _max: { createdAt: true },
  });
  const okAt = new Map<string, Date>();
  for (const g of laterOk) {
    if (g._max.createdAt) okAt.set(`${g.inviteeId}:${g.channel}`, g._max.createdAt);
  }
  const live = failures.filter((f) => {
    const ok = okAt.get(`${f.inviteeId}:${f.channel}`);
    return !ok || ok < f.createdAt;
  });

  // Campaign dropdown — only campaigns that actually have failures in range.
  const campaignFacets = await prisma.invitation.groupBy({
    by: ["campaignId"],
    where: {
      status: { in: ["failed", "bounced"] },
      createdAt: { gte: since },
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
      <div className="grid grid-cols-3 gap-6 mb-8 max-w-3xl">
        <Tile
          label={locale === "ar" ? "إخفاقات حيّة" : "Live failures"}
          value={live.length}
          tone={live.length > 0 ? "fail" : "default"}
        />
        <Tile label={locale === "ar" ? "عبر البريد" : "Email"} value={emailCount} />
        <Tile label={locale === "ar" ? "عبر الرسائل" : "SMS"} value={smsCount} hint={bouncedCount ? `${bouncedCount} bounced` : undefined} />
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <FilterGroup label={locale === "ar" ? "القناة" : "Channel"}>
          <FilterPill href={qs({ channel: undefined })} active={channel === "all"}>All</FilterPill>
          <FilterPill href={qs({ channel: "email" })} active={channel === "email"}>Email</FilterPill>
          <FilterPill href={qs({ channel: "sms" })} active={channel === "sms"}>SMS</FilterPill>
        </FilterGroup>
        <FilterGroup label={locale === "ar" ? "الحالة" : "Status"}>
          <FilterPill href={qs({ status: undefined })} active={statusFilter === "all"}>All</FilterPill>
          <FilterPill href={qs({ status: "failed" })} active={statusFilter === "failed"}>Failed</FilterPill>
          <FilterPill href={qs({ status: "bounced" })} active={statusFilter === "bounced"}>Bounced</FilterPill>
        </FilterGroup>
        {campaignNames.length > 0 ? (
          <form method="get" className="flex items-center gap-2">
            <label className="text-micro uppercase text-ink-400">
              {locale === "ar" ? "الحملة" : "Campaign"}
            </label>
            <select
              name="campaign"
              defaultValue={campaignId ?? "all"}
              className="field py-1.5 text-mini min-w-[10rem]"
            >
              <option value="all">All</option>
              {campaignNames.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            {channel !== "all" ? <input type="hidden" name="channel" value={channel} /> : null}
            {statusFilter !== "all" ? <input type="hidden" name="status" value={statusFilter} /> : null}
            <button className="btn btn-ghost text-mini">{T.filter}</button>
          </form>
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

function Tile({
  label,
  value,
  tone = "default",
  hint,
}: {
  label: string;
  value: number;
  tone?: "default" | "fail";
  hint?: string;
}) {
  const dot = tone === "fail" ? "bg-signal-fail" : "bg-ink-300";
  return (
    <div className="panel-quiet p-5 flex flex-col gap-1">
      <span className="inline-flex items-center gap-2 text-micro uppercase text-ink-400">
        <span className={`dot ${dot}`} />
        {label}
      </span>
      <span
        className="text-ink-900 tabular-nums"
        style={{ fontSize: "28px", lineHeight: "34px", letterSpacing: "-0.02em", fontWeight: 500 }}
      >
        {value.toLocaleString()}
      </span>
      {hint ? <span className="text-mini text-ink-400">{hint}</span> : null}
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-micro uppercase text-ink-400">{label}</span>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}

function FilterPill({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`px-2.5 py-1 rounded-md text-mini transition-colors ${
        active
          ? "bg-ink-900 text-ink-0"
          : "bg-ink-100 text-ink-600 hover:bg-ink-200 hover:text-ink-900"
      }`}
    >
      {children}
    </Link>
  );
}
