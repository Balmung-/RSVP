import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Stat } from "@/components/Stat";
import { Badge } from "@/components/Badge";
import { Pagination } from "@/components/Pagination";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";
import { campaignStats, sendCampaign } from "@/lib/campaigns";

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

const statusTone = { draft: "wait", active: "live", sending: "hold", closed: "muted", archived: "muted" } as const;

export default async function CampaignDetail({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { page?: string; q?: string };
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

  const hrefFor = (p: number) => {
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    qs.set("page", String(p));
    return `/campaigns/${c.id}?${qs.toString()}`;
  };

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
          <a
            href={`/api/campaigns/${c.id}/export`}
            className="btn-ghost"
          >
            Export CSV
          </a>
          <Link href={`/campaigns/${c.id}/import`} className="btn-ghost">Import contacts</Link>
          <Link href={`/campaigns/${c.id}/duplicates`} className="btn-ghost">Duplicates</Link>
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

      <div className="panel rail overflow-hidden">
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Phone</th>
              <th scope="col">Channels</th>
              <th scope="col">Response</th>
              <th scope="col" className="text-right">Guests</th>
            </tr>
          </thead>
          <tbody>
            {invitees.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <div className="py-20 text-center text-ink-400">
                    {q ? "No matches." : (
                      <>
                        No invitees yet.{" "}
                        <Link href={`/campaigns/${c.id}/import`} className="text-ink-900 hover:underline">
                          Import a list
                        </Link>
                        .
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ) : (
              invitees.map((i) => {
                const emailSent = i.invitations.some((x) => x.channel === "email" && x.status !== "failed");
                const smsSent = i.invitations.some((x) => x.channel === "sms" && x.status !== "failed");
                const r = i.response;
                const tone = r ? (r.attending ? "live" : "fail") : "wait";
                const label = r ? (r.attending ? "attending" : "declined") : "pending";
                return (
                  <tr key={i.id}>
                    <td>
                      <div className="font-medium text-ink-900">{i.fullName}</div>
                      {i.title || i.organization ? (
                        <div className="text-xs text-ink-400 mt-0.5">
                          {[i.title, i.organization].filter(Boolean).join(" · ")}
                        </div>
                      ) : null}
                    </td>
                    <td className="text-ink-600">{i.email ?? <span className="text-ink-300">—</span>}</td>
                    <td className="text-ink-600 tabular-nums">{i.phoneE164 ?? <span className="text-ink-300">—</span>}</td>
                    <td>
                      <div className="flex items-center gap-2 text-xs text-ink-500">
                        <span className={emailSent ? "text-signal-live" : "text-ink-300"} title={emailSent ? "email sent" : "not sent"}>email</span>
                        <span className="text-ink-300">·</span>
                        <span className={smsSent ? "text-signal-live" : "text-ink-300"} title={smsSent ? "sms sent" : "not sent"}>sms</span>
                      </div>
                    </td>
                    <td>
                      <Badge tone={tone}>{label}</Badge>
                    </td>
                    <td className="text-right tabular-nums text-ink-600">
                      {r?.attending ? r.guestsCount : 0}
                      <span className="text-ink-300"> / {i.guestsAllowed}</span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={page} pageSize={PAGE_SIZE} total={totalInvitees} hrefFor={hrefFor} />
    </Shell>
  );
}
