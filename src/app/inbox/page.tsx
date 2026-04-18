import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/Badge";
import { Icon } from "@/components/Icon";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole, requireRole } from "@/lib/auth";
import { scopedCampaignWhere } from "@/lib/teams";
import { applyReviewerDecision } from "@/lib/inbound";
import { setFlash } from "@/lib/flash";
import { FilterPill, FilterLabel } from "@/components/FilterPill";

export const dynamic = "force-dynamic";

const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
const fmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });

async function decide(formData: FormData) {
  "use server";
  const me = await requireRole("editor");
  const id = String(formData.get("id"));
  const decision = String(formData.get("decision")) as
    | "apply_attending"
    | "apply_declined"
    | "unsubscribe"
    | "ignore";
  // Team scope: reviewer can only act on messages tied to a campaign
  // they can see. Messages with no linked invitee (sender couldn't be
  // matched) stay open to any editor — they're not team-owned.
  const msg = await prisma.inboundMessage.findUnique({
    where: { id },
    select: { invitee: { select: { campaign: { select: { teamId: true } } } } },
  });
  if (msg?.invitee?.campaign) {
    const { canSeeCampaignRow } = await import("@/lib/teams");
    if (!(await canSeeCampaignRow(me.id, hasRole(me, "admin"), msg.invitee.campaign.teamId))) {
      setFlash({ kind: "warn", text: "You don't have access to that campaign." });
      redirect("/inbox");
    }
  }
  const res = await applyReviewerDecision(id, decision);
  setFlash({
    kind: res.ok ? "success" : "warn",
    text: res.ok ? "Message resolved" : "Couldn't apply — message kept in review",
    detail: res.ok ? undefined : (res as { reason?: string }).reason ?? undefined,
  });
  redirect("/inbox");
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: { status?: string };
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/login");

  const status = searchParams.status === "all"
    ? undefined
    : searchParams.status === "processed"
      ? "processed"
      : searchParams.status === "ignored"
        ? "ignored"
        : "needs_review";

  // Team scope: show only inbound messages whose linked invitee is in
  // a campaign the viewer can see, OR messages with no matched invitee
  // (orphan inbound — any editor can pick these up). Admins see every
  // message. Keying off isAdmin directly (not Object.keys on the
  // scope object) keeps the branch unambiguous.
  const isAdmin = hasRole(me, "admin");
  const scopeFilter = isAdmin
    ? {}
    : {
        OR: [
          { inviteeId: null },
          { invitee: { campaign: await scopedCampaignWhere(me.id, false) } },
        ],
      };

  const [rows, counts] = await Promise.all([
    prisma.inboundMessage.findMany({
      where: { ...(status ? { status } : {}), ...scopeFilter },
      include: { invitee: { select: { id: true, fullName: true, campaignId: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.inboundMessage.groupBy({
      by: ["status"],
      _count: { _all: true },
      where: scopeFilter,
    }),
  ]);

  const countMap = new Map(counts.map((c) => [c.status, c._count._all]));

  return (
    <Shell
      title="Inbox"
      crumb="Inbound replies"
    >
      {/* One strip, pills only — the inbox has a single filter axis so
          this is the shortest of the list-page strips. Counts live
          inline on each pill so the operator sees the queue shape
          without drilling. */}
      <div className="mb-6 flex items-center gap-3 flex-wrap">
        <FilterLabel>Queue</FilterLabel>
        <div className="flex items-center gap-1">
          <FilterPill href="/inbox?status=needs_review" active={status === "needs_review"}>
            Needs review · {countMap.get("needs_review") ?? 0}
          </FilterPill>
          <FilterPill href="/inbox?status=processed" active={status === "processed"}>
            Processed · {countMap.get("processed") ?? 0}
          </FilterPill>
          <FilterPill href="/inbox?status=ignored" active={status === "ignored"}>
            Ignored · {countMap.get("ignored") ?? 0}
          </FilterPill>
          <FilterPill href="/inbox?status=all" active={!status}>All</FilterPill>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon="inbox" title="Inbox is clear">
          Email and SMS replies from invitees land here. When intent is unambiguous
          (&ldquo;yes&rdquo;, &ldquo;regret&rdquo;, &ldquo;stop&rdquo;) we apply it
          automatically; everything else waits for a reviewer.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3 max-w-4xl">
          {rows.map((m) => (
            <li key={m.id} className="panel p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Icon name={m.channel === "email" ? "mail" : "message"} size={14} className="text-ink-500" />
                    <span className="text-body text-ink-900">
                      {m.invitee ? (
                        <Link
                          href={`/campaigns/${m.invitee.campaignId}?invitee=${m.invitee.id}`}
                          className="hover:underline"
                        >
                          {m.invitee.fullName}
                        </Link>
                      ) : (
                        <span>Unmatched sender</span>
                      )}
                    </span>
                    <span className="text-mini text-ink-400">{m.fromAddress}</span>
                    <IntentBadge intent={m.intent} />
                    <StatusBadge status={m.status} />
                  </div>
                  {m.subject ? <div className="text-mini text-ink-500">{m.subject}</div> : null}
                  <p className="text-body text-ink-700 mt-2 whitespace-pre-wrap max-h-40 overflow-auto">{m.body}</p>
                  {m.note ? (
                    <p className="text-mini text-ink-400 mt-2 italic">{m.note}</p>
                  ) : null}
                  <div className="text-mini text-ink-400 mt-2 tabular-nums">{fmt.format(m.createdAt)}</div>
                </div>
                {m.status === "needs_review" ? (
                  <div className="shrink-0 flex items-center gap-2">
                    <form action={decide}>
                      <input type="hidden" name="id" value={m.id} />
                      <input type="hidden" name="decision" value="apply_attending" />
                      <button className="btn btn-soft text-mini" disabled={!m.invitee}>
                        <Icon name="check" size={12} /> Attending
                      </button>
                    </form>
                    <form action={decide}>
                      <input type="hidden" name="id" value={m.id} />
                      <input type="hidden" name="decision" value="apply_declined" />
                      <button className="btn btn-soft text-mini" disabled={!m.invitee}>
                        <Icon name="x" size={12} /> Declined
                      </button>
                    </form>
                    <form action={decide}>
                      <input type="hidden" name="id" value={m.id} />
                      <input type="hidden" name="decision" value="unsubscribe" />
                      <button className="btn btn-ghost text-mini">Unsubscribe</button>
                    </form>
                    <form action={decide}>
                      <input type="hidden" name="id" value={m.id} />
                      <input type="hidden" name="decision" value="ignore" />
                      <button className="btn btn-ghost text-mini">Ignore</button>
                    </form>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}


function IntentBadge({ intent }: { intent: string }) {
  const tone =
    intent === "attending" ? "live"
    : intent === "declined" ? "fail"
    : intent === "stop" ? "hold"
    : intent === "autoreply" ? "muted"
    : "wait";
  return <Badge tone={tone}>{intent}</Badge>;
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "processed" ? "live"
    : status === "needs_review" ? "hold"
    : status === "ignored" ? "muted"
    : "wait";
  return <Badge tone={tone}>{status.replace("_", " ")}</Badge>;
}
