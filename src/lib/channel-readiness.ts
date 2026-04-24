import { hasWhatsAppTemplate } from "./channel-availability";

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
  const whatsAppConfigured = hasWhatsAppTemplate({
    templateWhatsAppName: campaign.templateWhatsAppName,
    templateWhatsAppLanguage: campaign.templateWhatsAppLanguage,
  });

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
      ready: providers.whatsappEnabled && !!invitee.phoneE164 && whatsAppConfigured,
      reason: !providers.whatsappEnabled
        ? "Provider is off"
        : !invitee.phoneE164
          ? "No phone on this invitee"
          : !whatsAppConfigured
            ? "Campaign template name and language are missing"
            : "Ready to send",
      detail: whatsAppConfigured
        ? joinBits([
            campaign.templateWhatsAppName?.trim() || null,
            campaign.templateWhatsAppLanguage?.trim() || null,
            campaign.whatsappDocumentUploadId ? "PDF attached" : "No PDF attached",
          ])
        : invitee.phoneE164,
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
  const whatsAppConfigured = hasWhatsAppTemplate({
    templateWhatsAppName: campaign.templateWhatsAppName,
    templateWhatsAppLanguage: campaign.templateWhatsAppLanguage,
  });

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
      detail: inviteesWithEmail > 0 ? `${inviteesWithEmail.toLocaleString()} invitees have email` : "No invitees have email yet",
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
      detail: inviteesWithPhone > 0 ? `${inviteesWithPhone.toLocaleString()} invitees have phone` : "No invitees have phone yet",
    },
    {
      channel: "whatsapp",
      label: "WhatsApp",
      ready: providers.whatsappEnabled && whatsAppConfigured,
      reason: !providers.whatsappEnabled
        ? "Provider is off"
        : !whatsAppConfigured
          ? "Template name and language are required"
          : "Ready",
      detail: joinBits([
        inviteesWithPhone > 0 ? `${inviteesWithPhone.toLocaleString()} invitees have phone` : "No invitees have phone yet",
        campaign.templateWhatsAppName?.trim() || null,
        campaign.templateWhatsAppLanguage?.trim() || null,
        campaign.whatsappDocumentUploadId ? "PDF attached" : "No PDF attached",
      ]),
    },
  ];
}

function hasBody(value: string | null): boolean {
  return !!value && value.trim().length > 0;
}

function joinBits(bits: Array<string | null | undefined>): string {
  return bits.filter((bit): bit is string => !!bit && bit.trim().length > 0).join(" - ");
}
