import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Stat } from "@/components/Stat";
import { Badge } from "@/components/Badge";
import { Pagination } from "@/components/Pagination";
import { InviteeTable } from "@/components/InviteeTable";
import { InviteePanel } from "@/components/InviteePanel";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";
import {
  campaignStats,
  sendCampaign,
  resendSingle,
  resendSelection,
  deleteInvitee,
} from "@/lib/campaigns";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

async function sendAction(formData: FormData) {
  "use server";
  if (!isAuthed()) redirect("/login");
  const id = String(formData.get("id"));
  const channel = String(formData.get("channel") ?? "both") as "email" | "sms" | "both";
  await sendCampaign(id, { channel, onlyUnsent: true });
  redirect(`/campaigns/${id}`);
}

async function setStatus(formData: FormData) {
  "use server";
  if (!isAuthed()) redirect("/login");
  const id = String(formData.get("id"));
  const raw = String(formData.get("status"));
  const status = ["draft", "active", "closed", "archived"].includes(raw) ? raw : "draft";
  await prisma.campaign.update({ where: { id }, data: { status } });
  redirect(`/campaigns/${id}`);
}

async function singleResend(campaignId: string, formData: FormData) {
  "use server";
  if (!isAuthed()) redirect("/login");
  const inviteeId = String(formData.get("inviteeId"));
  const channel = String(formData.get("channel")) as "email" | "sms";
  if (channel !== "email" && channel !== "sms") redirect(`/campaigns/${campaignId}?invitee=${inviteeId}`);
  await resendSingle(campaignId, inviteeId, channel);
  redirect(`/campaigns/${campaignId}?invitee=${inviteeId}`);
}

async function singleDelete(campaignId: string, formData: FormData) {
  "use server";
  if (!isAuthed()) redirect("/login");
  const inviteeId = String(formData.get("inviteeId"));
  await deleteInvitee(campaignId, inviteeId);
  redirect(`/campaigns/${campaignId}`);
}

async function bulkResend(campaignId: string, formData: FormData) {
  "use server";
  if (!isAuthed()) redirect("/login");
  const ids = formData.getAll("id").map(String).filter(Boolean);
  const channel = String(formData.get("channel")) as "email" | "sms";
  if (ids.length === 0 || (channel !== "email" && channel !== "sms")) redirect(`/campaigns/${campaignId}`);
  await resendSelection(campaignId, ids, { channels: [channel], onlyUnsent: false });
  redirect(`/campaigns/${campaignId}`);
}

async function bulkDelete(campaignId: string, formData: FormData) {
  "use server";
  if (!isAuthed()) redirect("/login");
  const ids = formData.getAll("id").map(String).filter(Boolean);
  if (ids.length === 0) redirect(`/campaigns/${campaignId}`);
  await prisma.invitee.deleteMany({ where: { campaignId, id: { in: ids } } });
  redirect(`/campaigns/${campaignId}`);
}

const statusTone = {
  draft: "wait",
  active: "live",
  sending: "hold",
  closed: "muted",
  archived: "muted",
} as const;

export default async function CampaignDetail({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { page?: string; q?: string; invitee?: string };
}) {
  if (!isAuthed()) redirect("/login");
  const c = await prisma.campaign.findUnique({ where: { id: params.id } });
  if (!c) notFound();

  const page = Math.max(1, parseInt(searchParams.page ?? "1", 10) || 1);
  const q = (searchParams.q ?? "").trim();
  const where = {
    campaignId: c.id,
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

  const [stats, totalInvitees, invitees] = await Promise.all([
    campaignStats(c.id),
    prisma.invitee.count({ where }),
    prisma.invitee.findMany({
      where,
      include: { response: true, invitations: true },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  // Drawer payload (separate query because the selected invitee may be on a
  // different page than the current table view).
  const drawerInvitee = searchParams.invitee
    ? await prisma.invitee.findUnique({
        where: { id: searchParams.invitee },
        include: { response: true, invitations: true },
      })
    : null;
  const showDrawer = drawerInvitee && drawerInvitee.campaignId === c.id;

  const hrefFor = (p: number) => {
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    qs.set("page", String(p));
    return `/campaigns/${c.id}?${qs.toString()}`;
  };
  const baseHref = (() => {
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    if (page !== 1) qs.set("page", String(page));
    const s = qs.toString();
    return `/campaigns/${c.id}?${s ? s + "&" : ""}`;
  })();
  const closeDrawerHref = (() => {
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    if (page !== 1) qs.set("page", String(page));
    return `/campaigns/${c.id}${qs.toString() ? "?" + qs.toString() : ""}`;
  })();

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

  const singleResendBound = singleResend.bind(null, c.id);
  const singleDeleteBound = singleDelete.bind(null, c.id);
  const bulkResendBound = bulkResend.bind(null, c.id);
  const bulkDeleteBound = bulkDelete.bind(null, c.id);

  return (
    <Shell
      title={c.name}
      crumb={
        <span>
          <Link href="/" className="hover:underline">Campaigns</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>{c.name}</span>
        </span>
      }
      actions={
        <>
          <Link href={`/campaigns/${c.id}/edit`} className="btn-ghost">Edit</Link>
          <Link href={`/campaigns/${c.id}/invitees/new`} className="btn-ghost">Add invitee</Link>
          <Link href={`/campaigns/${c.id}/import`} className="btn-ghost">Import</Link>
          <Link href={`/campaigns/${c.id}/duplicates`} className="btn-ghost">Duplicates</Link>
          <Link href={`/campaigns/${c.id}/test`} className="btn-ghost">Test send</Link>
          <a href={`/api/campaigns/${c.id}/export`} className="btn-ghost">Export</a>
          <form action={sendAction} className="inline-flex items-center gap-2">
            <input type="hidden" name="id" value={c.id} />
            <label className="sr-only" htmlFor="send-channel">Channel</label>
            <select id="send-channel" name="channel" className="field !py-1.5 !px-3 !text-sm" defaultValue="both">
              <option value="both">Email & SMS</option>
              <option value="email">Email only</option>
              <option value="sms">SMS only</option>
            </select>
            <button className="btn-primary" disabled={c.status === "sending"}>
              {c.status === "sending" ? "Sending…" : "Send invitations"}
            </button>
          </form>
        </>
      }
    >
      <div className="grid grid-cols-[1fr_auto] gap-6 items-end mb-8">
        <div className="grid grid-cols-6 gap-8">
          <Stat label="Invited" value={stats.total} />
          <Stat
            label="Responded"
            value={stats.responded}
            hint={stats.total ? `${Math.round((stats.responded / stats.total) * 100)}%` : ""}
          />
          <Stat label="Attending" value={stats.attending} />
          <Stat label="Declined" value={stats.declined} />
          <Stat label="Guests +" value={stats.guests} />
          <Stat label="Headcount" value={stats.headcount} />
        </div>
        <div className="flex items-center gap-3">
          <Badge tone={statusTone[c.status as keyof typeof statusTone] ?? "muted"}>{c.status}</Badge>
          <form action={setStatus} className="contents">
            <input type="hidden" name="id" value={c.id} />
            <label className="sr-only" htmlFor="status-select">Status</label>
            <select id="status-select" name="status" className="field !py-1.5 !px-3 !text-sm" defaultValue={c.status}>
              <option value="draft">Draft</option>
              <option value="active">Active</option>
              <option value="closed">Closed</option>
              <option value="archived">Archived</option>
            </select>
            <button className="btn-ghost !px-3">Set</button>
          </form>
        </div>
      </div>

      <form method="get" className="mb-4">
        <label className="sr-only" htmlFor="invitee-search">Search invitees</label>
        <input
          id="invitee-search"
          name="q"
          defaultValue={q}
          placeholder="Search name, email, phone, organization"
          className="field max-w-md"
        />
      </form>

      <InviteeTable
        invitees={rows}
        baseHref={baseHref}
        selectedInviteeId={showDrawer ? drawerInvitee!.id : undefined}
        resendBulkAction={bulkResendBound}
        deleteBulkAction={bulkDeleteBound}
      />
      <Pagination page={page} pageSize={PAGE_SIZE} total={totalInvitees} hrefFor={hrefFor} />

      {showDrawer ? (
        <InviteePanel
          campaign={c}
          invitee={drawerInvitee!}
          response={drawerInvitee!.response ?? null}
          invitations={drawerInvitee!.invitations}
          closeHref={closeDrawerHref}
          appUrl={process.env.APP_URL ?? ""}
          resendAction={singleResendBound}
          deleteAction={singleDeleteBound}
        />
      ) : null}
    </Shell>
  );
}
