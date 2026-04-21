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
  WhatsAppDocumentMessage,
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

// ---- buildRequestBody: document (P17-A) ----
//
// Documents are the second media path we wire up: standalone
// in-session document messages (this section) and template-with-
// document-header (below). Both share the `WhatsAppDocumentRef`
// shape, so drift across the two branches is the primary concern.

test("buildRequestBody: standalone document (id) produces Meta document-by-id shape", () => {
  // Invitation PDF sent in-session via a previously-uploaded
  // media object. `mediaId` is the id Meta / Taqnyat's /media
  // endpoint returned after upload (P17-B); referenced here by
  // value only.
  const msg: WhatsAppDocumentMessage = {
    kind: "document",
    to: "966500000000",
    document: {
      kind: "id",
      mediaId: "wa_media_42",
      filename: "invitation.pdf",
    },
  };
  const out = buildRequestBody("966500000000", msg, undefined);
  assert.deepEqual(out, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "966500000000",
    type: "document",
    document: {
      id: "wa_media_42",
      filename: "invitation.pdf",
    },
  });
});

test("buildRequestBody: standalone document (link) produces Meta document-by-link shape", () => {
  // Alternative path: Meta fetches the URL directly. Used when
  // the PDF is already hosted (signed URL in object storage) so
  // we don't need the /media upload round-trip. `filename`
  // remains recommended so the recipient's WhatsApp shows a
  // human-readable name instead of a URL path.
  const msg: WhatsAppDocumentMessage = {
    kind: "document",
    to: "966500000000",
    document: {
      kind: "link",
      link: "https://cdn.example.com/invites/eid-2026/abc.pdf",
      filename: "eid-invitation.pdf",
    },
  };
  const out = buildRequestBody("966500000000", msg, undefined);
  assert.deepEqual(out, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: "966500000000",
    type: "document",
    document: {
      link: "https://cdn.example.com/invites/eid-2026/abc.pdf",
      filename: "eid-invitation.pdf",
    },
  });
});

test("buildRequestBody: document without filename omits the field (Meta derives from URL)", () => {
  // Upstream behaviour pin: when no filename is supplied, the
  // field MUST be absent. Sending `filename: ""` would land in
  // Meta's response with a literal empty string in chat UI. The
  // adapter treats falsy filename as "don't set it at all".
  const msg: WhatsAppDocumentMessage = {
    kind: "document",
    to: "966500000000",
    document: { kind: "id", mediaId: "m_1" },
  };
  const out = buildRequestBody("966500000000", msg, undefined) as {
    document: Record<string, unknown>;
  };
  assert.equal(out.document.id, "m_1");
  assert.equal(
    out.document.filename,
    undefined,
    "missing filename must not appear in the body",
  );
});

test("buildRequestBody: document with empty-string filename omits the field", () => {
  // Same pin as above, but protects against an upstream caller
  // that derived filename from a URL path and got "" back.
  const msg: WhatsAppDocumentMessage = {
    kind: "document",
    to: "966500000000",
    document: { kind: "id", mediaId: "m_1", filename: "" },
  };
  const out = buildRequestBody("966500000000", msg, undefined) as {
    document: Record<string, unknown>;
  };
  assert.equal(
    out.document.filename,
    undefined,
    "empty-string filename must be treated the same as missing",
  );
});

test("buildRequestBody: document caption is included only when non-empty", () => {
  // Caption is the ONLY field that differs between standalone
  // document and template-header-document: standalone accepts it,
  // header does not. This test pins the standalone caption path
  // end-to-end; the "no caption on header" path is pinned below.
  const msgWith: WhatsAppDocumentMessage = {
    kind: "document",
    to: "966500000000",
    document: { kind: "id", mediaId: "m_1" },
    caption: "Your invitation",
  };
  const msgEmpty: WhatsAppDocumentMessage = {
    kind: "document",
    to: "966500000000",
    document: { kind: "id", mediaId: "m_1" },
    caption: "",
  };
  const outWith = buildRequestBody("966500000000", msgWith, undefined) as {
    document: Record<string, unknown>;
  };
  const outEmpty = buildRequestBody("966500000000", msgEmpty, undefined) as {
    document: Record<string, unknown>;
  };
  assert.equal(outWith.document.caption, "Your invitation");
  assert.equal(
    outEmpty.document.caption,
    undefined,
    "empty-string caption must not appear in the body",
  );
});

// ---- buildRequestBody: template with document header (P17-A) ----
//
// The production use case: the operator-approved Meta template
// whose HEADER is of DOCUMENT type carries the invitation PDF as
// a header parameter, with BODY variables filling in recipient-
// specific text. The shape below is what Meta/Taqnyat expects.

test("buildRequestBody: template with headerDocument (id) emits header component", () => {
  // Invitation-PDF happy path. `headerDocument.kind === 'id'`
  // because the operator uploaded the PDF once and now sends it
  // to N recipients — the /media upload is amortised.
  const msg: WhatsAppTemplateMessage = {
    kind: "template",
    to: "966500000000",
    templateName: "moather2026_moather2026",
    languageCode: "ar",
    headerDocument: {
      kind: "id",
      mediaId: "wa_media_42",
      filename: "invitation.pdf",
    },
  };
  const out = buildRequestBody("966500000000", msg, undefined) as {
    template: {
      components?: Array<Record<string, unknown>>;
    };
  };
  assert.equal(out.template.components?.length, 1);
  assert.deepEqual(out.template.components?.[0], {
    type: "header",
    parameters: [
      {
        type: "document",
        document: {
          id: "wa_media_42",
          filename: "invitation.pdf",
        },
      },
    ],
  });
});

test("buildRequestBody: template with headerDocument (link) emits header component", () => {
  const msg: WhatsAppTemplateMessage = {
    kind: "template",
    to: "966500000000",
    templateName: "moather2026_moather2026",
    languageCode: "ar",
    headerDocument: {
      kind: "link",
      link: "https://cdn.example.com/invites/eid-2026/abc.pdf",
      filename: "eid-invitation.pdf",
    },
  };
  const out = buildRequestBody("966500000000", msg, undefined) as {
    template: {
      components?: Array<Record<string, unknown>>;
    };
  };
  assert.deepEqual(out.template.components?.[0], {
    type: "header",
    parameters: [
      {
        type: "document",
        document: {
          link: "https://cdn.example.com/invites/eid-2026/abc.pdf",
          filename: "eid-invitation.pdf",
        },
      },
    ],
  });
});

test("buildRequestBody: template with headerDocument + variables → header THEN body components (order matters)", () => {
  // Meta's template renderer expects components in the order
  // [HEADER, BODY, BUTTONS]. Sending BODY-before-HEADER is
  // accepted by some BSP proxies but explicitly not guaranteed.
  // This test pins the order so a refactor that flipped the
  // array construction doesn't silently break prod renders.
  const msg: WhatsAppTemplateMessage = {
    kind: "template",
    to: "966500000000",
    templateName: "moather2026_moather2026",
    languageCode: "ar",
    headerDocument: { kind: "id", mediaId: "m_1", filename: "x.pdf" },
    variables: ["Ahmad", "Friday 8 PM"],
  };
  const out = buildRequestBody("966500000000", msg, undefined) as {
    template: {
      components?: Array<{ type: string }>;
    };
  };
  assert.equal(out.template.components?.length, 2);
  assert.equal(
    out.template.components?.[0].type,
    "header",
    "HEADER must come first in the components array",
  );
  assert.equal(
    out.template.components?.[1].type,
    "body",
    "BODY must come after HEADER",
  );
});

test("buildRequestBody: template with headerDocument and NO variables omits the body component", () => {
  // Header-only template: the approved template has a DOCUMENT
  // header but no BODY variables (e.g. a fixed-text invitation
  // footer). The components array must contain the header only;
  // no empty body component.
  const msg: WhatsAppTemplateMessage = {
    kind: "template",
    to: "966500000000",
    templateName: "doc_only",
    languageCode: "ar",
    headerDocument: { kind: "id", mediaId: "m_1" },
  };
  const out = buildRequestBody("966500000000", msg, undefined) as {
    template: {
      components?: Array<{ type: string }>;
    };
  };
  assert.equal(out.template.components?.length, 1);
  assert.equal(out.template.components?.[0].type, "header");
});

test("buildRequestBody: template headerDocument parameter does NOT carry caption", () => {
  // Meta rejects `caption` inside a header-component document
  // parameter. The type itself prevents this at compile time
  // (caption only exists on `WhatsAppDocumentMessage`, not on
  // `WhatsAppDocumentRef`), but this test pins the runtime
  // envelope so any future code that tried to shove caption in
  // via `as any` still fails at the shape boundary.
  const msg: WhatsAppTemplateMessage = {
    kind: "template",
    to: "966500000000",
    templateName: "moather2026_moather2026",
    languageCode: "ar",
    headerDocument: { kind: "id", mediaId: "m_1", filename: "x.pdf" },
  };
  const out = buildRequestBody("966500000000", msg, undefined) as {
    template: {
      components?: Array<{
        parameters?: Array<{ document?: Record<string, unknown> }>;
      }>;
    };
  };
  const param = out.template.components?.[0].parameters?.[0];
  assert.equal(param?.document?.caption, undefined);
});

test("buildRequestBody: template WITHOUT headerDocument or variables omits components entirely", () => {
  // Regression pin: the P11 no-variables case must survive the
  // P17-A refactor that rewrote `templateBody`. An empty
  // components array behaves differently from `components` being
  // absent in some Meta responses — we pick ABSENT to match the
  // pre-P17 contract the test on line ~115 originally fixed.
  const msg: WhatsAppTemplateMessage = {
    kind: "template",
    to: "966500000000",
    templateName: "plain",
    languageCode: "ar",
  };
  const out = buildRequestBody("966500000000", msg, undefined) as {
    template: { components?: unknown };
  };
  assert.equal(
    out.template.components,
    undefined,
    "no header and no variables → no components field at all",
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
  // into a single catch-all type. P17-A added the `document` arm,
  // so all three branches are narrowed here — a reviewer reading
  // the switch can read the full set of message kinds at a glance.
  const text: WhatsAppTextMessage = { kind: "text", to: "x", text: "y" };
  const template: WhatsAppTemplateMessage = {
    kind: "template",
    to: "x",
    templateName: "t",
    languageCode: "ar",
  };
  const document: WhatsAppDocumentMessage = {
    kind: "document",
    to: "x",
    document: { kind: "id", mediaId: "m" },
  };
  const all: WhatsAppMessage[] = [text, template, document];
  for (const m of all) {
    if (m.kind === "text") {
      assert.equal(typeof m.text, "string");
    } else if (m.kind === "template") {
      assert.equal(typeof m.templateName, "string");
      assert.equal(typeof m.languageCode, "string");
    } else {
      // m.kind === "document"
      assert.equal(typeof m.document, "object");
    }
  }
});
