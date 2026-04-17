import { prisma } from "./db";

// Campaign duplication — copies settings, templates, stages, questions,
// attachments, dates, branding, and team assignment. Does NOT copy the
// invitee list, invitations, responses, or event log: a new campaign
// starts with a fresh audience. Stage schedules are preserved but reset
// to pending so the cron dispatcher handles them as new work.

export async function duplicateCampaign(
  sourceId: string,
  overrides: { name?: string } = {},
): Promise<string> {
  const src = await prisma.campaign.findUnique({
    where: { id: sourceId },
    include: {
      stages: true,
      questions: true,
      attachments: true,
      eventOptions: true,
    },
  });
  if (!src) throw new Error("source_not_found");

  const name = (overrides.name ?? `${src.name} (copy)`).slice(0, 200);

  return prisma.$transaction(async (tx) => {
    const c = await tx.campaign.create({
      data: {
        name,
        description: src.description,
        venue: src.venue,
        locale: src.locale,
        status: "draft",
        templateEmail: src.templateEmail,
        templateSms: src.templateSms,
        subjectEmail: src.subjectEmail,
        eventAt: src.eventAt,
        rsvpDeadline: src.rsvpDeadline,
        brandColor: src.brandColor,
        brandLogoUrl: src.brandLogoUrl,
        brandHeroUrl: src.brandHeroUrl,
        teamId: src.teamId,
      },
    });

    if (src.stages.length > 0) {
      await tx.campaignStage.createMany({
        data: src.stages.map((s) => ({
          campaignId: c.id,
          kind: s.kind,
          name: s.name,
          order: s.order,
          scheduledFor: s.scheduledFor,
          channels: s.channels,
          audience: s.audience,
          subjectEmail: s.subjectEmail,
          templateEmail: s.templateEmail,
          templateSms: s.templateSms,
          status: "pending",
          sentCount: 0,
          skippedCount: 0,
          failedCount: 0,
        })),
      });
    }

    if (src.questions.length > 0) {
      await tx.campaignQuestion.createMany({
        data: src.questions.map((q) => ({
          campaignId: c.id,
          order: q.order,
          prompt: q.prompt,
          kind: q.kind,
          required: q.required,
          options: q.options,
          showWhen: q.showWhen,
        })),
      });
    }

    if (src.attachments.length > 0) {
      await tx.campaignAttachment.createMany({
        data: src.attachments.map((a) => ({
          campaignId: c.id,
          order: a.order,
          label: a.label,
          url: a.url,
          kind: a.kind,
        })),
      });
    }

    if (src.eventOptions.length > 0) {
      await tx.eventOption.createMany({
        data: src.eventOptions.map((o) => ({
          campaignId: c.id,
          order: o.order,
          label: o.label,
          startsAt: o.startsAt,
          endsAt: o.endsAt,
          venue: o.venue,
        })),
      });
    }

    return c.id;
  });
}
