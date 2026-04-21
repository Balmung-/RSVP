import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveChatFatalNotice,
  deriveChatSystemNotice,
  parseChatHealth,
  shouldRefreshHealthForError,
  type ChatHealthSnapshot,
} from "../../src/components/chat/chat-health";

function healthy(): ChatHealthSnapshot {
  return {
    ok: true,
    db: "up",
    ai: { name: "openrouter", configured: true },
  };
}

test("parseChatHealth accepts the /api/health AI shape", () => {
  const parsed = parseChatHealth({
    ok: false,
    db: "up",
    ai: {
      name: "openrouter",
      configured: false,
      reason: "openrouter_not_configured",
    },
  });
  assert.deepEqual(parsed, {
    ok: false,
    db: "up",
    ai: {
      name: "openrouter",
      configured: false,
      reason: "openrouter_not_configured",
    },
  });
});

test("parseChatHealth rejects malformed payloads", () => {
  assert.equal(parseChatHealth(null), null);
  assert.equal(parseChatHealth({ db: "up" }), null);
  assert.equal(
    parseChatHealth({
      ok: true,
      db: "up",
      ai: { name: "claude", configured: true },
    }),
    null,
  );
});

test("deriveChatSystemNotice shows database outage first", () => {
  const notice = deriveChatSystemNotice({
    locale: "en",
    topError: null,
    health: {
      ok: false,
      db: "down",
      ai: { name: "openrouter", configured: true },
    },
  });
  assert.deepEqual(notice, {
    tone: "danger",
    title: "Database unavailable",
    detail: "Chat cannot send or refresh until the database recovers.",
    allowRefreshStatus: true,
  });
});

test("deriveChatSystemNotice maps runtime config drift into operator copy", () => {
  const notice = deriveChatSystemNotice({
    locale: "en",
    topError: "openrouter_not_configured",
    health: null,
  });
  assert.deepEqual(notice, {
    tone: "warning",
    title: "AI backend unavailable",
    detail: "OpenRouter is selected, but the server is not fully configured yet.",
    allowRefreshStatus: true,
  });
});

test("deriveChatSystemNotice clears a stale runtime error once health is healthy", () => {
  assert.equal(
    deriveChatSystemNotice({
      locale: "en",
      topError: "openrouter_not_configured",
      health: healthy(),
    }),
    null,
  );
});

test("deriveChatSystemNotice prefers current health over a missing top error", () => {
  const notice = deriveChatSystemNotice({
    locale: "en",
    topError: null,
    health: {
      ok: false,
      db: "up",
      ai: {
        name: "unknown",
        configured: false,
        reason: "unknown_runtime",
      },
    },
  });
  assert.deepEqual(notice, {
    tone: "warning",
    title: "AI runtime is misconfigured",
    detail:
      "The server is set to an unknown AI backend. Check deployment config, then try again.",
    allowRefreshStatus: true,
  });
});

test("deriveChatSystemNotice softens rate limits into operator copy", () => {
  const notice = deriveChatSystemNotice({
    locale: "en",
    topError: "rate_limited",
    health: healthy(),
  });
  assert.deepEqual(notice, {
    tone: "warning",
    title: "Rate limited",
    detail: "Wait a moment, then try again.",
    allowRefreshStatus: false,
  });
});

test("deriveChatSystemNotice falls back to generic request failure copy", () => {
  const notice = deriveChatSystemNotice({
    locale: "en",
    topError: "socket_hangup",
    health: healthy(),
  });
  assert.deepEqual(notice, {
    tone: "danger",
    title: "Request failed",
    detail: "socket_hangup",
    allowRefreshStatus: false,
  });
});

test("deriveChatFatalNotice prefers health-derived database copy", () => {
  const notice = deriveChatFatalNotice({
    locale: "en",
    health: {
      ok: false,
      db: "down",
      ai: { name: "openrouter", configured: true },
    },
    fallbackMessage: "prisma blew up",
  });
  assert.deepEqual(notice, {
    title: "Database unavailable",
    detail: "Chat cannot send or refresh until the database recovers.",
    allowRefreshStatus: true,
  });
});

test("deriveChatFatalNotice falls back to a generic chat-unavailable notice", () => {
  const notice = deriveChatFatalNotice({
    locale: "en",
    health: healthy(),
    fallbackMessage: "session lookup failed",
  });
  assert.deepEqual(notice, {
    title: "Chat is temporarily unavailable",
    detail: "session lookup failed",
    allowRefreshStatus: true,
  });
});

test("shouldRefreshHealthForError only flags health-shaped failures", () => {
  assert.equal(shouldRefreshHealthForError("openrouter_not_configured"), true);
  assert.equal(shouldRefreshHealthForError("HTTP 503"), true);
  assert.equal(shouldRefreshHealthForError("rate_limited"), false);
  assert.equal(shouldRefreshHealthForError(null), false);
});
