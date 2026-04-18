import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { filterForState, validateAnswers } from "./questions";
import { notifyAdmins, notifyVipResponse } from "./notify";
import { logAction } from "./audit";

export type SubmitResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "not_found"
        | "closed"
        | "deadline"
        | "rate_limited"
        | "invalid"
        | "answers_invalid"
        | "event_option_required";
      errors?: Record<string, string>;
    };

export async function findInviteeByToken(token: string) {
  return prisma.invitee.findUnique({
    where: { rsvpToken: token },
    include: {
      campaign: { include: { questions: true, attachments: true, eventOptions: true } },
      response: { include: { answers: true } },
    },
  });
}

export async function submitResponse(params: {
  token: string;
  attending: boolean;
  guestsCount?: number;
  guestNames?: string[];
  message?: string;
  eventOptionId?: string | null;
  answers?: Record<string, string | string[]>;
  ip?: string;
  userAgent?: string;
}): Promise<SubmitResult> {
  if (!params.token || typeof params.token !== "string") return { ok: false, reason: "invalid" };
  const inv = await prisma.invitee.findUnique({
    where: { rsvpToken: params.token },
    include: {
      campaign: { include: { questions: true, eventOptions: true } },
    },
  });
  if (!inv) return { ok: false, reason: "not_found" };
  const c = inv.campaign;
  if (c.status === "closed" || c.status === "archived") return { ok: false, reason: "closed" };
  if (c.rsvpDeadline && c.rsvpDeadline < new Date()) return { ok: false, reason: "deadline" };

  // Reject non-finite input up front — the public form posts strings and
  // `Number("")` is 0 but `Number("abc")` is NaN, which would slip through
  // Math.min untouched and poison guestsCount downstream.
  const rawGuests = params.guestsCount ?? 0;
  const safeGuests = Number.isFinite(rawGuests) ? rawGuests : 0;
  const guests = Math.max(0, Math.min(safeGuests, inv.guestsAllowed));
  const guestNames = params.attending
    ? (params.guestNames ?? [])
        .map((n) => n.trim().slice(0, 120))
        .filter(Boolean)
        .slice(0, guests)
        .join("\n") || null
    : null;

  // Validate custom answers against the questions that apply for this state.
  const applicable = filterForState(c.questions, params.attending);
  const validation = validateAnswers(applicable, params.answers ?? {});
  if (!validation.ok) return { ok: false, reason: "answers_invalid", errors: validation.errors };

  // Event option must belong to this campaign. If the campaign has
  // event options AND the invitee says they're attending, one must
  // be picked — otherwise we'd silently store null and catering /
  // seating counts would be wrong.
  let eventOptionId: string | null = null;
  if (params.eventOptionId) {
    const belongs = c.eventOptions.some((o) => o.id === params.eventOptionId);
    if (belongs) eventOptionId = params.eventOptionId;
  }
  if (params.attending && c.eventOptions.length > 0 && !eventOptionId) {
    return { ok: false, reason: "event_option_required" };
  }
  // A declined invitee can't meaningfully pick a date — null it out so
  // reports don't show "declined on April 18" and confuse downstream
  // catering / seating readers.
  if (!params.attending) eventOptionId = null;

  // Upsert response + replace its answers atomically so two concurrent
  // submits for the same token can't interleave into a half-written
  // state. Prisma's `upsert` under the unique (inviteeId) can still
  // race: two parallel transactions both see "no row" and both try to
  // create — one wins with P2002, the other throws. We catch P2002 and
  // retry as a pure update, which is idempotent with the payload in
  // scope.
  const write = async (): Promise<void> => {
    await prisma.$transaction(async (tx) => {
      const response = await tx.response.upsert({
        where: { inviteeId: inv.id },
        create: {
          campaignId: c.id,
          inviteeId: inv.id,
          attending: params.attending,
          guestsCount: params.attending ? guests : 0,
          guestNames,
          message: params.message?.slice(0, 2000) || null,
          ip: params.ip,
          userAgent: params.userAgent?.slice(0, 300),
          eventOptionId,
        },
        update: {
          attending: params.attending,
          guestsCount: params.attending ? guests : 0,
          guestNames,
          message: params.message?.slice(0, 2000) || null,
          respondedAt: new Date(),
          eventOptionId,
        },
      });
      await tx.answer.deleteMany({ where: { responseId: response.id } });
      if (validation.answers.length > 0) {
        await tx.answer.createMany({
          data: validation.answers.map((a) => ({
            responseId: response.id,
            questionId: a.questionId,
            value: a.value,
          })),
        });
      }
    });
  };
  // Prior-response lookup drives notification dedupe later; we compute
  // here so "was this the first submission?" stays accurate even if the
  // write succeeds on a second attempt.
  const isFirstSubmit = !(await prisma.response.findUnique({
    where: { inviteeId: inv.id },
    select: { id: true },
  }));
  try {
    await write();
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Another concurrent submit beat us to create. Our payload is the
      // caller's latest intent, so re-run — the second pass will take
      // the update branch.
      await write();
    } else {
      throw e;
    }
  }

  await prisma.eventLog.create({
    data: {
      kind: "rsvp.submitted",
      refType: "invitee",
      refId: inv.id,
      data: JSON.stringify({
        attending: params.attending,
        guests: params.attending ? guests : 0,
        answers: validation.answers.length,
        eventOptionId,
      }),
    },
  });

  // Escalation paths — fire at most once per invitee (on first submit)
  // so edits don't re-spam admins. Two distinct shapes:
  //   - VIP tier response → rsvp.vip with tier-prefixed subject, dress
  //     + dietary + security notes preloaded from the contact record.
  //   - Long plain-text message from a non-VIP → rsvp.high_value
  //     (unchanged behavior; just a soft "heads up").
  const message = (params.message ?? "").trim();
  const contact = inv.contactId
    ? await prisma.contact.findUnique({
        where: { id: inv.contactId },
        select: {
          vipTier: true,
          dress: true,
          dietary: true,
          securityNotes: true,
          organization: true,
        },
      })
    : null;
  const tier = (contact?.vipTier ?? "standard") as "royal" | "minister" | "vip" | "standard";
  const isVip = tier !== "standard";

  if (isFirstSubmit && isVip) {
    await notifyVipResponse({
      inviteeName: inv.fullName,
      inviteeTitle: inv.title,
      campaignName: c.name,
      campaignId: c.id,
      inviteeId: inv.id,
      attending: params.attending,
      guests: params.attending ? guests : 0,
      message,
      tier,
      dress: contact?.dress ?? null,
      dietary: contact?.dietary ?? null,
      securityNotes: contact?.securityNotes ?? null,
      organization: inv.organization ?? contact?.organization ?? null,
    });
    await logAction({
      kind: "rsvp.vip.notified",
      refType: "invitee",
      refId: inv.id,
      data: { tier, attending: params.attending },
      actorId: null,
    });
  } else if (isFirstSubmit && message.length >= 20) {
    await notifyAdmins(
      "rsvp.high_value",
      `RSVP · ${inv.fullName}`,
      `${inv.fullName} ${params.attending ? "is attending" : "has declined"}${
        params.attending && guests > 0 ? ` (+${guests})` : ""
      } for "${c.name}".\n\nNote:\n${message}`,
      `/campaigns/${c.id}?invitee=${inv.id}`,
    );
  }

  return { ok: true };
}
