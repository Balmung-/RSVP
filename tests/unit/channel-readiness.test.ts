import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCampaignChannelReadiness,
  buildInviteeChannelReadiness,
} from "../../src/lib/channel-readiness";

test("campaign readiness marks provider-off SMS as setup needed instead of ready", () => {
  const channels = buildCampaignChannelReadiness({
    campaign: {
      templateEmail: "hello",
      templateSms: "hi",
      templateWhatsAppName: "moather2026_moather2026",
      templateWhatsAppLanguage: "ar",
      whatsappDocumentUploadId: "file_123",
    },
    providers: {
      emailEnabled: true,
      smsEnabled: false,
      whatsappEnabled: true,
    },
    inviteesWithEmail: 3,
    inviteesWithPhone: 5,
  });

  assert.equal(channels.find((channel) => channel.channel === "sms")?.ready, false);
  assert.equal(
    channels.find((channel) => channel.channel === "sms")?.reason,
    "Provider is off",
  );
});

test("invitee readiness makes phone-only contact WhatsApp-ready when approved template + PDF are configured", () => {
  const channels = buildInviteeChannelReadiness({
    campaign: {
      templateEmail: null,
      templateSms: null,
      templateWhatsAppName: "moather2026_moather2026",
      templateWhatsAppLanguage: "ar",
      whatsappDocumentUploadId: "file_123",
    },
    invitee: {
      email: null,
      phoneE164: "+966501234567",
    },
    providers: {
      emailEnabled: false,
      smsEnabled: false,
      whatsappEnabled: true,
    },
  });

  assert.equal(channels.find((channel) => channel.channel === "whatsapp")?.ready, true);
  assert.match(
    channels.find((channel) => channel.channel === "whatsapp")?.detail ?? "",
    /Invitation PDF \(AR\)/,
  );
});

test("campaign readiness explains missing approved WhatsApp template", () => {
  const channels = buildCampaignChannelReadiness({
    campaign: {
      templateEmail: "hello",
      templateSms: "hi",
      templateWhatsAppName: null,
      templateWhatsAppLanguage: null,
      whatsappDocumentUploadId: null,
    },
    providers: {
      emailEnabled: true,
      smsEnabled: true,
      whatsappEnabled: true,
    },
    inviteesWithEmail: 3,
    inviteesWithPhone: 5,
  });

  assert.equal(channels.find((channel) => channel.channel === "whatsapp")?.ready, false);
  assert.equal(
    channels.find((channel) => channel.channel === "whatsapp")?.reason,
    "Choose an approved WhatsApp template",
  );
});

test("campaign readiness marks approved document template incomplete when PDF is missing", () => {
  const channels = buildCampaignChannelReadiness({
    campaign: {
      templateEmail: null,
      templateSms: null,
      templateWhatsAppName: "moather2026_moather2026",
      templateWhatsAppLanguage: "ar",
      whatsappDocumentUploadId: null,
    },
    providers: {
      emailEnabled: false,
      smsEnabled: false,
      whatsappEnabled: true,
    },
    inviteesWithEmail: 0,
    inviteesWithPhone: 5,
  });

  assert.equal(channels.find((channel) => channel.channel === "whatsapp")?.ready, false);
  assert.equal(
    channels.find((channel) => channel.channel === "whatsapp")?.reason,
    "Invitation PDF is required",
  );
});
