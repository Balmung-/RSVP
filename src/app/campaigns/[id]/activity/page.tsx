import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Pagination } from "@/components/Pagination";
import { EmptyState } from "@/components/EmptyState";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";
import { phrase } from "@/lib/activity";
import { readAdminLocale, readAdminCalendar, formatAdminDate } from "@/lib/adminLocale";

export const dynamic = "force-dynamic";

// Campaign-scoped activity. Takes advantage of the
// EventLog(refType, refId, createdAt) index we added — fetches events
// where the refType is {campaign, stage, invitee} and the refId
// belongs to this campaign. Big campaigns (>2000 invitees) drop the
// invitee scan to keep the query cheap and show a hint.

const PAGE_SIZE = 50;
const INVITEE_SCAN_CAP = 2000;

export default async function CampaignActivity({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { page?: string };
}) {
  if (!(await isAuthed())) redirect("/login");

  const campaign = await prisma.campaign.findUnique({
    where: { id: params.id },
    select: { id: true, name: true, status: true },
  });
  if (!campaign) notFound();

  const page = Math.max(1, parseInt(searchParams.page ?? "1", 10) || 1);
  const locale = readAdminLocale();
  const calendar = readAdminCalendar();

  // Scope by refType + refId sets we know belong to this campaign.
  // Cheaper than adding campaignId to EventLog schema, and the
  // (refType, refId, createdAt) index makes each OR branch indexed.
  const [stageIds, inviteeCount] = await Promise.all([
    prisma.campaignStage.findMany({ where: { campaignId: params.id }, select: { id: true } }),
    prisma.invitee.count({ where: { campaignId: params.id } }),
  ]);
  const inviteeIds = inviteeCount <= INVITEE_SCAN_CAP
    ? (await prisma.invitee.findMany({ where: { campaignId: params.id }, select: { id: true } })).map((i) => i.id)
    : null;
  const inviteeScanCapped = inviteeIds === null;

  // Per-invitation events (invite.sent, delivery.webhook) use refId =
  // invitation.id which is its own id-space, not the invitee.id — we
  // skip them here to avoid a second large IN clause, and they're still
  // reachable from the global /events audit view.
  const scopedOr = [
    { refType: "campaign", refId: params.id },
    ...(stageIds.length > 0 ? [{ refType: "stage", refId: { in: stageIds.map((s) => s.id) } }] : []),
    ...(inviteeIds && inviteeIds.length > 0
      ? [{ refType: "invitee", refId: { in: inviteeIds } }]
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

  const hrefFor = (p: number) => `/campaigns/${params.id}/activity?page=${p}`;

  return (
    <Shell
      title={locale === "ar" ? "سجل النشاط" : "Activity"}
      crumb={
        <span>
          <Link href="/campaigns" className="hover:text-ink-900 transition-colors">Campaigns</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <Link href={`/campaigns/${campaign.id}`} className="hover:text-ink-900 transition-colors">
            {campaign.name}
          </Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>{locale === "ar" ? "السجل" : "Activity"}</span>
        </span>
      }
    >
      <p className="text-mini text-ink-500 mb-6 max-w-2xl leading-relaxed">
        {locale === "ar"
          ? "كل حدث مرتبط بهذه الحملة — من التعديلات والإرسال إلى ردود المدعوين."
          : "Every event tied to this campaign — from edits and sends to invitee replies. Per-invitation send logs stay in the global audit view."}
        {inviteeScanCapped ? (
          <span className="block mt-2 text-ink-400">
            {locale === "ar"
              ? "هذه الحملة كبيرة — تم إخفاء أحداث المدعوين الفردية."
              : `Campaign has ${inviteeCount.toLocaleString()}+ invitees — per-invitee events hidden to keep this page fast.`}
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
          <ol className="max-w-3xl relative border-s border-ink-100 ps-6 flex flex-col gap-5">
            {rows.map((r) => {
              const { line, tone } = phrase({
                ...r,
                actor: r.actor as { email: string; fullName: string | null } | null,
              });
              return (
                <li key={r.id} className="relative">
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
                  <div className="text-body text-ink-900 leading-snug">{line}</div>
                  <div className="text-mini text-ink-400 mt-0.5 tabular-nums">
                    {formatAdminDate(r.createdAt, locale, calendar)}
                    <span className="mx-1.5 text-ink-300">·</span>
                    <span className="font-mono">{r.kind}</span>
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
