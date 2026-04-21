import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildMediaUploadFormData,
  taqnyatUploadMedia,
} from "../../src/lib/providers/whatsapp/taqnyat";

// P17-B — Taqnyat WhatsApp media upload seam.
//
// Three boundaries get pinned here:
//
//   (a) FORMDATA shape: the multipart field set Taqnyat/Meta
//       actually accepts. The field names (`messaging_product`,
//       `type`, `file`) are pinned exactly — a silent rename
//       (e.g. a future refactor that `append`s "product" instead)
//       would get rejected by Meta's multipart parser with a
//       generic 4xx, and the live error would be opaque. Pure
//       unit coverage catches this before a live upload does.
//
//   (b) UPLOADER transport: URL (with trailing slash), POST,
//       Bearer auth, explicitly NO manually-set Content-Type
//       (the FormData serializer writes `multipart/form-data;
//       boundary=...` itself; overriding drops the boundary),
//       body is a FormData instance.
//
//   (c) RESPONSE tolerance: primary `{ id }` envelope plus the
//       nested-wrapper fallback `{ media: { id } }`, plus the
//       refuse-to-fabricate-success discipline for 2xx without id.
//
// The uploader is NOT on the WhatsAppProvider interface — it's
// a standalone named export. See taqnyat.ts comment block for
// rationale (stub providers don't need a fake; the interface
// stays minimal).

// ---- test helpers ----

type CapturedFetchCall = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
};

type FakeFetchOpts = {
  status?: number;
  responseJson?: unknown;
  // Opt-out of JSON parsing for the malformed-body test.
  malformedJson?: boolean;
};

// FormData-aware fake. Unlike the JSON stub in
// tests/unit/taqnyat-whatsapp.test.ts, we capture the raw `body`
// (no `typeof === "string"` filter) so the multipart FormData
// reaches the test's assertions intact.
function installFakeFetch(
  opts: FakeFetchOpts = {},
  captured: CapturedFetchCall[] = [],
) {
  const status = opts.status ?? 200;
  const json = opts.responseJson ?? { id: "wa-media-test" };
  const fake = (async (input: unknown, init?: RequestInit) => {
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
      body: init?.body,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (opts.malformedJson) {
          throw new SyntaxError("unexpected token");
        }
        return json;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return fake;
}

// ---- buildMediaUploadFormData: pure shape ----

test("buildMediaUploadFormData: appends messaging_product='whatsapp'", () => {
  const form = buildMediaUploadFormData(
    new Uint8Array([1, 2, 3]),
    "invite.pdf",
    "application/pdf",
  );
  // Pinned: Meta requires this literal field on every WhatsApp
  // Cloud API request, uploads included. A refactor that renames
  // the field (e.g. to "product" or "messagingProduct") would
  // silently fail at Meta's side with a generic 4xx.
  assert.equal(form.get("messaging_product"), "whatsapp");
});

test("buildMediaUploadFormData: appends type=<mimeType>", () => {
  const form = buildMediaUploadFormData(
    new Uint8Array([1, 2, 3]),
    "invite.pdf",
    "application/pdf",
  );
  assert.equal(form.get("type"), "application/pdf");
});

test("buildMediaUploadFormData: preserves mimeType for image payloads", () => {
  // Defensive: not all WhatsApp media is PDF. When future flows
  // upload PNG/JPEG, the `type` field has to carry the actual
  // content MIME, not a hardcoded "application/pdf".
  const form = buildMediaUploadFormData(
    new Uint8Array([0, 1, 2]),
    "banner.png",
    "image/png",
  );
  assert.equal(form.get("type"), "image/png");
});

test("buildMediaUploadFormData: file part has filename and MIME type", () => {
  const form = buildMediaUploadFormData(
    new Uint8Array([1, 2, 3]),
    "invite.pdf",
    "application/pdf",
  );
  const filePart = form.get("file");
  assert.ok(filePart, "file part must exist");
  // FormData returns a File (or Blob) instance. We pin the
  // filename on the multipart part — without it, Meta derives
  // the filename from nothing and the recipient sees a UUID in
  // their WhatsApp preview.
  const asFile = filePart as File;
  assert.equal(asFile.name, "invite.pdf");
  assert.equal(asFile.type, "application/pdf");
});

test("buildMediaUploadFormData: file part preserves exact byte content", async () => {
  // Anti-drift pin: if someone refactors the Blob wrap to go
  // through a string conversion (e.g. `new Blob([bytes.toString()])`),
  // the bytes get corrupted for any non-ASCII content (PDFs
  // are binary). This reads the part back and compares bytes.
  const original = new Uint8Array([0xff, 0x00, 0x01, 0x7f, 0x80]);
  const form = buildMediaUploadFormData(
    original,
    "binary.pdf",
    "application/pdf",
  );
  const filePart = form.get("file") as Blob;
  const buf = new Uint8Array(await filePart.arrayBuffer());
  assert.equal(buf.byteLength, original.byteLength);
  for (let i = 0; i < original.byteLength; i++) {
    assert.equal(buf[i], original[i], `byte ${i} mismatch`);
  }
});

test("buildMediaUploadFormData: exactly three fields (no drift, no extras)", () => {
  // The Meta upload envelope accepts exactly three fields. An
  // accidental `form.append("something_else", ...)` drift (e.g.
  // a phone-number-id field copied from the send envelope) gets
  // caught here. Also an anti-regression: the FILE part must
  // still be present — a refactor that splits it out would break
  // this assertion.
  const form = buildMediaUploadFormData(
    new Uint8Array([1]),
    "a.pdf",
    "application/pdf",
  );
  const keys: string[] = [];
  for (const k of form.keys()) keys.push(k);
  keys.sort();
  assert.deepEqual(keys, ["file", "messaging_product", "type"]);
});

// ---- taqnyatUploadMedia: transport shape ----

test("taqnyatUploadMedia: happy path returns ok:true with id-kind ref carrying filename", async () => {
  const captured: CapturedFetchCall[] = [];
  const fake = installFakeFetch(
    { status: 200, responseJson: { id: "wa-media-xyz" } },
    captured,
  );
  const r = await taqnyatUploadMedia({
    token: "tok",
    bytes: new Uint8Array([1, 2, 3]),
    filename: "invite.pdf",
    mimeType: "application/pdf",
    fetchImpl: fake,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // The returned ref is the exact shape downstream callers feed
  // into `headerDocument` or standalone `document`. Pinned as a
  // deepEqual so any drift in the ref construction trips here.
  assert.deepEqual(r.ref, {
    kind: "id",
    mediaId: "wa-media-xyz",
    filename: "invite.pdf",
  });
});

test("taqnyatUploadMedia: POSTs to https://api.taqnyat.sa/wa/v2/media/ (trailing slash)", async () => {
  const captured: CapturedFetchCall[] = [];
  const fake = installFakeFetch({}, captured);
  await taqnyatUploadMedia({
    token: "tok",
    bytes: new Uint8Array([1]),
    filename: "a.pdf",
    mimeType: "application/pdf",
    fetchImpl: fake,
  });
  assert.equal(captured.length, 1);
  // Trailing slash is part of Taqnyat's URL convention — mirrors
  // the send endpoint's `/wa/v2/messages/`. Omitting the slash
  // gets a 301 that some fetch implementations follow silently
  // and others don't; pinning the slash avoids the ambiguity.
  assert.equal(captured[0]!.url, "https://api.taqnyat.sa/wa/v2/media/");
  assert.equal(captured[0]!.method, "POST");
});

test("taqnyatUploadMedia: sets Authorization: Bearer <token>", async () => {
  const captured: CapturedFetchCall[] = [];
  const fake = installFakeFetch({}, captured);
  await taqnyatUploadMedia({
    token: "tok-abc-123",
    bytes: new Uint8Array([1]),
    filename: "a.pdf",
    mimeType: "application/pdf",
    fetchImpl: fake,
  });
  assert.equal(captured[0]!.headers?.Authorization, "Bearer tok-abc-123");
});

test("taqnyatUploadMedia: does NOT set Content-Type manually (runtime adds boundary)", async () => {
  // CRITICAL pin: if a future refactor adds
  // `Content-Type: multipart/form-data` without a boundary, the
  // request body won't parse on Meta's side and the upload fails
  // with a cryptic error. The FormData serializer writes the
  // header WITH the boundary; we must leave it alone.
  const captured: CapturedFetchCall[] = [];
  const fake = installFakeFetch({}, captured);
  await taqnyatUploadMedia({
    token: "tok",
    bytes: new Uint8Array([1]),
    filename: "a.pdf",
    mimeType: "application/pdf",
    fetchImpl: fake,
  });
  const headers = captured[0]!.headers ?? {};
  // Accept either exact-key absence or any casing — some fetch
  // implementations normalise header casing. The pin is: WE
  // didn't set it.
  const hasContentType = Object.keys(headers).some(
    (k) => k.toLowerCase() === "content-type",
  );
  assert.equal(
    hasContentType,
    false,
    "Content-Type must not be set manually on media upload",
  );
});

test("taqnyatUploadMedia: body is a FormData instance", async () => {
  const captured: CapturedFetchCall[] = [];
  const fake = installFakeFetch({}, captured);
  await taqnyatUploadMedia({
    token: "tok",
    bytes: new Uint8Array([1]),
    filename: "a.pdf",
    mimeType: "application/pdf",
    fetchImpl: fake,
  });
  const body = captured[0]!.body;
  assert.ok(
    body instanceof FormData,
    "body must be a FormData for multipart upload",
  );
});

// ---- taqnyatUploadMedia: response-shape tolerance ----

test("taqnyatUploadMedia: tolerates { media: { id } } nested response shape", async () => {
  // Forward-compat: if Taqnyat wraps Meta's response in an envelope
  // (as some BSPs do), the uploader still extracts the id. We
  // don't depend on the wrapper being present — flat is primary —
  // but we don't break if it appears.
  const fake = installFakeFetch({
    status: 200,
    responseJson: { media: { id: "wa-media-nested" } },
  });
  const r = await taqnyatUploadMedia({
    token: "tok",
    bytes: new Uint8Array([1]),
    filename: "a.pdf",
    mimeType: "application/pdf",
    fetchImpl: fake,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.ref.kind, "id");
  if (r.ref.kind === "id") {
    assert.equal(r.ref.mediaId, "wa-media-nested");
  }
});

test("taqnyatUploadMedia: 200 with NO id in any shape is treated as failure", async () => {
  // Refuse-to-fabricate pin (same discipline as the send path).
  // A 2xx without a usable id would otherwise return a success
  // with `mediaId: ""`, which downstream would fail in an
  // inscrutable way when the send envelope hits Meta.
  const fake = installFakeFetch({
    status: 200,
    responseJson: { messaging_product: "whatsapp" },
  });
  const r = await taqnyatUploadMedia({
    token: "tok",
    bytes: new Uint8Array([1]),
    filename: "a.pdf",
    mimeType: "application/pdf",
    fetchImpl: fake,
  });
  assert.equal(r.ok, false);
});

test("taqnyatUploadMedia: 500 returns ok:false retryable:true", async () => {
  const fake = installFakeFetch({
    status: 500,
    responseJson: { error: { message: "internal" } },
  });
  const r = await taqnyatUploadMedia({
    token: "tok",
    bytes: new Uint8Array([1]),
    filename: "a.pdf",
    mimeType: "application/pdf",
    fetchImpl: fake,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.retryable, true);
  assert.match(r.error, /whatsapp-media 500/);
  assert.match(r.error, /internal/);
});

test("taqnyatUploadMedia: 4xx returns ok:false retryable:false", async () => {
  const fake = installFakeFetch({
    status: 401,
    responseJson: { error: "invalid token" },
  });
  const r = await taqnyatUploadMedia({
    token: "tok",
    bytes: new Uint8Array([1]),
    filename: "a.pdf",
    mimeType: "application/pdf",
    fetchImpl: fake,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.retryable, false);
  assert.match(r.error, /whatsapp-media 401/);
  assert.match(r.error, /invalid token/);
});

// ---- Upload-Media id-discipline pins (GPT P17-B re-audit, 2026-04-21) ----
//
// GPT's re-audit flagged that the original `extractMediaId` accepted
// `messageId` / `requestId` as fallback candidates. Those fields are
// send-time correlators on `POST /messages/`, not media identifiers
// on `POST /media/`. Accepting them here would let the uploader
// return `{ ok: true, ref: { kind: "id", mediaId } }` built from the
// wrong identifier; the downstream send envelope would then try to
// reference a non-existent media id and fail opaquely at Meta.
//
// The discipline is: upload success REQUIRES one of Meta's two
// documented id shapes, `{ id }` flat or `{ media: { id } }` nested.
// Any other shape on a 200 is a refuse-to-fabricate ok:false.

test("taqnyatUploadMedia: { id } flat shape is the documented success (discipline pin)", async () => {
  // Companion to the happy-path test at the top of the file — this
  // one pins the discipline intent: the flat `{ id }` shape is the
  // documented Meta/Taqnyat Upload-Media response, accepted without
  // equivocation.
  const fake = installFakeFetch({
    status: 200,
    responseJson: { id: "wa-media-flat" },
  });
  const r = await taqnyatUploadMedia({
    token: "tok",
    bytes: new Uint8Array([1]),
    filename: "a.pdf",
    mimeType: "application/pdf",
    fetchImpl: fake,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  if (r.ref.kind === "id") {
    assert.equal(r.ref.mediaId, "wa-media-flat");
  }
});

test("taqnyatUploadMedia: { requestId } alone is NOT upload success (refuse-to-fabricate)", async () => {
  // Critical discipline pin. `requestId` is a send-time correlator
  // Taqnyat returns on `POST /messages/`, never a media identifier.
  // If the uploader ever promotes it to a `mediaId`, P17-C would
  // build a `WhatsAppDocumentRef` from the wrong id and fail at
  // send time with a cryptic Meta error. Pin the refusal here.
  const fake = installFakeFetch({
    status: 200,
    responseJson: { requestId: "req-abc-123" },
  });
  const r = await taqnyatUploadMedia({
    token: "tok",
    bytes: new Uint8Array([1]),
    filename: "a.pdf",
    mimeType: "application/pdf",
    fetchImpl: fake,
  });
  assert.equal(
    r.ok,
    false,
    "requestId is a send correlator, never a media id — must not be promoted",
  );
});

test("taqnyatUploadMedia: { messageId } alone is NOT upload success (refuse-to-fabricate)", async () => {
  // Same discipline as `requestId`: `messageId` lives on the send
  // path's response envelope as a correlator. Accepting it here
  // would let a broken Taqnyat response shape (or a future BSP
  // drift) silently corrupt the ref chain. Refuse at the boundary.
  const fake = installFakeFetch({
    status: 200,
    responseJson: { messageId: "msg-def-456" },
  });
  const r = await taqnyatUploadMedia({
    token: "tok",
    bytes: new Uint8Array([1]),
    filename: "a.pdf",
    mimeType: "application/pdf",
    fetchImpl: fake,
  });
  assert.equal(
    r.ok,
    false,
    "messageId is a send correlator, never a media id — must not be promoted",
  );
});

test("taqnyatUploadMedia: { id, requestId } picks id (documented field wins over correlator)", async () => {
  // Defensive pin: if Taqnyat returns BOTH a documented `id` and a
  // `requestId` on an upload response (some BSPs return a request
  // correlator alongside the resource), the uploader must pick
  // `id`. If the order ever flipped in a refactor, this catches it.
  const fake = installFakeFetch({
    status: 200,
    responseJson: { id: "wa-media-ok", requestId: "req-noise" },
  });
  const r = await taqnyatUploadMedia({
    token: "tok",
    bytes: new Uint8Array([1]),
    filename: "a.pdf",
    mimeType: "application/pdf",
    fetchImpl: fake,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  if (r.ref.kind === "id") {
    assert.equal(
      r.ref.mediaId,
      "wa-media-ok",
      "documented id field must win over send-time correlator",
    );
  }
});

test("taqnyatUploadMedia: malformed JSON response body yields ok:false", async () => {
  // Malformed body → we swallow the parse error (`.catch(() => ({}))`)
  // and fall into the "no id found" path. The http status gate
  // still decides retryable. For a 200 with malformed body, this
  // is ok:false non-retryable (no retry point will help).
  const fake = installFakeFetch({ status: 200, malformedJson: true });
  const r = await taqnyatUploadMedia({
    token: "tok",
    bytes: new Uint8Array([1]),
    filename: "a.pdf",
    mimeType: "application/pdf",
    fetchImpl: fake,
  });
  assert.equal(r.ok, false);
});

// ---- taqnyatUploadMedia: short-circuit guards (no fetch call) ----

test("taqnyatUploadMedia: missing token short-circuits with no fetch call", async () => {
  const captured: CapturedFetchCall[] = [];
  const fake = installFakeFetch({}, captured);
  const r = await taqnyatUploadMedia({
    token: "",
    bytes: new Uint8Array([1]),
    filename: "a.pdf",
    mimeType: "application/pdf",
    fetchImpl: fake,
  });
  assert.equal(r.ok, false);
  assert.equal(captured.length, 0, "no fetch call on missing token");
});

test("taqnyatUploadMedia: missing filename short-circuits with no fetch call", async () => {
  // Anti-footgun: without a filename the returned ref is unusable
  // at send time (the template headerDocument and standalone
  // document shapes both carry filename forward). Catch the bug
  // here, not at send time.
  const captured: CapturedFetchCall[] = [];
  const fake = installFakeFetch({}, captured);
  const r = await taqnyatUploadMedia({
    token: "tok",
    bytes: new Uint8Array([1]),
    filename: "",
    mimeType: "application/pdf",
    fetchImpl: fake,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /filename/);
  assert.equal(captured.length, 0, "no fetch call on missing filename");
});

test("taqnyatUploadMedia: missing mimeType short-circuits with no fetch call", async () => {
  const captured: CapturedFetchCall[] = [];
  const fake = installFakeFetch({}, captured);
  const r = await taqnyatUploadMedia({
    token: "tok",
    bytes: new Uint8Array([1]),
    filename: "a.pdf",
    mimeType: "",
    fetchImpl: fake,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /mimeType/);
  assert.equal(captured.length, 0);
});

test("taqnyatUploadMedia: empty bytes short-circuits with no fetch call", async () => {
  // A 0-byte upload would either be rejected by Taqnyat's
  // multipart parser or accepted as a 0-byte document — both
  // bad outcomes. Short-circuit at the boundary.
  const captured: CapturedFetchCall[] = [];
  const fake = installFakeFetch({}, captured);
  const r = await taqnyatUploadMedia({
    token: "tok",
    bytes: new Uint8Array(0),
    filename: "a.pdf",
    mimeType: "application/pdf",
    fetchImpl: fake,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /empty/);
  assert.equal(captured.length, 0);
});

test("taqnyatUploadMedia: uses global fetch when fetchImpl is not injected", async () => {
  // Exercises the `globalThis.fetch` fallback branch. Installing
  // a global stub here and deliberately not passing fetchImpl.
  const originalFetch = globalThis.fetch;
  const captured: CapturedFetchCall[] = [];
  globalThis.fetch = installFakeFetch({}, captured);
  try {
    const r = await taqnyatUploadMedia({
      token: "tok",
      bytes: new Uint8Array([1]),
      filename: "a.pdf",
      mimeType: "application/pdf",
      // no fetchImpl
    });
    assert.equal(r.ok, true);
    assert.equal(captured.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
