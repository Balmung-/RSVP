import { prisma } from "./db";
import { sendCampaign } from "./campaigns";
import { logAction } from "./audit";

export function approvalThreshold(): number {
  const raw = parseInt(process.env.APPROVAL_THRESHOLD ?? "100", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 100;
}

// Require approval when the send would touch more than N distinct
// recipients. Uses the existing per-invitee summary counts.
export function needsApproval(recipientCount: number): boolean {
  return recipientCount > approvalThreshold();
}

export async function requestApproval(params: {
  campaignId: string;
  channel: "email" | "sms" | "both";
  recipientCount: number;
  requestedBy: string;
  note?: string | null;
}) {
  const existing = await prisma.sendApproval.findFirst({
    where: { campaignId: params.campaignId, status: "pending" },
  });
  if (existing) return existing;
  const row = await prisma.sendApproval.create({
    data: {
      campaignId: params.campaignId,
      channel: params.channel,
      recipientCount: params.recipientCount,
      requestedBy: params.requestedBy,
      note: params.note?.slice(0, 500) ?? null,
    },
  });
  await logAction({
    kind: "approval.requested",
    refType: "campaign",
    refId: params.campaignId,
    data: { recipients: params.recipientCount, channel: params.channel },
  });
  return row;
}

export async function decideApproval(
  approvalId: string,
  decidedBy: string,
  decision: "approved" | "rejected",
  decisionNote?: string | null,
) {
  const row = await prisma.sendApproval.findUnique({ where: { id: approvalId } });
  if (!row) return { ok: false as const, reason: "not_found" };
  if (row.status !== "pending") return { ok: false as const, reason: "already_decided" };
  await prisma.sendApproval.update({
    where: { id: approvalId },
    data: {
      status: decision,
      decidedBy,
      decidedAt: new Date(),
      decisionNote: decisionNote?.slice(0, 500) ?? null,
    },
  });
  await logAction({
    kind: `approval.${decision}`,
    refType: "campaign",
    refId: row.campaignId,
    data: { recipients: row.recipientCount, channel: row.channel, note: decisionNote },
  });
  if (decision === "approved") {
    // Fire the send with the stored parameters.
    await sendCampaign(row.campaignId, {
      channel: row.channel as "email" | "sms" | "both",
      onlyUnsent: true,
    });
  }
  return { ok: true as const };
}

export async function pendingApproval(campaignId: string) {
  return prisma.sendApproval.findFirst({
    where: { campaignId, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
}

export async function listPendingApprovals() {
  return prisma.sendApproval.findMany({
    where: { status: "pending" },
    include: { campaign: { select: { name: true, id: true } } },
    orderBy: { createdAt: "desc" },
  });
}
