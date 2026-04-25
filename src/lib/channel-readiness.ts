import { hasWhatsAppTemplate } from "./channel-availability";
import { findApprovedWhatsAppTemplateByPair } from "./whatsapp-template-catalog";

export type ProviderFlags = {
  emailEnabled: boolean;
  smsEnabled: boolean;
  whatsappEnabled: boolean;
};

export type CampaignChannelConfig = {
  templateEmail: string | null;
  templateSms: string | null;
  templateWhatsAppName: string | null;
  templateWhatsAppLanguage: string | null;
  whatsappDocumentUploadId: string | null;
};

export type InviteeChannelConfig = {
  email: string | null;
  phoneE164: string | null;
};

export type ChannelReadiness = {
  channel: "email" | "sms" | "whatsapp";
  label: "Email" | "SMS" | "WhatsApp";
  ready: boolean;
  reason: string;
  detail?: string | null;
};

export function buildInviteeChannelReadiness(args: {
  campaign: CampaignChannelConfig;
  invitee: InviteeChannelConfig;
  providers: ProviderFlags;
}): ChannelReadiness[] {
  const { campaign, invitee, providers } = args;
  const whatsapp = describeWhatsAppReadiness(campaign, providers.whatsappEnabled);

  return [
    {
      channel: "email",
      label: "Email",
      ready: providers.emailEnabled && !!invitee.email && hasBody(campaign.templateEmail),
      reason: !providers.emailEnabled
        ? "Provider is off"
        : !invitee.email
          ? "No email on this invitee"
          : !hasBody(campaign.templateEmail)
            ? "Campaign email copy is missing"
            : "Ready to send",
      detail: invitee.email,
    },
    {
      channel: "sms",
      label: "SMS",
      ready: providers.smsEnabled && !!invitee.phoneE164 && hasBody(campaign.templateSms),
      reason: !providers.smsEnabled
        ? "Provider is off"
        : !invitee.phoneE164
          ? "No phone on this invitee"
          : !hasBody(campaign.templateSms)
            ? "Campaign SMS copy is missing"
            : "Ready to send",
      detail: invitee.phoneE164,
    },
    {
      channel: "whatsapp",
      label: "WhatsApp",
      ready: providers.whatsappEnabled && !!invitee.phoneE164 && whatsapp.ready,
      reason: !providers.whatsappEnabled
        ? "Provider is off"
        : !invitee.phoneE164
          ? "No phone on this invitee"
          : whatsapp.reason,
      detail: whatsapp.ready ? whatsapp.detail : invitee.phoneE164,
    },
  ];
}

export function buildCampaignChannelReadiness(args: {
  campaign: CampaignChannelConfig;
  providers: ProviderFlags;
  inviteesWithEmail: number;
  inviteesWithPhone: number;
}): ChannelReadiness[] {
  const { campaign, providers, inviteesWithEmail, inviteesWithPhone } = args;
  const whatsapp = describeWhatsAppReadiness(campaign, providers.whatsappEnabled);

  return [
    {
      channel: "email",
      label: "Email",
      ready: providers.emailEnabled && hasBody(campaign.templateEmail),
      reason: !providers.emailEnabled
        ? "Provider is off"
        : !hasBody(campaign.templateEmail)
          ? "Campaign email copy is missing"
          : "Ready",
      detail:
        inviteesWithEmail > 0
          ? `${inviteesWithEmail.toLocaleString()} invitees have email`
          : "No invitees have email yet",
    },
    {
      channel: "sms",
      label: "SMS",
      ready: providers.smsEnabled && hasBody(campaign.templateSms),
      reason: !providers.smsEnabled
        ? "Provider is off"
        : !hasBody(campaign.templateSms)
          ? "Campaign SMS copy is missing"
          : "Ready",
      detail:
        inviteesWithPhone > 0
          ? `${inviteesWithPhone.toLocaleString()} invitees have phone`
          : "No invitees have phone yet",
    },
    {
      channel: "whatsapp",
      label: "WhatsApp",
      ready: providers.whatsappEnabled && whatsapp.ready,
      reason: !providers.whatsappEnabled ? "Provider is off" : whatsapp.reason,
      detail: joinBits([
        inviteesWithPhone > 0
          ? `${inviteesWithPhone.toLocaleString()} invitees have phone`
          : "No invitees have phone yet",
        whatsapp.detail,
      ]),
    },
  ];
}

function describeWhatsAppReadiness(
  campaign: CampaignChannelConfig,
  providerEnabled: boolean,
): { ready: boolean; reason: string; detail: string | null } {
  const configured = hasWhatsAppTemplate({
    templateWhatsAppName: campaign.templateWhatsAppName,
    templateWhatsAppLanguage: campaign.templateWhatsAppLanguage,
  });
  const approvedTemplate = configured
    ? findApprovedWhatsAppTemplateByPair(
        campaign.templateWhatsAppName,
        campaign.templateWhatsAppLanguage,
      )
    : null;

  if (!providerEnabled) {
    return { ready: false, reason: "Provider is off", detail: null };
  }
  if (!configured) {
    return {
      ready: false,
      reason: "Choose an approved WhatsApp template",
      detail: "Open Edit message setup to select the campaign's WhatsApp template.",
    };
  }
  if (approvedTemplate?.requiresDocument && !campaign.whatsappDocumentUploadId) {
    return {
      ready: false,
      reason: "Invitation PDF is required",
      detail: `${approvedTemplate.label} uses a PDF document header.`,
    };
  }

  const detail = approvedTemplate
    ? joinBits([
        approvedTemplate.label,
        approvedTemplate.language,
        approvedTemplate.requiresDocument
          ? campaign.whatsappDocumentUploadId
            ? "PDF attached"
            : "PDF missing"
          : null,
      ])
    : joinBits([
        campaign.templateWhatsAppName?.trim() || null,
        campaign.templateWhatsAppLanguage?.trim() || null,
        campaign.whatsappDocumentUploadId ? "PDF attached" : null,
      ]);

  return { ready: true, reason: "Ready", detail };
}

function hasBody(value: string | null): boolean {
  return !!value && value.trim().length > 0;
}

function joinBits(bits: Array<string | null | undefined>): string {
  return bits.filter((bit): bit is string => !!bit && bit.trim().length > 0).join(" - ");
}
