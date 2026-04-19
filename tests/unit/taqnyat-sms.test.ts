import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeRecipient, taqnyat } from "../../src/lib/providers/sms/taqnyat";

// P10 — Taqnyat SMS provider.
//
// Request formatting, auth header, number normalization, and
// success/error mapping are pinned here so a future refactor of
// the adapter (or a drift in the Taqnyat schema) fails a test
// instead of a real outbound send.
//
// Tests intercept globalThis.fetch — the real Taqnyat endpoint is
// never hit. Each test restores fetch in a finally block so later
// tests always see the pristine global.

type CapturedFetchCall = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  bodyText?: string;
};

type FakeFetchOpts = {
  status?: number;
  responseJson?: unknown;
  rejectWith?: Error;
};

function installFakeFetch(
  opts: FakeFetchOpts = {},
  captured: CapturedFetchCall[] = [],
) {
  const status = opts.status ?? 201;
  const body = opts.responseJson ?? { statusCode: 201, messageId: "mid_1" };
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
    if (opts.rejectWith) throw opts.rejectWith;
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

// ---- normalizeRecipient ----

test("normalizeRecipient: strips leading `+` from E.164", () => {
  assert.equal(normalizeRecipient("+966500000000"), "966500000000");
});

test("normalizeRecipient: strips leading `00`", () => {
  assert.equal(normalizeRecipient("00966500000000"), "966500000000");
});

test("normalizeRecipient: passes bare digits through", () => {
  assert.equal(normalizeRecipient("966500000000"), "966500000000");
});

test("normalizeRecipient: trims surrounding whitespace before stripping", () => {
  assert.equal(normalizeRecipient("  +966500000000  "), "966500000000");
});

test("normalizeRecipient: `+00` stays intact after `+` strip → `00` is then stripped on next send if caller reuses; adapter only does one pass", () => {
  // The adapter is deliberately single-pass. A pathological
  // `+00966` would become `00966` which Taqnyat would reject as
  // a format error — that's the caller's contract violation, not
  // the adapter's. This test just documents that we DO NOT recurse.
  assert.equal(normalizeRecipient("+00966500000000"), "00966500000000");
});

// ---- success path ----

test("send: POSTs to /v1/messages with Bearer auth + JSON content-type", async () => {
  const captured: CapturedFetchCall[] = [];
  const restore = installFakeFetch({}, captured);
  try {
    const provider = taqnyat("tok_abc", "EINAI");
    await provider.send({ to: "+966500000000", body: "hi" });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, "https://api.taqnyat.sa/v1/messages");
    assert.equal(captured[0].method, "POST");
    assert.equal(captured[0].headers?.Authorization, "Bearer tok_abc");
    assert.equal(captured[0].headers?.["Content-Type"], "application/json");
  } finally {
    restore();
  }
});

test("send: body carries normalized recipient + sender + message body", async () => {
  const captured: CapturedFetchCall[] = [];
  const restore = installFakeFetch({}, captured);
  try {
    const provider = taqnyat("tok_abc", "EINAI");
    await provider.send({ to: "+966500000000", body: "welcome" });
    const parsed = JSON.parse(captured[0].bodyText ?? "{}") as {
      recipients: string[];
      body: string;
      sender: string;
    };
    assert.deepEqual(parsed.recipients, ["966500000000"]);
    assert.equal(parsed.body, "welcome");
    assert.equal(parsed.sender, "EINAI");
  } finally {
    restore();
  }
});

test("send: maps Taqnyat 201 response to {ok:true, providerId: messageId}", async () => {
  const restore = installFakeFetch({
    status: 201,
    responseJson: { statusCode: 201, messageId: "mid_xyz", Cost: 0.1 },
  });
  try {
    const provider = taqnyat("tok", "EINAI");
    const res = await provider.send({ to: "+966500000000", body: "x" });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.providerId, "mid_xyz");
  } finally {
    restore();
  }
});

test("send: falls back to requestId if messageId is missing (schema tolerance)", async () => {
  const restore = installFakeFetch({
    status: 201,
    responseJson: { statusCode: 201, requestId: "req_42" },
  });
  try {
    const provider = taqnyat("tok", "EINAI");
    const res = await provider.send({ to: "+966500000000", body: "x" });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.providerId, "req_42");
  } finally {
    restore();
  }
});

test("send: 2xx HTTP with identifier but no statusCode still succeeds (tolerant to minor schema drift)", async () => {
  const restore = installFakeFetch({
    status: 200,
    responseJson: { messageId: "mid_drift" },
  });
  try {
    const provider = taqnyat("tok", "EINAI");
    const res = await provider.send({ to: "+966500000000", body: "x" });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.providerId, "mid_drift");
  } finally {
    restore();
  }
});

// ---- failure path ----

test("send: 400 bad request is non-retryable and surfaces provider message", async () => {
  const restore = installFakeFetch({
    status: 400,
    responseJson: { statusCode: 400, message: "invalid sender" },
  });
  try {
    const provider = taqnyat("tok", "EINAI");
    const res = await provider.send({ to: "+966500000000", body: "x" });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.match(res.error, /taqnyat 400/);
      assert.match(res.error, /invalid sender/);
      assert.equal(res.retryable, false);
    }
  } finally {
    restore();
  }
});

test("send: 401 auth failure is non-retryable", async () => {
  const restore = installFakeFetch({
    status: 401,
    responseJson: { statusCode: 401, message: "unauthorized" },
  });
  try {
    const provider = taqnyat("tok", "EINAI");
    const res = await provider.send({ to: "+966500000000", body: "x" });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.retryable, false);
  } finally {
    restore();
  }
});

test("send: 500 upstream failure is retryable", async () => {
  const restore = installFakeFetch({
    status: 500,
    responseJson: { message: "internal" },
  });
  try {
    const provider = taqnyat("tok", "EINAI");
    const res = await provider.send({ to: "+966500000000", body: "x" });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.retryable, true);
      assert.match(res.error, /taqnyat 500/);
    }
  } finally {
    restore();
  }
});

test("send: unparseable response body still produces a typed error (no throw)", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("invalid json");
      },
    }) as unknown as Response) as unknown as typeof fetch;
  try {
    const provider = taqnyat("tok", "EINAI");
    const res = await provider.send({ to: "+966500000000", body: "x" });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.retryable, true);
      assert.match(res.error, /taqnyat 502/);
      assert.match(res.error, /unknown/);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("send: reports provider name as 'taqnyat' for audit", () => {
  const provider = taqnyat("tok", "EINAI");
  assert.equal(provider.name, "taqnyat");
});
