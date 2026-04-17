import Link from "next/link";
import type { CampaignStage } from "@prisma/client";
import { Badge } from "./Badge";

const TZ = process.env.APP_TIMEZONE ?? "Asia/Riyadh";
const fmt = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: TZ });

const tone = {
  pending: "wait",
  running: "hold",
  completed: "live",
  failed: "fail",
  skipped: "muted",
} as const;

// Horizontal rail of stages. Each stage is a row; running + past stages show
// stats, future stages show when they fire. Add/edit live here too.
export function StageTimeline({
  campaignId,
  stages,
  runNowAction,
}: {
  campaignId: string;
  stages: CampaignStage[];
  runNowAction: (fd: FormData) => Promise<void> | void;
}) {
  return (
    <section className="mt-10">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-medium tracking-tight text-ink-900">Schedule</h3>
          <p className="text-xs text-ink-400">Stages fire automatically at their scheduled time.</p>
        </div>
        <Link href={`/campaigns/${campaignId}/stages/new`} className="btn-ghost text-xs">
          Add stage
        </Link>
      </div>
      {stages.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-ink-400">
          No stages scheduled. Add one to automate invitations, reminders, last-calls, and thank-yous.
        </div>
      ) : (
        <ol className="panel divide-y divide-ink-100 overflow-hidden">
          {stages.map((s) => {
            const t = (tone[s.status as keyof typeof tone] ?? "muted") as "wait" | "hold" | "live" | "fail" | "muted";
            const channels = s.channels.split(",").filter(Boolean);
            const total = s.sentCount + s.skippedCount + s.failedCount;
            return (
              <li key={s.id} className="flex items-center gap-6 px-6 py-4 hover:bg-ink-50">
                <div className="w-40 shrink-0">
                  <div className="text-xs uppercase tracking-wider text-ink-400">{s.kind.replace("_", " ")}</div>
                  <div className="text-sm font-medium text-ink-900">{s.name || titleCase(s.kind)}</div>
                </div>
                <div className="w-48 shrink-0 text-sm text-ink-600 tabular-nums">
                  {fmt.format(s.scheduledFor)}
                </div>
                <div className="flex-1 flex items-center gap-3 text-xs text-ink-500">
                  <span>audience · <span className="text-ink-700">{s.audience.replace("_", " ")}</span></span>
                  <span className="text-ink-300">·</span>
                  <span>{channels.join(" · ")}</span>
                  {total > 0 ? (
                    <>
                      <span className="text-ink-300">·</span>
                      <span className="tabular-nums">
                        <span className="text-signal-live">{s.sentCount} sent</span>
                        {s.skippedCount > 0 ? <> · <span className="text-ink-400">{s.skippedCount} skipped</span></> : null}
                        {s.failedCount > 0 ? <> · <span className="text-signal-fail">{s.failedCount} failed</span></> : null}
                      </span>
                    </>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  <Badge tone={t}>{s.status}</Badge>
                  {s.status === "pending" ? (
                    <form action={runNowAction}>
                      <input type="hidden" name="stageId" value={s.id} />
                      <button className="btn-ghost text-xs !px-2 !py-1">Run now</button>
                    </form>
                  ) : null}
                  <Link
                    href={`/campaigns/${campaignId}/stages/${s.id}/edit`}
                    className="btn-ghost text-xs !px-2 !py-1"
                  >
                    {s.status === "completed" || s.status === "running" ? "View" : "Edit"}
                  </Link>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function titleCase(s: string) {
  return s.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
