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
      templateWhatsAppName: "approved_template",
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

test("invitee readiness makes phone-only contact WhatsApp-ready when SMS is off", () => {
  const channels = buildInviteeChannelReadiness({
    campaign: {
      templateEmail: null,
      templateSms: null,
      templateWhatsAppName: "approved_template",
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

  assert.equal(channels.find((channel) => channel.channel === "email")?.ready, false);
  assert.equal(channels.find((channel) => channel.channel === "sms")?.ready, false);
  assert.equal(channels.find((channel) => channel.channel === "whatsapp")?.ready, true);
  assert.match(
    channels.find((channel) => channel.channel === "whatsapp")?.detail ?? "",
    /approved_template/,
  );
});

test("invitee readiness explains missing WhatsApp template instead of hiding the channel reason", () => {
  const channels = buildInviteeChannelReadiness({
    campaign: {
      templateEmail: "hello",
      templateSms: "hi",
      templateWhatsAppName: null,
      templateWhatsAppLanguage: null,
      whatsappDocumentUploadId: null,
    },
    invitee: {
      email: "person@example.com",
      phoneE164: "+966501234567",
    },
    providers: {
      emailEnabled: true,
      smsEnabled: true,
      whatsappEnabled: true,
    },
  });

  assert.equal(channels.find((channel) => channel.channel === "whatsapp")?.ready, false);
  assert.equal(
    channels.find((channel) => channel.channel === "whatsapp")?.reason,
    "Campaign name and language are required",
  );
});

test("campaign readiness pinpoints a missing WhatsApp language when the template name exists", () => {
  const channels = buildCampaignChannelReadiness({
    campaign: {
      templateEmail: null,
      templateSms: null,
      templateWhatsAppName: "moather2026_moather2026",
      templateWhatsAppLanguage: null,
      whatsappDocumentUploadId: "file_123",
    },
    providers: {
      emailEnabled: false,
      smsEnabled: false,
      whatsappEnabled: true,
    },
    inviteesWithEmail: 0,
    inviteesWithPhone: 5,
  });

  assert.equal(
    channels.find((channel) => channel.channel === "whatsapp")?.reason,
    "Template language is required",
  );
});
