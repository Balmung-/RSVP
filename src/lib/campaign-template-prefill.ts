type CampaignTemplateShape = {
  subjectEmail?: string | null;
  templateEmail?: string | null;
  templateSms?: string | null;
};

type LibraryTemplate = {
  kind: "email" | "sms";
  subject: string | null;
  body: string;
} | null;

export function applyCampaignTemplatePrefill<T extends CampaignTemplateShape>(
  base: T | null | undefined,
  emailTemplate: LibraryTemplate,
  smsTemplate: LibraryTemplate,
): T | null {
  const next = { ...(base ?? {}) } as T;

  if (emailTemplate?.kind === "email") {
    next.subjectEmail = emailTemplate.subject ?? null;
    next.templateEmail = emailTemplate.body;
  }

  if (smsTemplate?.kind === "sms") {
    next.templateSms = smsTemplate.body;
  }

  return Object.keys(next).length > 0 ? next : null;
}
