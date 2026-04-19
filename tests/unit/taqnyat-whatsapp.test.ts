import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildRequestBody,
  taqnyatWhatsApp,
} from "../../src/lib/providers/whatsapp/taqnyat";
import { stubWhatsApp } from "../../src/lib/providers/whatsapp/stub";
import {
  _resetProvidersForTests,
  getWhatsAppProvider,
} from "../../src/lib/providers";
import type {
  WhatsAppMessage,
  WhatsAppTemplateMessage,
  WhatsAppTextMessage,
} from "../../src/lib/providers/types";

// P11 — Taqnyat WhatsApp channel.
//
// Three boundaries get pinned here:
//
//   (a) REQUEST BODY shape: session-text, template without vars,
//       template with vars, template namespace inclusion. The
//       build function is pure, so direct coverage catches any
//       silent drift against Taqnyat/Meta's expected JSON shape
//       before a live send does.
//
//   (b) SEND transport: URL, Bearer auth, Content-Type, number
//       normalization, Meta-envelope identifier extraction, schema
//       tolerance fallbacks.
//
//   (c) FACTORY resolution: default=stub, taqnyat requires token,
//       resolution is cached until the test hook resets it.

type CapturedFetchCall = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  bodyText?: string;
};

type FakeFetchOpts = {
  status?: number;
  responseJson?: unknown;
};

function installFakeFetch(
  opts: FakeFetchOpts = {},
  captured: CapturedFetchCall[] = [],
) {
  const status = opts.status ?? 200;
  const body = opts.responseJson ?? {
    messaging_product: "whatsapp",
    messages: [{ id: "wamid.test_1" }],
  };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k] = h[k];
    }
    captured.push({
      url,
      method: init?.method,
      headers,
      bodyText: typeof init?.body === "string" ? init.body : undefined,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// ---- buildRequestBody: session text ----

test("buildRequestBody: text message produces Meta session-text shape", () => {
  const msg: WhatsAppTextMessage = {
    kind: "text",
    to: "966500000000",
    text: "welcome",
  };
  const out = buildRequestBody("966500000000", msg, undefined);
  assert.deepEqual(out, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "966500000000",
    type: "text",
    text: { body: "welcome" },
  });
});

// ---- buildRequestBody: template ----

test("buildRequestBody: template with no variables omits components array", () => {
  const msg: WhatsAppTemplateMessage = {
    kind: "template",
    to: "966500000000",
    templateName: "hello_world",
    languageCode: "ar",
  };
  const out = buildRequestBody("966500000000", msg, undefined) as {
    template: Record<string, unknown>;
  };
  const template = out.template;
  assert.equal(template.name, "hello_world");
  assert.deepEqual(template.language, { code: "ar" });
  assert.equal(
    template.components,
    undefined,
    "no variables → no components (Meta accepts either absence or empty array; we pick absence)",
  );
  assert.equal(
    template.namespace,
    undefined,
    "no namespace passed → no namespace field",
  );
});

test("buildRequestBody: template variables become ordered BODY parameters", () => {
  const msg: WhatsAppTemplateMessage = {
    kind: "template",
    to: "966500000000",
    templateName: "rsvp_reminder",
    languageCode: "ar",
    variables: ["Ahmad", "Friday 8 PM"],
  };
  const out = buildRequestBody("966500000000", msg, undefined) as {
    template: {
      components?: Array<{
        type: string;
        parameters?: Array<{ type: string; text: string }>;
      }>;
    };
  };
  assert.equal(out.template.components?.length, 1);
  assert.equal(out.template.components?.[0].type, "body");
  assert.deepEqual(out.template.components?.[0].parameters, [
    { type: "text", text: "Ahmad" },
    { type: "text", text: "Friday 8 PM" },
  ]);
});

test("buildRequestBody: template namespace is included only when non-empty", () => {
  const msg: WhatsAppTemplateMessage = {
    kind: "template",
    to: "966500000000",
    templateName: "hello",
    languageCode: "en_US",
  };
  const withNs = buildRequestBody("966500000000", msg, "abc-namespace") as {
    template: { namespace?: string };
  };
  const withoutNs = buildRequestBody("966500000000", msg, "") as {
    template: { namespace?: string };
  };
  assert.equal(withNs.template.namespace, "abc-namespace");
  assert.equal(
    withoutNs.template.namespace,
    undefined,
    "empty string namespace must not appear in the body",
  );
});

// ---- send: transport ----

test("send: POSTs to wa/v2/messages/ with Bearer auth + JSON content-type", async () => {
  const captured: CapturedFetchCall[] = [];
  const restore = installFakeFetch({}, captured);
  try {
    const provider = taqnyatWhatsApp({ token: "tok_wa" });
    await provider.send({
      kind: "text",
      to: "+966500000000",
      text: "hi",
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, "https://api.taqnyat.sa/wa/v2/messages/");
    assert.equal(captured[0].method, "POST");
    assert.equal(captured[0].headers?.Authorization, "Bearer tok_wa");
    assert.equal(captured[0].headers?.["Content-Type"], "application/json");
  } finally {
    restore();
  }
});

test("send: normalizes +E.164 to `+`-stripped recipient before dispatching", async () => {
  const captured: CapturedFetchCall[] = [];
  const restore = installFakeFetch({}, captured);
  try {
    const provider = taqnyatWhatsApp({ token: "tok" });
    await provider.send({
      kind: "text",
      to: "+966500000000",
      text: "x",
    });
    const parsed = JSON.parse(captured[0].bodyText ?? "{}") as { to: string };
    assert.equal(parsed.to, "966500000000");
  } finally {
    restore();
  }
});

test("send: extracts Meta envelope `messages[0].id` as providerId", async () => {
  const restore = installFakeFetch({
    status: 200,
    responseJson: {
      messaging_product: "whatsapp",
      messages: [{ id: "wamid.ABC123" }],
    },
  });
  try {
    const provider = taqnyatWhatsApp({ token: "tok" });
    const res = await provider.send({
      kind: "text",
      to: "+966500000000",
      text: "x",
    });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.providerId, "wamid.ABC123");
  } finally {
    restore();
  }
});

test("send: falls back to top-level `messageId` if Meta envelope is absent", async () => {
  const restore = installFakeFetch({
    status: 200,
    responseJson: { messageId: "mid_42" },
  });
  try {
    const provider = taqnyatWhatsApp({ token: "tok" });
    const res = await provider.send({
      kind: "text",
      to: "+966500000000",
      text: "x",
    });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.providerId, "mid_42");
  } finally {
    restore();
  }
});

test("send: 400 with nested error.message is non-retryable and surfaces provider message", async () => {
  const restore = installFakeFetch({
    status: 400,
    responseJson: { error: { message: "template not approved" } },
  });
  try {
    const provider = taqnyatWhatsApp({ token: "tok" });
    const res = await provider.send({
      kind: "template",
      to: "+966500000000",
      templateName: "bad",
      languageCode: "ar",
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.match(res.error, /whatsapp 400/);
      assert.match(res.error, /template not approved/);
      assert.equal(res.retryable, false);
    }
  } finally {
    restore();
  }
});

test("send: 500 upstream error is retryable", async () => {
  const restore = installFakeFetch({
    status: 500,
    responseJson: { message: "meta_unreachable" },
  });
  try {
    const provider = taqnyatWhatsApp({ token: "tok" });
    const res = await provider.send({
      kind: "text",
      to: "+966500000000",
      text: "x",
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.retryable, true);
      assert.match(res.error, /whatsapp 500/);
    }
  } finally {
    restore();
  }
});

test("send: 200 with no identifier anywhere is treated as failure (not silent success)", async () => {
  // Taqnyat / Meta shouldn't return a 2xx without an identifier,
  // but if they do, we refuse to fabricate a success — the
  // downstream campaign pipeline relies on providerId being a real
  // traceable reference for delivery status.
  const restore = installFakeFetch({
    status: 200,
    responseJson: { messaging_product: "whatsapp" },
  });
  try {
    const provider = taqnyatWhatsApp({ token: "tok" });
    const res = await provider.send({
      kind: "text",
      to: "+966500000000",
      text: "x",
    });
    assert.equal(res.ok, false);
  } finally {
    restore();
  }
});

test("send: provider.name is 'taqnyat-whatsapp' for audit attribution", () => {
  const provider = taqnyatWhatsApp({ token: "tok" });
  assert.equal(provider.name, "taqnyat-whatsapp");
});

// ---- factory ----

test("getWhatsAppProvider: defaults to stub when WHATSAPP_PROVIDER is unset", () => {
  const originalProvider = process.env.WHATSAPP_PROVIDER;
  delete process.env.WHATSAPP_PROVIDER;
  _resetProvidersForTests();
  try {
    const p = getWhatsAppProvider();
    assert.equal(p, stubWhatsApp);
    assert.equal(p.name, "stub-whatsapp");
  } finally {
    if (originalProvider !== undefined) {
      process.env.WHATSAPP_PROVIDER = originalProvider;
    }
    _resetProvidersForTests();
  }
});

test("getWhatsAppProvider: WHATSAPP_PROVIDER=taqnyat resolves to taqnyat adapter", () => {
  const originalProvider = process.env.WHATSAPP_PROVIDER;
  const originalToken = process.env.TAQNYAT_WHATSAPP_TOKEN;
  process.env.WHATSAPP_PROVIDER = "taqnyat";
  process.env.TAQNYAT_WHATSAPP_TOKEN = "wa_test_token";
  _resetProvidersForTests();
  try {
    const p = getWhatsAppProvider();
    assert.equal(p.name, "taqnyat-whatsapp");
  } finally {
    if (originalProvider !== undefined) {
      process.env.WHATSAPP_PROVIDER = originalProvider;
    } else delete process.env.WHATSAPP_PROVIDER;
    if (originalToken !== undefined) {
      process.env.TAQNYAT_WHATSAPP_TOKEN = originalToken;
    } else delete process.env.TAQNYAT_WHATSAPP_TOKEN;
    _resetProvidersForTests();
  }
});

test("getWhatsAppProvider: taqnyat without TAQNYAT_WHATSAPP_TOKEN throws (missing env is a config bug, not a runtime state)", () => {
  const originalProvider = process.env.WHATSAPP_PROVIDER;
  const originalToken = process.env.TAQNYAT_WHATSAPP_TOKEN;
  process.env.WHATSAPP_PROVIDER = "taqnyat";
  delete process.env.TAQNYAT_WHATSAPP_TOKEN;
  _resetProvidersForTests();
  try {
    assert.throws(() => getWhatsAppProvider(), /TAQNYAT_WHATSAPP_TOKEN/);
  } finally {
    if (originalProvider !== undefined) {
      process.env.WHATSAPP_PROVIDER = originalProvider;
    } else delete process.env.WHATSAPP_PROVIDER;
    if (originalToken !== undefined) {
      process.env.TAQNYAT_WHATSAPP_TOKEN = originalToken;
    }
    _resetProvidersForTests();
  }
});

// ---- channel type discipline ----

test("WhatsAppMessage discriminates by `kind` at the type level", () => {
  // Type-level only: if the discriminant goes missing, this file
  // won't compile. The runtime assertions are trivial but the
  // file-level pin prevents a refactor from flattening the union
  // into a single catch-all type.
  const text: WhatsAppTextMessage = { kind: "text", to: "x", text: "y" };
  const template: WhatsAppTemplateMessage = {
    kind: "template",
    to: "x",
    templateName: "t",
    languageCode: "ar",
  };
  const all: WhatsAppMessage[] = [text, template];
  for (const m of all) {
    if (m.kind === "text") assert.equal(typeof m.text, "string");
    else {
      assert.equal(typeof m.templateName, "string");
      assert.equal(typeof m.languageCode, "string");
    }
  }
});
