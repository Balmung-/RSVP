import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Tabs, type TabItem } from "@/components/Tabs";
import { InviteePanel } from "@/components/InviteePanel";
import { ArrivalsBoard } from "@/components/ArrivalsBoard";
import { CampaignHeader, CampaignHeaderCrumb } from "@/components/workspace/CampaignHeader";
import { CampaignMessageSetup } from "@/components/workspace/CampaignMessageSetup";
import { CampaignPulse } from "@/components/workspace/CampaignPulse";
import { AttentionStrip, type AttentionItem } from "@/components/workspace/AttentionStrip";
import { campaignPulse } from "@/lib/pulse";
import { InviteesTab } from "@/components/workspace/InviteesTab";
import { ScheduleTab } from "@/components/workspace/ScheduleTab";
import { ContentTab } from "@/components/workspace/ContentTab";
import { prisma } from "@/lib/db";
import { requireRole, getCurrentUser, hasRole, requireActiveTenantId } from "@/lib/auth";
import {
  campaignStats,
  sendCampaign,
  resendSingle,
  resendSelection,
  deleteInvitee,
  findDuplicates,
  liveFailureCount,
  type SendCampaignChannel,
} from "@/lib/campaigns";
import { listStages, runStageNow, addStandardReminder } from "@/lib/stages";
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
import { canSeeCampaignRow } from "@/lib/teams";
import { buildArrivalsFeed } from "@/lib/arrivals";
import { hasWhatsAppTemplate, isChannelProviderEnabled } from "@/lib/channel-availability";
import { buildCampaignChannelReadiness } from "@/lib/channel-readiness";

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
  const channel = String(formData.get("channel") ?? "both") as SendCampaignChannel;
  if (!["email", "sms", "whatsapp", "both", "all"].includes(channel)) {
    redirect(`/campaigns/${id}`);
  }

  // Compute recipient count for the chosen channel. Same predicate as the
  // header's pre-send summary so the approval threshold check is honest.
  const [emailCount, smsCount] = await Promise.all([
    channel === "sms" || channel === "whatsapp"
      ? Promise.resolve(0)
      : prisma.invitee.count({
          where: {
            campaignId: id,
            email: { not: null },
            NOT: { invitations: { some: { channel: "email", status: { in: ["sent", "delivered"] } } } },
          },
        }),
    channel === "email" || channel === "whatsapp"
      ? Promise.resolve(0)
      : prisma.invitee.count({
          where: {
            campaignId: id,
            phoneE164: { not: null },
            NOT: { invitations: { some: { channel: "sms", status: { in: ["sent", "delivered"] } } } },
          },
        }),
  ]);
  const whatsappCount =
    channel === "email" || channel === "sms" || channel === "both"
      ? 0
      : await prisma.invitee.count({
          where: {
            campaignId: id,
            phoneE164: { not: null },
            NOT: { invitations: { some: { channel: "whatsapp", status: { in: ["sent", "delivered"] } } } },
          },
        });
  const recipients = emailCount + smsCount + whatsappCount;

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
  const channel = String(formData.get("channel")) as "email" | "sms" | "whatsapp";
  if (channel !== "email" && channel !== "sms" && channel !== "whatsapp") redirect(`/campaigns/${campaignId}?invitee=${inviteeId}`);
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
  const channel = String(formData.get("channel")) as "email" | "sms" | "whatsapp";
  if (ids.length === 0 || (channel !== "email" && channel !== "sms" && channel !== "whatsapp")) redirect(`/campaigns/${campaignId}`);
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

async function addReminderAction(campaignId: string, formData: FormData) {
  "use server";
  await requireRole("editor");
  const raw = Number(formData.get("hoursBefore"));
  // Must stay in sync with REMINDER_OFFSETS in ScheduleTab.tsx.
  const allowed = [1, 4, 24, 168] as const;
  const hours: number = (allowed as readonly number[]).includes(raw) ? raw : 24;
  const res = await addStandardReminder(campaignId, hours);
  if (!res.ok) {
    const msg =
      res.reason === "no_event_date"
        ? "Set an event date on the campaign first."
        : res.reason === "offset_in_past"
          ? `That offset lands in the past for this event.`
          : "A reminder already exists near that time.";
    setFlash({ kind: "warn", text: msg });
  } else {
    setFlash({
      kind: "success",
      text: `Reminder queued for ${hours}h before the event.`,
    });
  }
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
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const tenantId = requireActiveTenantId(me);
  const canWrite = hasRole(me, "editor");
  const canDelete = hasRole(me, "admin");

  const campaign = await prisma.campaign.findUnique({ where: { id: params.id } });
  if (!campaign) notFound();
  // Team isolation: when TEAMS_ENABLED, non-admins can only open
  // campaigns belonging to a team they're a member of or campaigns
  // with no team assignment (office-wide). 404 on a miss rather than
  // 403 — avoids leaking that a specific campaign exists. We pass
  // the already-loaded teamId to skip the extra DB roundtrip.
  if (!(await canSeeCampaignRow(me.id, canDelete, tenantId, campaign.tenantId, campaign.teamId))) notFound();

  const tabRaw = (searchParams.tab as Tab) ?? "invitees";
  const tab: Tab = (TABS as readonly string[]).includes(tabRaw) ? (tabRaw as Tab) : "invitees";

  // Everyone loads stats (cheap, drives header + tab counts).
  const stats = await campaignStats(campaign.id);

  // Send summary for the pre-send confirmation modal.
  const emailEnabled = isChannelProviderEnabled("email");
  const smsEnabled = isChannelProviderEnabled("sms");
  const whatsappEnabled =
    isChannelProviderEnabled("whatsapp") &&
    hasWhatsAppTemplate({
      templateWhatsAppName: campaign.templateWhatsAppName,
      templateWhatsAppLanguage: campaign.templateWhatsAppLanguage,
    });
  const [inviteesWithEmail, inviteesWithPhone, alreadyEmailSent, alreadySmsSent, alreadyWhatsAppSent] = await Promise.all([
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
    prisma.invitee.count({
      where: {
        campaignId: campaign.id,
        invitations: { some: { channel: "whatsapp", status: { in: ["sent", "delivered"] } } },
      },
    }),
  ]);
  const withEmail = emailEnabled ? inviteesWithEmail : 0;
  const withSms = smsEnabled ? inviteesWithPhone : 0;
  const withWhatsApp = whatsappEnabled ? inviteesWithPhone : 0;
  const sendSummary = {
    invited: stats.total,
    withEmail,
    withSms,
    withWhatsApp,
    alreadyEmailSent,
    alreadySmsSent,
    alreadyWhatsAppSent,
  };
  const messageSetup = buildCampaignChannelReadiness({
    campaign,
    providers: {
      emailEnabled,
      smsEnabled,
      whatsappEnabled: isChannelProviderEnabled("whatsapp"),
    },
    inviteesWithEmail,
    inviteesWithPhone,
  });

  const pendingApprovalRow = await pendingApproval(campaign.id);
  const pendingRequester = pendingApprovalRow
    ? await prisma.user.findUnique({
        where: { id: pendingApprovalRow.requestedBy },
        select: { email: true },
      })
    : null;
  const atRisk = await liveFailureCount(campaign.id);
  // Daily RSVP pulse for the sparkline. Seeded across 30 days so empty
  // days register as zero-height bars, not gaps.
  const pulse = await campaignPulse(campaign.id, 30);

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
      {/* Pulse + attention items live on one compressed band below the
          header: a continuous horizontal plane, no boxed banners. */}
      <div className="mb-5 flex flex-col gap-3">
        <CampaignPulse
          buckets={pulse}
          totalAttending={stats.attending}
          totalDeclined={stats.declined}
        />
        <AttentionStrip items={buildAttention({ campaign, pendingApprovalRow, pendingRequester, atRisk, canDelete })} />
      </div>
      <Tabs active={tab} items={tabsItems} />

      <div className="pt-8">
        <CampaignMessageSetup
          campaignId={campaign.id}
          channels={messageSetup}
          canWrite={canWrite}
        />
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
            eventAt={campaign.eventAt}
            runNowAction={runStageAction.bind(null, campaign.id)}
            addReminderAction={addReminderAction.bind(null, campaign.id)}
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

// Collapse the two possible attention rows into a single strip input.
// Approval first (action-needed), then at-risk (info-with-action).
function buildAttention(params: {
  campaign: { id: string };
  pendingApprovalRow: { recipientCount: number; channel: string } | null;
  pendingRequester: { email: string } | null;
  atRisk: { total: number; email: number; sms: number; whatsapp: number };
  canDelete: boolean;
}): AttentionItem[] {
  const out: AttentionItem[] = [];
  if (params.pendingApprovalRow) {
    out.push({
      key: "approval",
      tone: "warn",
      text: `Admin approval pending — ${params.pendingApprovalRow.recipientCount.toLocaleString()} on ${params.pendingApprovalRow.channel}`,
      detail: params.pendingRequester?.email
        ? `Requested by ${params.pendingRequester.email}`
        : null,
      action: params.canDelete ? { label: "Review", href: "/approvals" } : null,
    });
  }
  if (params.atRisk.total > 0) {
    // P13-D.3 — build the "X email · Y SMS · Z WhatsApp failing" detail
    // line dynamically over the per-channel breakdown so we don't have
    // to enumerate every 2^3 combination by hand. Each non-zero channel
    // contributes one segment; the segments join with " · " for the
    // multi-channel case. Single-channel case retains the shorter
    // "N <channel> bouncing" wording the pre-P13 UX pinned.
    const segments = [
      params.atRisk.email > 0 ? `${params.atRisk.email} email` : null,
      params.atRisk.sms > 0 ? `${params.atRisk.sms} SMS` : null,
      params.atRisk.whatsapp > 0 ? `${params.atRisk.whatsapp} WhatsApp` : null,
    ].filter((s): s is string => s !== null);
    const detail =
      segments.length > 1
        ? `${segments.join(" · ")} failing`
        : segments.length === 1
          ? `${segments[0]} bouncing`
          : // Shouldn't reach here — total > 0 implies at least one
            // segment — but keep a safe fallback so a rogue unknown
            // channel (e.g. a legacy "telegram" row) doesn't crash
            // the server render.
            `${params.atRisk.total} failing`;
    out.push({
      key: "atrisk",
      tone: "fail",
      text: `${params.atRisk.total.toLocaleString()} ${params.atRisk.total === 1 ? "invitee isn't reachable" : "invitees aren't reachable"}`,
      detail,
      action: { label: "Review & retry", href: `/deliverability?campaign=${params.campaign.id}` },
    });
  }
  return out;
}

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
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true,
        templateWhatsAppName: true,
        templateWhatsAppLanguage: true,
      },
    });
    if (!campaign) {
      return { rows: [], totalInvitees: 0, page: 1, searchQuery: sp.q ?? "", duplicatesCount: 0, scheduleCount, contentCount };
    }
    const { rows, totalInvitees, page, searchQuery } = await loadInviteesRows(campaign, sp);
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
    const arrivalsFeed = await buildArrivalsFeed(campaignId);
    return { arrivalsFeed, scheduleCount, contentCount };
  }
  return { scheduleCount, contentCount };
}

async function loadInviteesRows(
  campaign: { id: string; templateWhatsAppName: string | null; templateWhatsAppLanguage: string | null },
  sp: { page?: string; q?: string },
) {
  const emailEnabled = isChannelProviderEnabled("email");
  const smsEnabled = isChannelProviderEnabled("sms");
  const whatsappEnabled =
    isChannelProviderEnabled("whatsapp") &&
    hasWhatsAppTemplate({
      templateWhatsAppName: campaign.templateWhatsAppName,
      templateWhatsAppLanguage: campaign.templateWhatsAppLanguage,
    });
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const q = (sp.q ?? "").trim();
  const where = {
    campaignId: campaign.id,
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
    emailAvailable: emailEnabled && !!i.email,
    smsAvailable: smsEnabled && !!i.phoneE164,
    whatsappAvailable: whatsappEnabled && !!i.phoneE164,
    emailSent: i.invitations.some((x) => x.channel === "email" && x.status !== "failed"),
    smsSent: i.invitations.some((x) => x.channel === "sms" && x.status !== "failed"),
    whatsappSent: i.invitations.some((x) => x.channel === "whatsapp" && x.status !== "failed"),
    response: i.response
      ? { attending: i.response.attending, guestsCount: i.response.guestsCount }
      : null,
  }));
  return { rows, totalInvitees, page, searchQuery: q };
}
