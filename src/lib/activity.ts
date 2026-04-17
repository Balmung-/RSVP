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
      const ch = data.channel ?? "message";
      return { line: `Invitation sent via ${ch}.`, tone: "default" };
    }
    case "invite.delivered":
      return { line: `Delivery confirmed.`, tone: "success" };
    case "invite.failed":
      return { line: `Delivery failed — ${data.error ?? "provider error"}.`, tone: "fail" };
    case "invite.bounced":
      return { line: `Delivery bounced.`, tone: "fail" };

    case "rsvp.submitted":
      return {
        line: data.attending
          ? `An invitee confirmed attending${data.guests ? ` (+${data.guests})` : ""}.`
          : `An invitee declined.`,
        tone: data.attending ? "success" : "default",
      };

    case "stage.completed":
      return {
        line: `Stage completed — ${data.sent ?? 0} sent, ${data.failed ?? 0} failed.`,
        tone: data.failed > 0 ? "warn" : "success",
      };

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
