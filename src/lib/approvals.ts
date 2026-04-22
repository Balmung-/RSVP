import { prisma } from "./db";
import { sendCampaign } from "./campaigns";
import { logAction } from "./audit";
import { notifyTenantAdmins } from "./notify";

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
  const campaign = await prisma.campaign.findUnique({
    where: { id: params.campaignId },
    select: { name: true, tenantId: true },
  });
  const requester = await prisma.user.findUnique({
    where: { id: params.requestedBy },
    select: { email: true, fullName: true },
  });
  if (campaign) {
    await notifyTenantAdmins(
      campaign.tenantId,
      "approval.requested",
      `Approval needed Â· ${campaign.name ?? "Campaign"}`,
      `${requester?.fullName ?? requester?.email ?? "An editor"} is asking to send ${params.recipientCount.toLocaleString()} ${params.channel === "both" ? "messages" : params.channel === "email" ? "emails" : "SMSs"} for "${campaign.name ?? "a campaign"}".\n\nThe send is paused until a workspace admin approves.`,
      "/approvals",
    );
  }
  return row;
}

export async function decideApproval(
  approvalId: string,
  tenantId: string,
  decidedBy: string,
  decision: "approved" | "rejected",
  decisionNote?: string | null,
) {
  const row = await prisma.sendApproval.findFirst({
    where: { id: approvalId, campaign: { tenantId } },
  });
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

export async function listPendingApprovalsForTenant(tenantId: string) {
  return prisma.sendApproval.findMany({
    where: { status: "pending", campaign: { tenantId } },
    include: { campaign: { select: { name: true, id: true } } },
    orderBy: { createdAt: "desc" },
  });
}
