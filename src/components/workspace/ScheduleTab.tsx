import Link from "next/link";
import type { CampaignStage } from "@prisma/client";
import { StageTimeline } from "@/components/StageTimeline";

export function ScheduleTab({
  campaignId,
  stages,
  runNowAction,
  canWrite,
}: {
  campaignId: string;
  stages: CampaignStage[];
  runNowAction: (fd: FormData) => Promise<void> | void;
  canWrite: boolean;
}) {
  if (!canWrite && stages.length === 0) {
    return (
      <div className="panel p-12 text-center text-sm text-ink-400 max-w-2xl mx-auto">
        No stages scheduled.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {canWrite ? (
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium tracking-tight text-ink-900">Send schedule</h3>
            <p className="text-xs text-ink-400 mt-1 max-w-lg">
              Queue invitations, reminders, last calls, and thank-yous to fire automatically.
              A cron worker wakes each stage at its scheduled time.
            </p>
          </div>
          <Link href={`/campaigns/${campaignId}/stages/new`} className="btn-primary text-xs">
            Add stage
          </Link>
        </div>
      ) : null}

      {stages.length === 0 ? (
        <div className="panel p-16 text-center">
          <p className="text-sm text-ink-500 max-w-sm mx-auto">
            No stages yet. Add one to automate the flow: invite → reminder → last call → thank-you.
          </p>
        </div>
      ) : (
        <div className="-mt-2">
          <StageTimeline campaignId={campaignId} stages={stages} runNowAction={runNowAction} />
        </div>
      )}
    </div>
  );
}
