import { prisma } from "./db";
import { sendEmail, sendSms } from "./delivery";
import { notifyAdmins } from "./notify";
import type { Campaign, CampaignStage, Prisma } from "@prisma/client";

export const STAGE_KINDS = ["invite", "reminder", "last_call", "thanks", "custom"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export const AUDIENCE_KINDS = ["all", "non_responders", "attending", "declined"] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];

export const CHANNELS = ["email", "sms"] as const;
export type Channel = (typeof CHANNELS)[number];

function normalizeChannels(raw: string | null | undefined): Channel[] {
  const parts = (raw ?? "email,sms").split(",").map((s) => s.trim().toLowerCase());
  return CHANNELS.filter((c) => parts.includes(c));
}

// Who receives this stage? The audience is resolved at fire time against the
// current invitee list + response state — so a reminder stage "non_responders"
// picks up whoever is still pending when the stage fires, not who was pending
// at create time.
function audienceWhere(campaignId: string, kind: AudienceKind): Prisma.InviteeWhereInput {
  switch (kind) {
    case "all":
      return { campaignId };
    case "non_responders":
      return { campaignId, response: { is: null } };
    case "attending":
      return { campaignId, response: { is: { attending: true } } };
    case "declined":
      return { campaignId, response: { is: { attending: false } } };
  }
}

// CRUD ------------------------------------------------------------

export type StageInput = {
  kind: StageKind;
  name?: string | null;
  scheduledFor: Date;
  channels: Channel[];
  audience: AudienceKind;
  subjectEmail?: string | null;
  templateEmail?: string | null;
  templateSms?: string | null;
};

export async function createStage(campaignId: string, input: StageInput) {
  const max = await prisma.campaignStage.findFirst({
    where: { campaignId },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  return prisma.campaignStage.create({
    data: {
      campaignId,
      kind: input.kind,
      name: input.name ?? null,
      order: (max?.order ?? -1) + 1,
      scheduledFor: input.scheduledFor,
      channels: input.channels.join(","),
      audience: input.audience,
      subjectEmail: input.subjectEmail ?? null,
      templateEmail: input.templateEmail ?? null,
      templateSms: input.templateSms ?? null,
    },
  });
}

export async function updateStage(
  stageId: string,
  campaignId: string,
  input: StageInput,
) {
  const res = await prisma.campaignStage.updateMany({
    where: { id: stageId, campaignId, status: { in: ["pending", "failed", "skipped"] } },
    data: {
      kind: input.kind,
      name: input.name ?? null,
      scheduledFor: input.scheduledFor,
      channels: input.channels.join(","),
      audience: input.audience,
      subjectEmail: input.subjectEmail ?? null,
      templateEmail: input.templateEmail ?? null,
      templateSms: input.templateSms ?? null,
    },
  });
  return { updated: res.count > 0 };
}

// Delete only if not currently running. A running stage deletion would strand
// the dispatcher mid-loop (the final status UPDATE would throw RecordNotFound)
// and leak invitations with no audit trail.
export async function deleteStage(stageId: string, campaignId: string) {
  const res = await prisma.campaignStage.deleteMany({
    where: { id: stageId, campaignId, status: { not: "running" } },
  });
  return { deleted: res.count > 0 };
}

export async function listStages(campaignId: string) {
  return prisma.campaignStage.findMany({
    where: { campaignId },
    orderBy: [{ scheduledFor: "asc" }, { order: "asc" }],
  });
}

// Dispatch --------------------------------------------------------

// Atomically claim a stage (CAS from pending → running). Returns the claimed
// row or null if another worker already took it. Safe under concurrent cron.
async function claimStage(stageId: string) {
  const res = await prisma.campaignStage.updateMany({
    where: { id: stageId, status: "pending" },
    data: { status: "running", startedAt: new Date() },
  });
  if (res.count === 0) return null;
  return prisma.campaignStage.findUnique({ where: { id: stageId } });
}

// Core runner — renders and sends using the stage's overrides. Falls back to
// the campaign's templates when a stage field is blank.
async function applyStageOverride<T extends Campaign>(
  campaign: T,
  stage: CampaignStage,
): Promise<T> {
  return {
    ...campaign,
    subjectEmail: stage.subjectEmail ?? campaign.subjectEmail,
    templateEmail: stage.templateEmail ?? campaign.templateEmail,
    templateSms: stage.templateSms ?? campaign.templateSms,
  };
}

async function runStage(stage: CampaignStage): Promise<void> {
  const campaign = await prisma.campaign.findUnique({ where: { id: stage.campaignId } });
  if (!campaign) {
    await prisma.campaignStage.update({
      where: { id: stage.id },
      data: { status: "failed", error: "campaign_missing", completedAt: new Date() },
    });
    return;
  }
  if (campaign.status === "archived") {
    await prisma.campaignStage.update({
      where: { id: stage.id },
      data: { status: "skipped", error: "campaign_archived", completedAt: new Date() },
    });
    return;
  }
  const effective = await applyStageOverride(campaign, stage);
  const channels = normalizeChannels(stage.channels);
  const where = audienceWhere(stage.campaignId, stage.audience as AudienceKind);
  const invitees = await prisma.invitee.findMany({ where, include: { invitations: true } });

  let sent = 0, skipped = 0, failed = 0;
  const isNonResponders = stage.audience === "non_responders";
  for (const i of invitees) {
    // Re-check response right before send to close the race where an invitee
    // RSVPs while the stage is iterating — we don't want a reminder landing
    // seconds after they replied.
    if (isNonResponders) {
      const fresh = await prisma.response.findUnique({ where: { inviteeId: i.id } });
      if (fresh) { skipped++; continue; }
    }
    for (const ch of channels) {
      const addr = ch === "email" ? i.email : i.phoneE164;
      if (!addr) { skipped++; continue; }
      const r = ch === "email" ? await sendEmail(effective, i) : await sendSms(effective, i);
      if (r.ok) sent++; else failed++;
    }
  }

  await prisma.campaignStage.update({
    where: { id: stage.id },
    data: {
      status: "completed",
      completedAt: new Date(),
      sentCount: sent,
      skippedCount: skipped,
      failedCount: failed,
    },
  });

  await prisma.eventLog.create({
    data: {
      kind: "stage.completed",
      refType: "stage",
      refId: stage.id,
      data: JSON.stringify({ sent, skipped, failed, audience: stage.audience, channels }),
    },
  });
}

// Scan for due stages, claim and run each. Returns a summary the cron
// endpoint logs so ops can verify the dispatcher is alive.
export async function dispatchDueStages(now: Date = new Date()) {
  const due = await prisma.campaignStage.findMany({
    where: { status: "pending", scheduledFor: { lte: now } },
    orderBy: { scheduledFor: "asc" },
    take: 20,
  });
  const ran: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const s of due) {
    const claimed = await claimStage(s.id);
    if (!claimed) { ran.push({ id: s.id, ok: false, error: "not_claimed" }); continue; }
    try {
      await runStage(claimed);
      ran.push({ id: s.id, ok: true });
    } catch (e) {
      const errMsg = String(e).slice(0, 500);
      await prisma.campaignStage.update({
        where: { id: s.id },
        data: { status: "failed", error: errMsg, completedAt: new Date() },
      });
      ran.push({ id: s.id, ok: false, error: errMsg.slice(0, 200) });
      const campaign = await prisma.campaign.findUnique({
        where: { id: s.campaignId },
        select: { name: true, id: true },
      });
      await notifyAdmins(
        "stage.failed",
        `Stage failed · ${campaign?.name ?? "Campaign"}`,
        `A scheduled stage "${s.kind.replace("_", " ")}" failed to run.\n\nError: ${errMsg}`,
        `/campaigns/${s.campaignId}?tab=schedule`,
      );
    }
  }
  return { considered: due.length, ran };
}

// Fire a stage immediately. Used by the "Run now" admin action when a stage
// was scheduled but the operator wants it out the door before its time.
export async function runStageNow(stageId: string, campaignId: string) {
  const stage = await prisma.campaignStage.findFirst({
    where: { id: stageId, campaignId, status: "pending" },
  });
  if (!stage) return { ok: false as const, error: "not_pending" };
  const claimed = await claimStage(stage.id);
  if (!claimed) return { ok: false as const, error: "not_claimed" };
  try {
    await runStage(claimed);
    return { ok: true as const };
  } catch (e) {
    await prisma.campaignStage.update({
      where: { id: stage.id },
      data: { status: "failed", error: String(e).slice(0, 500), completedAt: new Date() },
    });
    return { ok: false as const, error: String(e).slice(0, 200) };
  }
}

export { normalizeChannels, audienceWhere };
