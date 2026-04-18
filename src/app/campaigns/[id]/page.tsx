import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Tabs, type TabItem } from "@/components/Tabs";
import { InviteePanel } from "@/components/InviteePanel";
import { ArrivalsBoard } from "@/components/ArrivalsBoard";
import { CampaignHeader, CampaignHeaderCrumb } from "@/components/workspace/CampaignHeader";
import { InviteesTab } from "@/components/workspace/InviteesTab";
import { ScheduleTab } from "@/components/workspace/ScheduleTab";
import { ContentTab } from "@/components/workspace/ContentTab";
import { prisma } from "@/lib/db";
import { isAuthed, requireRole, getCurrentUser, hasRole } from "@/lib/auth";
import {
  campaignStats,
  sendCampaign,
  resendSingle,
  resendSelection,
  deleteInvitee,
  findDuplicates,
  liveFailureCount,
} from "@/lib/campaigns";
import { listStages, runStageNow } from "@/lib/stages";
import { duplicateCampaign } from "@/lib/campaign-duplicate";
import { setFlash } from "@/lib/flash";
import { readAdminLocale } from "@/lib/adminLocale";
import {
  createQuestion,
  deleteQuestion,
  parseOptions,
  QUESTION_KINDS,
  SHOW_WHEN,
  needsOptions,
  type QuestionKind,
  type ShowWhen,
} from "@/lib/questions";
import {
  createAttachment,
  deleteAttachment,
  hydrateAttachments,
  isSafeUrl,
  ATTACHMENT_KINDS,
  type AttachmentKind,
} from "@/lib/attachments";
import {
  createEventOption,
  deleteEventOption,
} from "@/lib/eventoptions";
import { parseLocalInput } from "@/lib/time";
import {
  needsApproval,
  pendingApproval,
  requestApproval,
} from "@/lib/approvals";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

type Tab = "invitees" | "schedule" | "content" | "arrivals";
const TABS: readonly Tab[] = ["invitees", "schedule", "content", "arrivals"] as const;

// ---------- actions (editor-gated) ----------

async function sendAction(formData: FormData) {
  "use server";
  const me = await requireRole("editor");
  const id = String(formData.get("id"));
  const channel = String(formData.get("channel") ?? "both") as "email" | "sms" | "both";

  // Compute recipient count for the chosen channel. Same predicate as the
  // header's pre-send summary so the approval threshold check is honest.
  const [emailCount, smsCount] = await Promise.all([
    channel === "sms"
      ? Promise.resolve(0)
      : prisma.invitee.count({
          where: {
            campaignId: id,
            email: { not: null },
            NOT: { invitations: { some: { channel: "email", status: { in: ["sent", "delivered"] } } } },
          },
        }),
    channel === "email"
      ? Promise.resolve(0)
      : prisma.invitee.count({
          where: {
            campaignId: id,
            phoneE164: { not: null },
            NOT: { invitations: { some: { channel: "sms", status: { in: ["sent", "delivered"] } } } },
          },
        }),
  ]);
  const recipients = emailCount + smsCount;

  // Admin bypasses the approval gate — their click IS the approval.
  const myRole = me.role as "admin" | "editor" | "viewer";
  if (needsApproval(recipients) && myRole !== "admin") {
    await requestApproval({
      campaignId: id,
      channel,
      recipientCount: recipients,
      requestedBy: me.id,
    });
    setFlash({
      kind: "info",
      text: "Approval requested",
      detail: `An admin needs to approve this send (${recipients.toLocaleString()} recipients).`,
    });
    redirect(`/campaigns/${id}`);
  }

  // Admin direct-send closes any outstanding pending approval for this
  // campaign so /approvals doesn't keep a stale row.
  if (myRole === "admin") {
    await prisma.sendApproval.updateMany({
      where: { campaignId: id, status: "pending" },
      data: {
        status: "approved",
        decidedBy: me.id,
        decidedAt: new Date(),
        decisionNote: "Admin sent directly.",
      },
    });
  }

  await sendCampaign(id, { channel, onlyUnsent: true });
  redirect(`/campaigns/${id}`);
}

async function singleResend(campaignId: string, formData: FormData) {
  "use server";
  await requireRole("editor");
  const inviteeId = String(formData.get("inviteeId"));
  const channel = String(formData.get("channel")) as "email" | "sms";
  if (channel !== "email" && channel !== "sms") redirect(`/campaigns/${campaignId}?invitee=${inviteeId}`);
  await resendSingle(campaignId, inviteeId, channel);
  redirect(`/campaigns/${campaignId}?invitee=${inviteeId}`);
}

async function singleDelete(campaignId: string, formData: FormData) {
  "use server";
  await requireRole("editor");
  const inviteeId = String(formData.get("inviteeId"));
  await deleteInvitee(campaignId, inviteeId);
  redirect(`/campaigns/${campaignId}`);
}

async function bulkResend(campaignId: string, formData: FormData) {
  "use server";
  await requireRole("editor");
  const ids = formData.getAll("id").map(String).filter(Boolean);
  const channel = String(formData.get("channel")) as "email" | "sms";
  if (ids.length === 0 || (channel !== "email" && channel !== "sms")) redirect(`/campaigns/${campaignId}`);
  await resendSelection(campaignId, ids, { channels: [channel], onlyUnsent: false });
  redirect(`/campaigns/${campaignId}`);
}

async function bulkDelete(campaignId: string, formData: FormData) {
  "use server";
  await requireRole("editor");
  const ids = formData.getAll("id").map(String).filter(Boolean);
  if (ids.length === 0) redirect(`/campaigns/${campaignId}`);
  await prisma.invitee.deleteMany({ where: { campaignId, id: { in: ids } } });
  redirect(`/campaigns/${campaignId}`);
}

async function runStageAction(campaignId: string, formData: FormData) {
  "use server";
  await requireRole("editor");
  const stageId = String(formData.get("stageId"));
  if (stageId) await runStageNow(stageId, campaignId);
  redirect(`/campaigns/${campaignId}?tab=schedule`);
}

async function duplicateAction(campaignId: string) {
  "use server";
  await requireRole("editor");
  const newId = await duplicateCampaign(campaignId);
  setFlash({ kind: "success", text: "Campaign duplicated", detail: "Fresh invitee list, same settings." });
  redirect(`/campaigns/${newId}`);
}

// Content tab actions ------------------------------------------------

async function addQuestionAction(campaignId: string, formData: FormData) {
  "use server";
  await requireRole("editor");
  const kindRaw = String(formData.get("kind") ?? "short_text");
  const kind = (QUESTION_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as QuestionKind) : "short_text";
  const showRaw = String(formData.get("showWhen") ?? "always");
  const showWhen = (SHOW_WHEN as readonly string[]).includes(showRaw) ? (showRaw as ShowWhen) : "always";
  const prompt = String(formData.get("prompt") ?? "").trim();
  const options = String(formData.get("options") ?? "");
  if (!prompt) redirect(`/campaigns/${campaignId}?tab=content&e=qprompt`);
  if (needsOptions(kind) && parseOptions(options).length === 0) {
    redirect(`/campaigns/${campaignId}?tab=content&e=qopts`);
  }
  await createQuestion(campaignId, {
    prompt,
    kind,
    required: formData.get("required") === "on",
    options,
    showWhen,
  });
  redirect(`/campaigns/${campaignId}?tab=content`);
}

async function removeQuestionAction(campaignId: string, formData: FormData) {
  "use server";
  await requireRole("editor");
  const id = String(formData.get("questionId"));
  if (id) await deleteQuestion(id, campaignId);
  redirect(`/campaigns/${campaignId}?tab=content`);
}

async function addAttachmentAction(campaignId: string, formData: FormData) {
  "use server";
  await requireRole("editor");
  const kindRaw = String(formData.get("kind") ?? "file");
  const kind = (ATTACHMENT_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as AttachmentKind) : "file";
  const label = String(formData.get("label") ?? "").trim();
  const url = String(formData.get("url") ?? "").trim();
  if (!label || !isSafeUrl(url)) redirect(`/campaigns/${campaignId}?tab=content&e=att`);
  await createAttachment(campaignId, { label, url, kind });
  redirect(`/campaigns/${campaignId}?tab=content`);
}

async function removeAttachmentAction(campaignId: string, formData: FormData) {
  "use server";
  await requireRole("editor");
  const id = String(formData.get("attachmentId"));
  if (id) await deleteAttachment(id, campaignId);
  redirect(`/campaigns/${campaignId}?tab=content`);
}

async function addDateAction(campaignId: string, formData: FormData) {
  "use server";
  await requireRole("editor");
  const startsAt = parseLocalInput(String(formData.get("startsAt") ?? ""));
  if (!startsAt) redirect(`/campaigns/${campaignId}?tab=content&e=date`);
  await createEventOption(campaignId, {
    startsAt: startsAt!,
    endsAt: parseLocalInput(String(formData.get("endsAt") ?? "")),
    label: String(formData.get("label") ?? "").trim() || null,
    venue: String(formData.get("venue") ?? "").trim() || null,
  });
  redirect(`/campaigns/${campaignId}?tab=content`);
}

async function removeDateAction(campaignId: string, formData: FormData) {
  "use server";
  await requireRole("editor");
  const id = String(formData.get("eventOptionId"));
  if (id) await deleteEventOption(id, campaignId);
  redirect(`/campaigns/${campaignId}?tab=content`);
}

// ---------- page ----------

export default async function CampaignWorkspace({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { tab?: string; page?: string; q?: string; invitee?: string; e?: string };
}) {
  if (!(await isAuthed())) redirect("/login");
  const me = await getCurrentUser();
  const canWrite = hasRole(me, "editor");
  const canDelete = hasRole(me, "admin");

  const campaign = await prisma.campaign.findUnique({ where: { id: params.id } });
  if (!campaign) notFound();

  const tabRaw = (searchParams.tab as Tab) ?? "invitees";
  const tab: Tab = (TABS as readonly string[]).includes(tabRaw) ? (tabRaw as Tab) : "invitees";

  // Everyone loads stats (cheap, drives header + tab counts).
  const stats = await campaignStats(campaign.id);

  // Send summary for the pre-send confirmation modal.
  const [withEmail, withPhone, alreadyEmailSent, alreadySmsSent] = await Promise.all([
    prisma.invitee.count({ where: { campaignId: campaign.id, email: { not: null } } }),
    prisma.invitee.count({ where: { campaignId: campaign.id, phoneE164: { not: null } } }),
    prisma.invitee.count({
      where: {
        campaignId: campaign.id,
        invitations: { some: { channel: "email", status: { in: ["sent", "delivered"] } } },
      },
    }),
    prisma.invitee.count({
      where: {
        campaignId: campaign.id,
        invitations: { some: { channel: "sms", status: { in: ["sent", "delivered"] } } },
      },
    }),
  ]);
  const sendSummary = {
    invited: stats.total,
    withEmail,
    withPhone,
    alreadyEmailSent,
    alreadySmsSent,
  };

  const pendingApprovalRow = await pendingApproval(campaign.id);
  const pendingRequester = pendingApprovalRow
    ? await prisma.user.findUnique({
        where: { id: pendingApprovalRow.requestedBy },
        select: { email: true },
      })
    : null;
  const atRisk = await liveFailureCount(campaign.id);

  // Per-tab data loaders. Only pay for what we render.
  const tabData = await loadForTab(campaign.id, tab, searchParams);

  const href = (t: Tab, extra?: Record<string, string>) => {
    const qs = new URLSearchParams({ tab: t, ...(extra ?? {}) });
    return `/campaigns/${campaign.id}?${qs.toString()}`;
  };
  const adminLocale = readAdminLocale();
  const tabsItems: TabItem[] = [
    { id: "invitees", label: adminLocale === "ar" ? "المدعوون" : "Invitees", href: href("invitees"), count: stats.total },
    { id: "schedule", label: adminLocale === "ar" ? "الجدول" : "Schedule", href: href("schedule"), count: tabData.scheduleCount },
    { id: "content", label: adminLocale === "ar" ? "المحتوى" : "Content", href: href("content"), count: tabData.contentCount },
    {
      id: "arrivals",
      label: adminLocale === "ar" ? "الحضور" : "Arrivals",
      href: href("arrivals"),
      count: stats.attending,
      hidden: stats.attending === 0,
    },
  ];

  // Drawer for the Invitees tab.
  const drawerInvitee =
    tab === "invitees" && searchParams.invitee
      ? await prisma.invitee.findUnique({
          where: { id: searchParams.invitee },
          include: {
            response: { include: { answers: true } },
            invitations: true,
          },
        })
      : null;
  const showDrawer = !!drawerInvitee && drawerInvitee.campaignId === campaign.id;
  const [drawerQuestions, drawerEventOptions] = showDrawer
    ? await Promise.all([
        prisma.campaignQuestion.findMany({
          where: { campaignId: campaign.id },
          orderBy: { order: "asc" },
        }),
        prisma.eventOption.findMany({
          where: { campaignId: campaign.id },
          orderBy: { startsAt: "asc" },
        }),
      ])
    : [[], []];

  const closeDrawerHref = (() => {
    const qs = new URLSearchParams({ tab: "invitees" });
    if (searchParams.q) qs.set("q", searchParams.q);
    if (searchParams.page && searchParams.page !== "1") qs.set("page", searchParams.page);
    return `/campaigns/${campaign.id}?${qs.toString()}`;
  })();

  return (
    <Shell
      title={campaign.name}
      crumb={<CampaignHeaderCrumb campaign={campaign} />}
      compactTitle
    >
      <div
        className={campaign.brandColor && /^#[0-9A-Fa-f]{3,8}$/.test(campaign.brandColor) ? "brand" : ""}
        style={
          campaign.brandColor && /^#[0-9A-Fa-f]{3,8}$/.test(campaign.brandColor)
            ? ({ ["--brand" as unknown as string]: campaign.brandColor } as React.CSSProperties)
            : undefined
        }
      >
      <CampaignHeader
        campaign={campaign}
        sendAction={sendAction}
        sendSummary={sendSummary}
        duplicateAction={duplicateAction.bind(null, campaign.id)}
        canWrite={canWrite}
        canDelete={canDelete}
        headcount={stats.headcount}
        invited={stats.total}
        responded={stats.responded}
      />
      {pendingApprovalRow ? (
        <div className="mb-6 max-w-4xl rounded-xl bg-signal-hold/10 border border-signal-hold/30 text-signal-hold px-4 py-3 flex items-center justify-between gap-4">
          <div className="text-body">
            An admin needs to approve this send — <span className="tabular-nums font-medium">{pendingApprovalRow.recipientCount.toLocaleString()} recipients</span> on <span className="uppercase">{pendingApprovalRow.channel}</span>.
            {pendingRequester?.email ? (
              <span className="text-mini text-ink-500 ms-2">Requested by {pendingRequester.email}</span>
            ) : null}
          </div>
          {canDelete ? (
            <Link href="/approvals" className="btn btn-soft text-mini">Review</Link>
          ) : (
            <span className="text-mini text-ink-500">Waiting on admin</span>
          )}
        </div>
      ) : null}
      {atRisk.total > 0 ? (
        <div className="mb-6 max-w-4xl rounded-xl bg-signal-fail/10 border border-signal-fail/30 text-signal-fail px-4 py-3 flex items-center justify-between gap-4">
          <div className="text-body">
            <span className="tabular-nums font-medium">{atRisk.total.toLocaleString()}</span>{" "}
            {atRisk.total === 1 ? "invitee isn't reachable" : "invitees aren't reachable"} —{" "}
            <span className="text-mini text-ink-500">
              {atRisk.email > 0 && atRisk.sms > 0
                ? `${atRisk.email} email · ${atRisk.sms} SMS still failing`
                : atRisk.email > 0
                  ? `${atRisk.email} email bouncing or rejected`
                  : `${atRisk.sms} SMS bouncing or rejected`}
            </span>
          </div>
          <Link
            href={`/deliverability?campaign=${campaign.id}`}
            className="btn btn-soft text-mini shrink-0"
          >
            Review &amp; retry
          </Link>
        </div>
      ) : null}
      <Tabs active={tab} items={tabsItems} />

      <div className="pt-8">
        {tab === "invitees" ? (
          <InviteesTab
            campaign={campaign}
            rows={tabData.rows ?? []}
            totalInvitees={tabData.totalInvitees ?? 0}
            page={tabData.page ?? 1}
            pageSize={PAGE_SIZE}
            searchQuery={tabData.searchQuery ?? ""}
            duplicatesCount={tabData.duplicatesCount ?? 0}
            stats={stats}
            selectedInviteeId={showDrawer ? drawerInvitee!.id : undefined}
            bulkResendAction={bulkResend.bind(null, campaign.id)}
            bulkDeleteAction={bulkDelete.bind(null, campaign.id)}
            canWrite={canWrite}
          />
        ) : null}

        {tab === "schedule" ? (
          <ScheduleTab
            campaignId={campaign.id}
            stages={tabData.stages ?? []}
            runNowAction={runStageAction.bind(null, campaign.id)}
            canWrite={canWrite}
          />
        ) : null}

        {tab === "content" ? (
          <ContentTab
            canWrite={canWrite}
            questions={tabData.questions ?? []}
            attachments={tabData.attachments ?? []}
            dates={tabData.dates ?? []}
            datePickCounts={tabData.datePickCounts ?? new Map()}
            addQuestionAction={addQuestionAction.bind(null, campaign.id)}
            removeQuestionAction={removeQuestionAction.bind(null, campaign.id)}
            addAttachmentAction={addAttachmentAction.bind(null, campaign.id)}
            removeAttachmentAction={removeAttachmentAction.bind(null, campaign.id)}
            addDateAction={addDateAction.bind(null, campaign.id)}
            removeDateAction={removeDateAction.bind(null, campaign.id)}
            error={CONTENT_ERROR[searchParams.e ?? ""] ?? null}
          />
        ) : null}

        {tab === "arrivals" && tabData.arrivalsFeed ? (
          <ArrivalsBoard
            campaignId={campaign.id}
            initial={tabData.arrivalsFeed}
            tz={TZ}
          />
        ) : null}
      </div>

      {showDrawer ? (
        <InviteePanel
          campaign={campaign}
          invitee={drawerInvitee!}
          response={drawerInvitee!.response ?? null}
          invitations={drawerInvitee!.invitations}
          questions={drawerQuestions}
          answers={drawerInvitee!.response?.answers ?? []}
          eventOptions={drawerEventOptions}
          closeHref={closeDrawerHref}
          appUrl={APP_URL}
          resendAction={singleResend.bind(null, campaign.id)}
          deleteAction={singleDelete.bind(null, campaign.id)}
        />
      ) : null}
      </div>
    </Shell>
  );
}

const CONTENT_ERROR: Record<string, string> = {
  qprompt: "Question prompt is required.",
  qopts: "This question kind needs at least one option.",
  att: "Attachment needs a label and a valid http(s) URL.",
  date: "Pick a valid start date/time.",
};

// Per-tab data loader — keeps the page function tidy.
type TabData = {
  // invitees
  rows?: Awaited<ReturnType<typeof loadInviteesRows>>["rows"];
  totalInvitees?: number;
  page?: number;
  searchQuery?: string;
  duplicatesCount?: number;
  // schedule
  stages?: Awaited<ReturnType<typeof listStages>>;
  scheduleCount?: number;
  // content
  questions?: Awaited<ReturnType<typeof prisma.campaignQuestion.findMany>>;
  attachments?: Awaited<ReturnType<typeof hydrateAttachments>>;
  dates?: Awaited<ReturnType<typeof prisma.eventOption.findMany>>;
  datePickCounts?: Map<string, number>;
  contentCount?: number;
  // arrivals
  arrivalsFeed?: {
    version: string;
    totals: { expected: number; arrived: number; pending: number; expectedGuests: number; arrivedGuests: number };
    rows: Array<{ id: string; name: string; title: string | null; organization: string | null; token: string; guestsCount: number; checkedInAt: string | null }>;
  } | null;
};

async function loadForTab(
  campaignId: string,
  tab: Tab,
  sp: { page?: string; q?: string },
): Promise<TabData> {
  // Always compute lightweight tab counts in parallel — they drive the tab
  // labels even when the user is looking at a different tab.
  const [scheduleCount, contentCount] = await Promise.all([
    prisma.campaignStage.count({ where: { campaignId } }),
    Promise.all([
      prisma.campaignQuestion.count({ where: { campaignId } }),
      prisma.campaignAttachment.count({ where: { campaignId } }),
      prisma.eventOption.count({ where: { campaignId } }),
    ]).then(([q, a, d]) => q + a + d),
  ]);

  if (tab === "invitees") {
    const { rows, totalInvitees, page, searchQuery } = await loadInviteesRows(campaignId, sp);
    const dups = await findDuplicates(campaignId);
    return { rows, totalInvitees, page, searchQuery, duplicatesCount: dups.length, scheduleCount, contentCount };
  }
  if (tab === "schedule") {
    const stages = await listStages(campaignId);
    return { stages, scheduleCount, contentCount };
  }
  if (tab === "content") {
    const [questions, rawAttachments, dates, datePickRows] = await Promise.all([
      prisma.campaignQuestion.findMany({ where: { campaignId }, orderBy: [{ order: "asc" }, { createdAt: "asc" }] }),
      prisma.campaignAttachment.findMany({ where: { campaignId }, orderBy: [{ order: "asc" }, { createdAt: "asc" }] }),
      prisma.eventOption.findMany({ where: { campaignId }, orderBy: [{ startsAt: "asc" }, { order: "asc" }] }),
      prisma.response.groupBy({
        by: ["eventOptionId"],
        where: { campaignId, eventOptionId: { not: null } },
        _count: { _all: true },
      }),
    ]);
    const attachments = await hydrateAttachments(rawAttachments);
    const datePickCounts = new Map(datePickRows.map((r) => [r.eventOptionId as string, r._count._all]));
    return { questions, attachments, dates, datePickCounts, scheduleCount, contentCount };
  }
  if (tab === "arrivals") {
    const [responses, agg, arrivedCount, arrivedGuestsAgg] = await Promise.all([
      prisma.response.findMany({
        where: { campaignId, attending: true },
        include: { invitee: { select: { fullName: true, title: true, organization: true, rsvpToken: true } } },
        orderBy: [{ checkedInAt: "desc" }, { respondedAt: "desc" }],
        take: 500,
      }),
      prisma.response.aggregate({
        where: { campaignId, attending: true },
        _sum: { guestsCount: true },
        _count: { _all: true },
        _max: { checkedInAt: true, respondedAt: true },
      }),
      prisma.response.count({ where: { campaignId, attending: true, checkedInAt: { not: null } } }),
      prisma.response.aggregate({
        where: { campaignId, attending: true, checkedInAt: { not: null } },
        _sum: { guestsCount: true },
      }),
    ]);
    const arrivalsFeed = {
      version: [
        agg._max.checkedInAt?.toISOString() ?? "",
        agg._max.respondedAt?.toISOString() ?? "",
        agg._count._all,
      ].join("|"),
      totals: {
        expected: agg._count._all,
        arrived: arrivedCount,
        pending: agg._count._all - arrivedCount,
        expectedGuests: agg._sum.guestsCount ?? 0,
        arrivedGuests: arrivedGuestsAgg._sum.guestsCount ?? 0,
      },
      rows: responses.map((r) => ({
        id: r.id,
        name: r.invitee.fullName,
        title: r.invitee.title,
        organization: r.invitee.organization,
        token: r.invitee.rsvpToken,
        guestsCount: r.guestsCount,
        checkedInAt: r.checkedInAt?.toISOString() ?? null,
      })),
    };
    return { arrivalsFeed, scheduleCount, contentCount };
  }
  return { scheduleCount, contentCount };
}

async function loadInviteesRows(campaignId: string, sp: { page?: string; q?: string }) {
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const q = (sp.q ?? "").trim();
  const where = {
    campaignId,
    ...(q
      ? {
          OR: [
            { fullName: { contains: q, mode: "insensitive" as const } },
            { email: { contains: q, mode: "insensitive" as const } },
            { phoneE164: { contains: q } },
            { organization: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };
  const [totalInvitees, invitees] = await Promise.all([
    prisma.invitee.count({ where }),
    prisma.invitee.findMany({
      where,
      include: { response: true, invitations: true },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);
  const rows = invitees.map((i) => ({
    id: i.id,
    fullName: i.fullName,
    title: i.title,
    organization: i.organization,
    email: i.email,
    phoneE164: i.phoneE164,
    guestsAllowed: i.guestsAllowed,
    emailSent: i.invitations.some((x) => x.channel === "email" && x.status !== "failed"),
    smsSent: i.invitations.some((x) => x.channel === "sms" && x.status !== "failed"),
    response: i.response
      ? { attending: i.response.attending, guestsCount: i.response.guestsCount }
      : null,
  }));
  return { rows, totalInvitees, page, searchQuery: q };
}

