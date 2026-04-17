import Link from "next/link";
import type { CampaignStage } from "@prisma/client";
import { StageTimeline } from "@/components/StageTimeline";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";

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
  if (stages.length === 0) {
    return (
      <EmptyState
        icon="clock"
        title="No stages scheduled"
        action={
          canWrite
            ? { label: "Add the first stage", href: `/campaigns/${campaignId}/stages/new` }
            : undefined
        }
      >
        Stages fire automatically. Chain them to build the flow:
        invitation → reminder → last call → thank-you.
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {canWrite ? (
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sub text-ink-900">Send schedule</h2>
            <p className="text-body text-ink-500 mt-1 max-w-lg">
              Queue invitations, reminders, last calls, and thank-yous to fire automatically.
              The cron worker wakes each stage at its scheduled time.
            </p>
          </div>
          <Link href={`/campaigns/${campaignId}/stages/new`} className="btn btn-primary">
            <Icon name="plus" size={14} />
            Add stage
          </Link>
        </div>
      ) : null}

      <StageTimeline campaignId={campaignId} stages={stages} runNowAction={runNowAction} />
    </div>
  );
}
