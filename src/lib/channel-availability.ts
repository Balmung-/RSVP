export function isChannelProviderEnabled(channel: "email" | "sms" | "whatsapp"): boolean {
  const raw =
    channel === "email"
      ? process.env.EMAIL_PROVIDER
      : channel === "sms"
        ? process.env.SMS_PROVIDER
        : process.env.WHATSAPP_PROVIDER;
  return (raw ?? "stub").toLowerCase() !== "stub";
}

export function hasWhatsAppTemplate(config: {
  templateWhatsAppName: string | null;
  templateWhatsAppLanguage: string | null;
}): boolean {
  return Boolean(
    config.templateWhatsAppName &&
      config.templateWhatsAppName.trim().length > 0 &&
      config.templateWhatsAppLanguage &&
      config.templateWhatsAppLanguage.trim().length > 0,
  );
}
