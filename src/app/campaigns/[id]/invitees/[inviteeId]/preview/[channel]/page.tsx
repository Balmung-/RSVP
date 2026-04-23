import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { isAuthed } from "@/lib/auth";
import { buildVars, renderEmail, renderSms } from "@/lib/preview";
import { decideWhatsAppMessage } from "@/lib/providers/whatsapp/sendPlan";
import { hasWhatsAppTemplate, isChannelProviderEnabled } from "@/lib/channel-availability";

export const dynamic = "force-dynamic";

export default async function Preview({
  params,
}: {
  params: { id: string; inviteeId: string; channel: string };
}) {
  if (!(await isAuthed())) redirect("/login");
  if (params.channel !== "email" && params.channel !== "sms" && params.channel !== "whatsapp") notFound();

  const [campaign, invitee] = await Promise.all([
    prisma.campaign.findUnique({ where: { id: params.id } }),
    prisma.invitee.findUnique({ where: { id: params.inviteeId } }),
  ]);
  if (!campaign || !invitee || invitee.campaignId !== campaign.id) notFound();

  const previewLinks = buildPreviewLinks({
    email: isChannelProviderEnabled("email") && !!invitee.email,
    sms: isChannelProviderEnabled("sms") && !!invitee.phoneE164,
    whatsapp:
      isChannelProviderEnabled("whatsapp") &&
      !!invitee.phoneE164 &&
      hasWhatsAppTemplate({
        templateWhatsAppName: campaign.templateWhatsAppName,
        templateWhatsAppLanguage: campaign.templateWhatsAppLanguage,
      }),
  });

  if (params.channel === "email") {
    const { subject, html, locale } = renderEmail(campaign, invitee);
    return (
      <div className="min-h-screen bg-ink-100">
        <TopBar campaignId={campaign.id} inviteeId={invitee.id} links={previewLinks} active="email">
          <span className="mr-2 text-xs text-ink-400">Subject</span>
          <span className="truncate text-sm font-medium text-ink-900">{subject}</span>
          <span className="ml-3 text-xs text-ink-400">- {locale}</span>
        </TopBar>
        <iframe title="Email preview" srcDoc={html} className="h-[calc(100vh-60px)] w-full bg-white" />
      </div>
    );
  }

  if (params.channel === "sms") {
    const { body, locale, dir } = renderSms(campaign, invitee);
    return (
      <div className="min-h-screen bg-ink-100">
        <TopBar campaignId={campaign.id} inviteeId={invitee.id} links={previewLinks} active="sms">
          <span className="mr-2 text-xs text-ink-400">SMS - {locale} - {body.length} chars</span>
        </TopBar>
        <div className="flex flex-1 items-center justify-center p-12">
          <div
            dir={dir}
            className="max-w-sm whitespace-pre-wrap rounded-2xl bg-ink-0 p-6 text-[15px] leading-relaxed text-ink-900 shadow-lift"
          >
            {body}
          </div>
        </div>
      </div>
    );
  }

  const { locale, dir } = renderSms(campaign, invitee);
  const plan = decideWhatsAppMessage({
    campaign: {
      templateWhatsAppName: campaign.templateWhatsAppName,
      templateWhatsAppLanguage: campaign.templateWhatsAppLanguage,
      templateWhatsAppVariables: campaign.templateWhatsAppVariables,
      templateSms: campaign.templateSms,
      whatsappDocumentUploadId: campaign.whatsappDocumentUploadId,
    },
    to: invitee.phoneE164 ?? "",
    vars: buildVars(campaign, invitee),
    sessionOpen: false,
  });

  return (
    <div className="min-h-screen bg-ink-100">
      <TopBar campaignId={campaign.id} inviteeId={invitee.id} links={previewLinks} active="whatsapp">
        <span className="mr-2 text-xs text-ink-400">WhatsApp - {locale}</span>
      </TopBar>
      <div className="flex flex-1 items-center justify-center p-12">
        <div dir={dir} className="w-full max-w-xl rounded-2xl bg-ink-0 p-6 shadow-lift">
          {plan.ok ? (
            plan.message.kind === "text" ? (
              <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink-900">
                {plan.message.text}
              </div>
            ) : plan.message.kind === "template" ? (
              <div className="space-y-4">
                <div>
                  <div className="text-xs uppercase tracking-wider text-ink-400">Template</div>
                  <div className="mt-1 text-sm font-medium text-ink-900">
                    {plan.message.templateName} ({plan.message.languageCode})
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-ink-400">Variables</div>
                  {plan.message.variables && plan.message.variables.length > 0 ? (
                    <ol className="mt-2 space-y-1 text-sm text-ink-800">
                      {plan.message.variables.map((value, index) => (
                        <li key={`${index}-${value}`} className="flex gap-2">
                          <span className="tabular-nums text-ink-400">{index + 1}.</span>
                          <span className="whitespace-pre-wrap">{value || <span className="text-ink-300">--</span>}</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <div className="mt-1 text-sm text-ink-500">No template variables.</div>
                  )}
                </div>
                {plan.message.headerDocument ? (
                  <div>
                    <div className="text-xs uppercase tracking-wider text-ink-400">Attachment</div>
                    <div className="mt-1 text-sm text-ink-900">
                      {plan.message.headerDocument.filename || "PDF header attached"}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-sm font-medium text-ink-900">Standalone document message</div>
                <div className="text-sm text-ink-600">
                  This preview path only expects template or text messages, but the planner returned a document payload.
                </div>
              </div>
            )
          ) : (
            <div className="space-y-2">
              <div className="text-sm font-medium text-signal-fail">WhatsApp preview is not ready.</div>
              <div className="text-sm text-ink-600">
                {plan.reason === "template_vars_malformed"
                  ? "Template variables are not valid JSON."
                  : "Configure the WhatsApp template first."}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TopBar({
  children,
  campaignId,
  inviteeId,
  links,
  active,
}: {
  children: React.ReactNode;
  campaignId: string;
  inviteeId: string;
  links: Array<{ channel: "email" | "sms" | "whatsapp"; label: string }>;
  active: "email" | "sms" | "whatsapp";
}) {
  return (
    <header className="flex items-center justify-between border-b border-ink-200 bg-ink-0 px-6 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <Link href={`/campaigns/${campaignId}?invitee=${inviteeId}`} className="btn-ghost !px-3 !py-1 text-xs">
          {"<-"} Back
        </Link>
        <div className="ml-2 flex min-w-0 items-center gap-2">{children}</div>
      </div>
      <div className="flex items-center gap-2">
        {links.filter((link) => link.channel !== active).map((link) => (
          <Link
            key={link.channel}
            href={`/campaigns/${campaignId}/invitees/${inviteeId}/preview/${link.channel}`}
            className="btn-ghost text-xs"
          >
            Show {link.label}
          </Link>
        ))}
      </div>
    </header>
  );
}

function buildPreviewLinks(availability: { email: boolean; sms: boolean; whatsapp: boolean }) {
  const links: Array<{ channel: "email" | "sms" | "whatsapp"; label: string }> = [];
  if (availability.email) links.push({ channel: "email", label: "email" });
  if (availability.sms) links.push({ channel: "sms", label: "SMS" });
  if (availability.whatsapp) links.push({ channel: "whatsapp", label: "WhatsApp" });
  return links;
}
