import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Badge } from "@/components/Badge";
import { getCurrentUser, requireRole } from "@/lib/auth";
import { findCheckInByToken, markArrived, undoArrived } from "@/lib/checkin";
import { rateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
const fmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });

async function confirmArrival(token: string) {
  "use server";
  const me = await requireRole("editor");
  const rl = rateLimit(`checkin:${me.id}`, { capacity: 20, refillPerSec: 1 });
  if (!rl.ok) redirect(`/checkin/${token}?e=rate`);
  await markArrived(token, me.id);
  redirect(`/checkin/${token}?done=1`);
}

async function undo(token: string) {
  "use server";
  const me = await requireRole("editor");
  const rl = rateLimit(`checkin:${me.id}`, { capacity: 20, refillPerSec: 1 });
  if (!rl.ok) redirect(`/checkin/${token}?e=rate`);
  await undoArrived(token, me.id);
  redirect(`/checkin/${token}`);
}

export default async function CheckIn({
  params,
  searchParams,
}: {
  params: { token: string };
  searchParams: { done?: string; e?: string };
}) {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?returnTo=${encodeURIComponent(`/checkin/${params.token}`)}`);
  const inv = await findCheckInByToken(params.token);
  if (!inv) notFound();

  const resp = inv.response;
  const isAttending = !!resp?.attending;
  const arrived = !!resp?.checkedInAt;
  const confirmBound = confirmArrival.bind(null, params.token);
  const undoBound = undo.bind(null, params.token);
  const showDone = searchParams.done === "1" || arrived;
  const rateLimited = (searchParams as { e?: string }).e === "rate";

  return (
    <Shell
      title="Check-in"
      crumb={
        <span>
          <Link href={`/campaigns/${inv.campaignId}`} className="hover:underline">{inv.campaign.name}</Link>
          <span className="mx-1.5 text-ink-300">/</span>
          <span>Arrival</span>
        </span>
      }
      actions={
        <Link href={`/campaigns/${inv.campaignId}/arrivals`} className="btn-ghost">
          Board
        </Link>
      }
    >
      <div className="panel max-w-xl p-10 mx-auto text-center">
        <div className="text-xs uppercase tracking-wider text-ink-400 mb-3">{inv.campaign.name}</div>
        <h2 className="text-2xl font-medium tracking-tightest text-ink-900">
          {inv.title ? <span className="text-ink-500">{inv.title} </span> : null}
          {inv.fullName}
        </h2>
        {inv.organization ? <p className="text-sm text-ink-500 mt-1">{inv.organization}</p> : null}

        <div className="mt-8 flex items-center justify-center gap-3">
          {!resp ? (
            <Badge tone="wait">No response</Badge>
          ) : !isAttending ? (
            <Badge tone="fail">Declined</Badge>
          ) : arrived ? (
            <Badge tone="live">Arrived</Badge>
          ) : (
            <Badge tone="hold">Expected</Badge>
          )}
          {isAttending && resp && resp.guestsCount > 0 ? (
            <span className="text-sm text-ink-600">+ {resp.guestsCount} guest{resp.guestsCount === 1 ? "" : "s"}</span>
          ) : null}
        </div>

        {arrived && resp?.checkedInAt ? (
          <p className="text-xs text-ink-400 mt-3 tabular-nums">Arrived {fmt.format(resp.checkedInAt)}</p>
        ) : null}

        {rateLimited ? (
          <p role="alert" className="text-xs text-signal-fail mt-3">
            Too many check-ins in a short window. Take a breath and try again.
          </p>
        ) : null}

        <div className="mt-10 flex items-center justify-center gap-3">
          {!resp || !isAttending ? (
            <Link href={`/campaigns/${inv.campaignId}/arrivals`} className="btn-ghost">
              Back to board
            </Link>
          ) : showDone ? (
            <>
              <form action={undoBound}>
                <button className="btn-ghost text-xs">Undo arrival</button>
              </form>
              <Link href={`/campaigns/${inv.campaignId}/arrivals`} className="btn-primary">
                Next arrival
              </Link>
            </>
          ) : (
            <form action={confirmBound} className="w-full">
              <button className="btn-primary w-full py-4 text-base">Mark arrived</button>
            </form>
          )}
        </div>

        <p className="text-xs text-ink-400 mt-6">
          Signed in as {user.email} · {user.role}
        </p>
      </div>
    </Shell>
  );
}
