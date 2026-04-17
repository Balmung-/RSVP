import QRCode from "qrcode";
import { prisma } from "./db";
import { logAction } from "./audit";

// The RSVP token is the check-in identifier. Scanning the QR opens
// /checkin/<token> in the admin's phone browser (admin must be signed in);
// one tap confirms arrival.

export function checkInUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/$/, "")}/checkin/${token}`;
}

export async function renderCheckInQrDataUrl(url: string): Promise<string> {
  return QRCode.toDataURL(url, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 512,
    color: { dark: "#141414", light: "#ffffff" },
  });
}

export async function findCheckInByToken(token: string) {
  return prisma.invitee.findUnique({
    where: { rsvpToken: token },
    include: { campaign: true, response: true },
  });
}

export async function markArrived(
  token: string,
  actorId: string,
): Promise<
  | { ok: true; alreadyArrived: boolean }
  | { ok: false; reason: "not_found" | "not_responded" | "declined" }
> {
  const invitee = await prisma.invitee.findUnique({
    where: { rsvpToken: token },
    include: { response: true },
  });
  if (!invitee) return { ok: false, reason: "not_found" };
  if (!invitee.response) return { ok: false, reason: "not_responded" };
  if (!invitee.response.attending) return { ok: false, reason: "declined" };
  if (invitee.response.checkedInAt) return { ok: true, alreadyArrived: true };
  await prisma.response.update({
    where: { id: invitee.response.id },
    data: { checkedInAt: new Date(), checkedInBy: actorId },
  });
  await logAction({
    kind: "checkin.arrived",
    refType: "invitee",
    refId: invitee.id,
    data: { campaignId: invitee.campaignId, guests: invitee.response.guestsCount },
    actorId,
  });
  return { ok: true, alreadyArrived: false };
}

export async function undoArrived(token: string, actorId: string) {
  const invitee = await prisma.invitee.findUnique({
    where: { rsvpToken: token },
    include: { response: true },
  });
  if (!invitee?.response) return { ok: false as const, reason: "not_found" };
  await prisma.response.update({
    where: { id: invitee.response.id },
    data: { checkedInAt: null, checkedInBy: null },
  });
  await logAction({
    kind: "checkin.reverted",
    refType: "invitee",
    refId: invitee.id,
    actorId,
  });
  return { ok: true as const };
}
