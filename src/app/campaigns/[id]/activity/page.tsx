import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Pagination } from "@/components/Pagination";
import { EmptyState } from "@/components/EmptyState";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole, requireActiveTenantId } from "@/lib/auth";
import { canSeeCampaign } from "@/lib/teams";
import { phrase } from "@/lib/activity";
import { readAdminLocale, readAdminCalendar, formatAdminDate } from "@/lib/adminLocale";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const INVITEE_SCAN_CAP = 2000;
const INVITATION_SCAN_CAP = 5000;

export default async function CampaignActivity({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { page?: string };
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const tenantId = requireActiveTenantId(me);

  const campaign = await prisma.campaign.findUnique({
    where: { id: params.id },
    select: { id: true, name: true, status: true, tenantId: true },
  });
  if (!campaign) notFound();
  if (!(await canSeeCampaign(me.id, hasRole(me, "admin"), tenantId, campaign.id))) notFound();

  const page = Math.max(1, parseInt(searchParams.page ?? "1", 10) || 1);
  const locale = readAdminLocale();
  const calendar = readAdminCalendar();

  const [stageIds, inviteeCount, invitationCount] = await Promise.all([
    prisma.campaignStage.findMany({ where: { campaignId: params.id }, select: { id: true } }),
    prisma.invitee.count({ where: { campaignId: params.id } }),
    prisma.invitation.count({ where: { campaignId: params.id } }),
  ]);

  const inviteeIds = inviteeCount <= INVITEE_SCAN_CAP
    ? (await prisma.invitee.findMany({
        where: { campaignId: params.id },
        select: { id: true },
      })).map((invitee) => invitee.id)
    : null;
  const invitationIds = invitationCount <= INVITATION_SCAN_CAP
    ? (await prisma.invitation.findMany({
        where: { campaignId: params.id },
        select: { id: true },
      })).map((invitation) => invitation.id)
    : null;

  const inviteeScanCapped = inviteeIds === null;
  const invitationScanCapped = invitationIds === null;

  const scopedOr = [
    { refType: "campaign", refId: params.id },
    ...(stageIds.length > 0 ? [{ refType: "stage", refId: { in: stageIds.map((stage) => stage.id) } }] : []),
    ...(inviteeIds && inviteeIds.length > 0
      ? [{ refType: "invitee", refId: { in: inviteeIds } }]
      : []),
    ...(invitationIds && invitationIds.length > 0
      ? [{ refType: "invitation", refId: { in: invitationIds } }]
      : []),
  ];
  const where = scopedOr.length === 1 ? scopedOr[0] : { OR: scopedOr };

  const [total, rows] = await Promise.all([
    prisma.eventLog.count({ where }),
    prisma.eventLog.findMany({
      where,
      include: { actor: { select: { email: true, fullName: true } } },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  const hrefFor = (nextPage: number) => `/campaigns/${params.id}/activity?page=${nextPage}`;

  return (
    <Shell
      title={locale === "ar" ? "سجل النشاط" : "Activity"}
      crumb={(
        <span>
          <Link href="/campaigns" className="transition-colors hover:text-ink-900">Campaigns</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <Link href={`/campaigns/${campaign.id}`} className="transition-colors hover:text-ink-900">
            {campaign.name}
          </Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>{locale === "ar" ? "السجل" : "Activity"}</span>
        </span>
      )}
    >
      <p className="mb-6 max-w-2xl text-mini leading-relaxed text-ink-500">
        {locale === "ar"
          ? "كل حدث مرتبط بهذه الحملة — من التعديلات والإرسال إلى ردود المدعوين وحالة التسليم."
          : "Every event tied to this campaign — from edits and sends to invitee replies and delivery updates."}
        {inviteeScanCapped || invitationScanCapped ? (
          <span className="mt-2 block text-ink-400">
            {locale === "ar"
              ? "هذه الحملة كبيرة — تم إخفاء بعض السجلات الفردية لإبقاء الصفحة سريعة."
              : "Campaign is large — some per-invitee or per-invitation events are hidden to keep this page fast."}
          </span>
        ) : null}
      </p>

      {rows.length === 0 ? (
        <EmptyState icon="list" title={locale === "ar" ? "لا نشاط بعد" : "No activity yet"}>
          {locale === "ar"
            ? "ستظهر الأحداث هنا فور حدوثها."
            : "Events appear here as operators and invitees act on the campaign."}
        </EmptyState>
      ) : (
        <>
          <ol className="relative flex max-w-3xl flex-col gap-5 border-s border-ink-100 ps-6">
            {rows.map((row) => {
              const { line, tone } = phrase({
                ...row,
                actor: row.actor as { email: string; fullName: string | null } | null,
              });
              return (
                <li key={row.id} className="relative">
                  <span
                    className={`absolute -start-[1.72rem] top-1.5 h-2 w-2 rounded-full ${
                      tone === "success"
                        ? "bg-signal-live"
                        : tone === "warn"
                          ? "bg-signal-hold"
                          : tone === "fail"
                            ? "bg-signal-fail"
                            : "bg-ink-300"
                    }`}
                    aria-hidden
                  />
                  <div className="leading-snug text-body text-ink-900">{line}</div>
                  <div className="mt-0.5 tabular-nums text-mini text-ink-400">
                    {formatAdminDate(row.createdAt, locale, calendar)}
                    <span className="mx-1.5 text-ink-300">·</span>
                    <span className="font-mono">{row.kind}</span>
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="max-w-3xl">
            <Pagination page={page} pageSize={PAGE_SIZE} total={total} hrefFor={hrefFor} />
          </div>
        </>
      )}
    </Shell>
  );
}
