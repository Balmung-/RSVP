import type { Campaign, EventOption } from "@prisma/client";

// Minimal RFC 5545 generator — just enough for "Add to calendar" from a
// confirmation email. One VEVENT, summary = campaign name, location =
// venue, organizer = APP_BRAND. No attendees (privacy).

function fold(line: string): string {
  // 75-octet soft wrap per RFC. Simple ASCII-safe split.
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const slice = bytes.slice(i, i + 73);
    out.push(slice.toString("utf8"));
    i += 73;
  }
  return out.join("\r\n ");
}

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function toIcsDate(d: Date): string {
  // UTC basic format, e.g. 20260417T143000Z
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

export function renderIcs(params: {
  uid: string;
  campaign: Campaign;
  start: Date;
  end: Date | null;
  description?: string | null;
  location?: string | null;
}): string {
  const brand = process.env.APP_BRAND ?? "Einai";
  const start = params.start;
  const end = params.end ?? new Date(start.getTime() + 2 * 3600_000); // 2h default
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${esc(brand)}//Einai RSVP//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${esc(params.uid)}`,
    `DTSTAMP:${toIcsDate(new Date())}`,
    `DTSTART:${toIcsDate(start)}`,
    `DTEND:${toIcsDate(end)}`,
    `SUMMARY:${esc(params.campaign.name)}`,
    params.location ? `LOCATION:${esc(params.location)}` : null,
    params.description ? `DESCRIPTION:${esc(params.description)}` : null,
    `ORGANIZER;CN=${esc(brand)}:mailto:${process.env.EMAIL_FROM ?? "noreply@localhost"}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean) as string[];
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function eventWindowForCampaign(
  campaign: Campaign,
  pickedEventOption?: EventOption | null,
): { start: Date; end: Date | null } | null {
  if (pickedEventOption) {
    return { start: pickedEventOption.startsAt, end: pickedEventOption.endsAt ?? null };
  }
  if (campaign.eventAt) {
    return { start: campaign.eventAt, end: null };
  }
  return null;
}
