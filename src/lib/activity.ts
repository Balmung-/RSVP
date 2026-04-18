import type { EventLog } from "@prisma/client";

// Human phrasings for EventLog entries. Keep it descriptive but neutral —
// never "emojis" or exclamation. For unknown kinds, fall back to the kind
// itself so nothing breaks.

export type ActivityRecord = EventLog & {
  actor: { email: string; fullName: string | null } | null;
};

export function phrase(e: ActivityRecord): { line: string; tone: "default" | "success" | "warn" | "fail" } {
  const actor = e.actor?.fullName ?? e.actor?.email ?? "System";
  const ref = (e.refType ?? "").toLowerCase();
  const data = safeJSON(e.data);

  switch (e.kind) {
    case "user.login":
      return { line: `${actor} signed in.`, tone: "default" };
    case "user.created":
      return { line: `${actor} invited ${data.email ?? "a new user"} as ${data.role ?? "member"}.`, tone: "default" };
    case "user.updated":
      return { line: `${actor} updated a user profile.`, tone: "default" };
    case "user.password_reset":
      return { line: `${actor} reset a user password.`, tone: "warn" };
    case "user.deactivated":
      return { line: `${actor} disabled a user account.`, tone: "warn" };
    case "user.deleted":
      return { line: `${actor} deleted a user account.`, tone: "warn" };

    case "campaign.deleted":
      return { line: `${actor} deleted campaign "${data.name ?? "?"}".`, tone: "warn" };
    case "campaign.export":
      return { line: `${actor} exported responses to CSV${typeof data.rows === "number" ? ` (${data.rows} rows)` : ""}.`, tone: "default" };

    case "approval.requested":
      return {
        line: `${actor} requested admin approval — ${fmtCount(data.recipients)} recipient${data.recipients === 1 ? "" : "s"} on ${channelLabel(data.channel)}.`,
        tone: "warn",
      };
    case "approval.approved":
      return { line: `${actor} approved the send — ${fmtCount(data.recipients)} on ${channelLabel(data.channel)}.`, tone: "success" };
    case "approval.rejected":
      return { line: `${actor} rejected the send.${data.note ? ` "${String(data.note).slice(0, 120)}"` : ""}`, tone: "fail" };

    case "import.completed":
      return {
        line: `${actor} imported ${(data.created ?? 0)} invitee${data.created === 1 ? "" : "s"}${
          data.duplicatesWithin + data.duplicatesExisting > 0
            ? ` (${(data.duplicatesWithin ?? 0) + (data.duplicatesExisting ?? 0)} duplicates skipped)`
            : ""
        }.`,
        tone: "success",
      };

    case "invite.sent": {
      return { line: `Invitation sent via ${channelLabel(data.channel)}.`, tone: "default" };
    }
    case "invite.delivered":
      return { line: `Delivery confirmed.`, tone: "success" };
    case "invite.failed":
      return { line: `Delivery failed — ${data.error ?? "provider error"}.`, tone: "fail" };
    case "invite.bounced":
      return { line: `Delivery bounced.`, tone: "fail" };
    case "invite.retry.ok":
      return { line: `${actor} retried and the resend succeeded.`, tone: "success" };
    case "invite.retry.fail":
      return { line: `${actor} retried — still failing${data.error ? ` (${data.error})` : ""}.`, tone: "fail" };

    case "rsvp.submitted":
      return {
        line: data.attending
          ? `An invitee confirmed attending${data.guests ? ` (+${data.guests})` : ""}.`
          : `An invitee declined.`,
        tone: data.attending ? "success" : "default",
      };
    case "rsvp.vip.notified":
      return {
        line: `${data.tier === "royal" ? "Royal" : data.tier === "minister" ? "Minister" : "VIP"} RSVP — admins notified.`,
        tone: data.tier === "royal" ? "fail" : "warn",
      };

    case "stage.completed":
      return {
        line: `Stage completed — ${data.sent ?? 0} sent, ${data.failed ?? 0} failed.`,
        tone: data.failed > 0 ? "warn" : "success",
      };
    case "stage.failed":
      return { line: `Stage failed${data.error ? ` — ${data.error}` : "."}`, tone: "fail" };

    case "inbound.applied":
      return {
        line: data.intent === "attending"
          ? `Auto-applied an attending reply from ${channelLabel(data.channel)}.`
          : data.intent === "declined"
            ? `Auto-applied a declined reply from ${channelLabel(data.channel)}.`
            : `Auto-processed an inbound ${String(data.intent ?? "reply")}.`,
        tone: "success",
      };
    case "inbound.reviewed":
      return { line: `${actor} applied "${data.decision ?? "?"}" from ${channelLabel(data.channel)} inbox.`, tone: "default" };
    case "inbound.ack.sent":
      return { line: `Sent a ${data.intent ?? ""} acknowledgment via ${channelLabel(data.channel)}.`, tone: "default" };
    case "inbound.ack.failed":
      return { line: `Acknowledgment failed to deliver${data.error ? ` — ${data.error}` : "."}`, tone: "warn" };

    case "unsubscribe.one_click":
      return { line: `A recipient unsubscribed via one-click.`, tone: "warn" };
    case "contact.unsubscribed":
      return { line: `${actor} marked a contact opted out.`, tone: "warn" };
    case "contact.resubscribed":
      return { line: `${actor} restored consent for a contact.`, tone: "default" };
    case "contact.deleted":
      return { line: `${actor} deleted a contact.`, tone: "warn" };

    case "template.created":
      return { line: `${actor} created a template.`, tone: "default" };
    case "template.updated":
      return { line: `${actor} updated a template.`, tone: "default" };
    case "template.archived":
      return { line: `${actor} archived a template.`, tone: "default" };
    case "template.unarchived":
      return { line: `${actor} unarchived a template.`, tone: "default" };
    case "template.deleted":
      return { line: `${actor} deleted a template.`, tone: "warn" };

    case "team.updated":
      return { line: `${actor} updated team settings.`, tone: "default" };
    case "team.member_added":
      return { line: `${actor} added a team member.`, tone: "default" };
    case "team.member_removed":
      return { line: `${actor} removed a team member.`, tone: "default" };
    case "team.archived":
      return { line: `${actor} archived the team.`, tone: "default" };
    case "team.unarchived":
      return { line: `${actor} unarchived the team.`, tone: "default" };
    case "team.deleted":
      return { line: `${actor} deleted the team.`, tone: "warn" };

    case "user.2fa_enabled":
      return { line: `${actor} turned on two-step sign-in.`, tone: "success" };
    case "user.2fa_disabled":
      return { line: `${actor} turned off two-step sign-in.`, tone: "warn" };

    case "unsubscribes.export":
      return { line: `${actor} exported the unsubscribe list${typeof data.rows === "number" ? ` (${data.rows} rows)` : ""}.`, tone: "default" };

    case "checkin.arrived":
      return { line: `An invitee arrived at the event${data.guests ? ` (+${data.guests})` : ""}.`, tone: "success" };
    case "checkin.reverted":
      return { line: `${actor} reverted a check-in.`, tone: "warn" };

    default:
      return { line: `${actor} · ${e.kind}${ref ? ` on ${ref}` : ""}.`, tone: "default" };
  }
}

function safeJSON(raw: string | null | undefined): Record<string, unknown> & { [k: string]: any } {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function channelLabel(ch: unknown): string {
  if (ch === "email") return "email";
  if (ch === "sms") return "SMS";
  if (ch === "both") return "email + SMS";
  if (typeof ch === "string" && ch) return ch;
  return "message";
}

function fmtCount(n: unknown): string {
  return typeof n === "number" ? n.toLocaleString() : "?";
}
