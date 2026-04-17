import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/Badge";
import { prisma } from "@/lib/db";
import { getCurrentUser, hasRole, requireRole } from "@/lib/auth";
import { decideApproval, listPendingApprovals, approvalThreshold } from "@/lib/approvals";
import { setFlash } from "@/lib/flash";

export const dynamic = "force-dynamic";

const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
const fmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });

async function decide(formData: FormData) {
  "use server";
  const me = await requireRole("admin");
  const id = String(formData.get("id"));
  const decision = String(formData.get("decision")) as "approved" | "rejected";
  if (decision !== "approved" && decision !== "rejected") redirect("/approvals");
  const note = String(formData.get("note") ?? "").trim() || null;
  const res = await decideApproval(id, me.id, decision, note);
  if (!res.ok) {
    setFlash({ kind: "warn", text: "Couldn't decide", detail: (res as { reason?: string }).reason ?? "" });
  } else {
    setFlash({
      kind: decision === "approved" ? "success" : "info",
      text: decision === "approved" ? "Approved — sending" : "Send rejected",
    });
  }
  redirect("/approvals");
}

export default async function ApprovalsPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  if (!hasRole(me, "admin")) redirect("/");

  const approvals = await listPendingApprovals();

  // Resolve requester names in one round-trip.
  const requesterIds = Array.from(new Set(approvals.map((a) => a.requestedBy)));
  const requesters = await prisma.user.findMany({
    where: { id: { in: requesterIds } },
    select: { id: true, email: true, fullName: true },
  });
  const requesterMap = new Map(requesters.map((r) => [r.id, r]));

  return (
    <Shell
      title="Approvals"
      crumb={`Sends over ${approvalThreshold()} recipients`}
    >
      {approvals.length === 0 ? (
        <EmptyState icon="check" title="Nothing pending">
          Large sends land here for an admin to review before they fire. The
          threshold is {approvalThreshold().toLocaleString()} recipients — set{" "}
          <code className="text-ink-700">APPROVAL_THRESHOLD</code> to change it.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3 max-w-4xl">
          {approvals.map((a) => {
            const requester = requesterMap.get(a.requestedBy);
            return (
              <li key={a.id} className="panel p-5">
                <div className="flex items-start justify-between gap-6">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Icon name="send" size={14} className="text-ink-500" />
                      <Link
                        href={`/campaigns/${a.campaign.id}`}
                        className="text-sub text-ink-900 hover:underline"
                      >
                        {a.campaign.name}
                      </Link>
                      <Badge tone="hold">{a.channel === "both" ? "email + sms" : a.channel}</Badge>
                    </div>
                    <div className="text-body text-ink-700">
                      <span className="font-medium tabular-nums">
                        {a.recipientCount.toLocaleString()} recipients
                      </span>
                      <span className="text-ink-400 mx-2">·</span>
                      <span className="text-ink-500">
                        Requested by {requester?.fullName ?? requester?.email ?? "unknown"}
                      </span>
                      <span className="text-ink-400 mx-2">·</span>
                      <span className="text-ink-500 tabular-nums">{fmt.format(a.createdAt)}</span>
                    </div>
                    {a.note ? (
                      <p className="mt-2 text-body text-ink-600 whitespace-pre-wrap border-s-2 border-ink-200 ps-3">
                        {a.note}
                      </p>
                    ) : null}
                  </div>
                  <form action={decide} className="shrink-0 flex flex-col gap-2 items-stretch">
                    <input type="hidden" name="id" value={a.id} />
                    <div className="flex gap-2">
                      <button name="decision" value="approved" className="btn btn-primary text-mini">
                        <Icon name="check" size={12} />
                        Approve &amp; send
                      </button>
                      <button name="decision" value="rejected" className="btn btn-soft text-mini">
                        <Icon name="x" size={12} />
                        Reject
                      </button>
                    </div>
                  </form>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Shell>
  );
}
