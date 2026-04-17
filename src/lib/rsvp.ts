import { prisma } from "./db";
import { filterForState, validateAnswers } from "./questions";

export type SubmitResult =
  | { ok: true }
  | {
      ok: false;
      reason: "not_found" | "closed" | "deadline" | "rate_limited" | "invalid" | "answers_invalid";
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

  const guests = Math.max(0, Math.min(params.guestsCount ?? 0, inv.guestsAllowed));

  // Validate custom answers against the questions that apply for this state.
  const applicable = filterForState(c.questions, params.attending);
  const validation = validateAnswers(applicable, params.answers ?? {});
  if (!validation.ok) return { ok: false, reason: "answers_invalid", errors: validation.errors };

  // Event option must belong to this campaign.
  let eventOptionId: string | null = null;
  if (params.eventOptionId) {
    const belongs = c.eventOptions.some((o) => o.id === params.eventOptionId);
    if (belongs) eventOptionId = params.eventOptionId;
  }

  const response = await prisma.response.upsert({
    where: { inviteeId: inv.id },
    create: {
      campaignId: c.id,
      inviteeId: inv.id,
      attending: params.attending,
      guestsCount: params.attending ? guests : 0,
      message: params.message?.slice(0, 2000) || null,
      ip: params.ip,
      userAgent: params.userAgent?.slice(0, 300),
      eventOptionId,
    },
    update: {
      attending: params.attending,
      guestsCount: params.attending ? guests : 0,
      message: params.message?.slice(0, 2000) || null,
      respondedAt: new Date(),
      eventOptionId,
    },
  });

  // Replace prior answers wholesale — last submission wins.
  await prisma.answer.deleteMany({ where: { responseId: response.id } });
  if (validation.answers.length > 0) {
    await prisma.answer.createMany({
      data: validation.answers.map((a) => ({
        responseId: response.id,
        questionId: a.questionId,
        value: a.value,
      })),
    });
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

  return { ok: true };
}
