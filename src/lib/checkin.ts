import QRCode from "qrcode";
import { prisma } from "./db";
import { logAction } from "./audit";

// Small per-process QR cache. The value is stable for a given token; the
// cache saves a qrcode.toDataURL call on every RSVP page view.
const QR_CACHE = new Map<string, string>();
const QR_CACHE_MAX = 500;

// The RSVP token is the check-in identifier. Scanning the QR opens
// /checkin/<token> in the admin's phone browser (admin must be signed in);
// one tap confirms arrival.

export function checkInUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/$/, "")}/checkin/${token}`;
}

export async function renderCheckInQrDataUrl(url: string): Promise<string> {
  const cached = QR_CACHE.get(url);
  if (cached) return cached;
  const out = await QRCode.toDataURL(url, {
    errorCorrectionLevel: "L",
    margin: 1,
    width: 384,
    color: { dark: "#141414", light: "#ffffff" },
  });
  if (QR_CACHE.size >= QR_CACHE_MAX) QR_CACHE.delete(QR_CACHE.keys().next().value as string);
  QR_CACHE.set(url, out);
  return out;
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

  // Conditional update: only claim the arrival when checkedInAt is still null.
  // Two concurrent scans compete on the WHERE predicate — one succeeds
  // (count=1) and emits the audit row, the other returns alreadyArrived.
  const claim = await prisma.response.updateMany({
    where: { id: invitee.response.id, checkedInAt: null },
    data: { checkedInAt: new Date(), checkedInBy: actorId },
  });
  if (claim.count === 0) return { ok: true, alreadyArrived: true };

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
