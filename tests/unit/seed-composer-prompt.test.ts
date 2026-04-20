import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SEED_PROMPT_EVENT,
  isSeedPromptEvent,
  seedComposerPrompt,
} from "../../src/components/chat/seedComposerPrompt";

// P8-B — tests for the CustomEvent transport that carries chip
// clicks from a widget card to the chat composer.
//
// The production dispatcher fires on `window`; tests pass a fresh
// `EventTarget` so the dispatch + receive roundtrip is observable
// without a DOM. Node 20+ has `EventTarget` and `CustomEvent` as
// globals (package.json requires Node >=20), so no polyfill here.

// ---- dispatch -----

test("seedComposerPrompt: dispatches a CustomEvent on the supplied target", () => {
  const target = new EventTarget();
  const received: Event[] = [];
  target.addEventListener(SEED_PROMPT_EVENT, (e) => received.push(e));

  seedComposerPrompt("hello world", target);

  assert.equal(received.length, 1, "exactly one event must fire");
  const ev = received[0]!;
  assert.equal(ev.type, SEED_PROMPT_EVENT);
  assert.ok(ev instanceof CustomEvent);
  const detail = (ev as CustomEvent).detail as { prompt: string };
  assert.equal(detail.prompt, "hello world");
});

test("seedComposerPrompt: empty string is a no-op (no event fires)", () => {
  // Guards the composer against a mis-parameterized chip. If a
  // future NextAction accidentally renders with `prompt: ""`, the
  // listener would overwrite the operator's draft with an empty
  // string. Refusing to dispatch at the source is the simpler
  // defence than replicating the guard in every listener.
  const target = new EventTarget();
  const received: Event[] = [];
  target.addEventListener(SEED_PROMPT_EVENT, (e) => received.push(e));

  seedComposerPrompt("", target);

  assert.equal(received.length, 0, "empty prompt must not fire an event");
});

test("seedComposerPrompt: whitespace-only string is a no-op", () => {
  // Same class of guard as the empty case. A chip with
  // `prompt: "   "` would visually seed an empty-looking composer
  // that still clears the operator's draft.
  const target = new EventTarget();
  const received: Event[] = [];
  target.addEventListener(SEED_PROMPT_EVENT, (e) => received.push(e));

  seedComposerPrompt("   \t\n ", target);

  assert.equal(received.length, 0, "whitespace prompt must not fire");
});

test("seedComposerPrompt: non-string input is a no-op", () => {
  // The function is typed as `prompt: string` but TypeScript's
  // guarantee evaporates at module boundaries (e.g. a JSON
  // payload cast). This test pins the runtime guard so a number
  // sneaking in doesn't fire a malformed event.
  const target = new EventTarget();
  const received: Event[] = [];
  target.addEventListener(SEED_PROMPT_EVENT, (e) => received.push(e));

  seedComposerPrompt(42 as unknown as string, target);
  seedComposerPrompt(null as unknown as string, target);
  seedComposerPrompt(undefined as unknown as string, target);

  assert.equal(received.length, 0, "non-string prompts must not fire");
});

test("seedComposerPrompt: no target + no window is a no-op (SSR safety)", () => {
  // Server-side renders don't have `window`. Chips are
  // `"use client"`, so in practice this path is unreachable, but
  // the function is imported by the client bundle AND by the
  // test harness — a `ReferenceError: window is not defined`
  // would break SSR hydration probes. The helper must degrade
  // quietly. We don't get to observe "no event fires" here (no
  // target), we just assert the call doesn't throw.
  assert.doesNotThrow(() => {
    seedComposerPrompt("hello");
  });
});

// ---- type guard -----

test("isSeedPromptEvent: accepts a well-formed CustomEvent", () => {
  const ev = new CustomEvent(SEED_PROMPT_EVENT, {
    detail: { prompt: "hello" },
  });
  assert.equal(isSeedPromptEvent(ev), true);
});

test("isSeedPromptEvent: rejects an event with the wrong type", () => {
  const ev = new CustomEvent("unrelated:event", {
    detail: { prompt: "hello" },
  });
  assert.equal(isSeedPromptEvent(ev), false);
});

test("isSeedPromptEvent: rejects a plain Event (no detail)", () => {
  // A third-party script that fires a same-named event via
  // `new Event("chat:seed-prompt")` must not trick the listener
  // into reading `e.detail`, which would be undefined.
  const ev = new Event(SEED_PROMPT_EVENT);
  assert.equal(isSeedPromptEvent(ev), false);
});

test("isSeedPromptEvent: rejects a CustomEvent with missing prompt field", () => {
  const ev = new CustomEvent(SEED_PROMPT_EVENT, {
    detail: { other: "hello" },
  });
  assert.equal(isSeedPromptEvent(ev), false);
});

test("isSeedPromptEvent: rejects a CustomEvent with empty-string prompt", () => {
  // Defence-in-depth against the dispatch guard. Even if a future
  // change loosens the dispatch filter, the listener's type guard
  // still blocks empty prompts from flowing into setInput.
  const ev = new CustomEvent(SEED_PROMPT_EVENT, {
    detail: { prompt: "" },
  });
  assert.equal(isSeedPromptEvent(ev), false);
});

test("isSeedPromptEvent: rejects a CustomEvent with non-string prompt", () => {
  // TypeScript doesn't guarantee the detail shape at the
  // CustomEvent boundary (callers cast, third parties fire own
  // events). The guard checks at runtime.
  const ev = new CustomEvent(SEED_PROMPT_EVENT, {
    detail: { prompt: 42 },
  });
  assert.equal(isSeedPromptEvent(ev), false);
});

test("isSeedPromptEvent: rejects a CustomEvent with no detail at all", () => {
  const ev = new CustomEvent(SEED_PROMPT_EVENT);
  assert.equal(isSeedPromptEvent(ev), false);
});

// ---- end-to-end roundtrip -----

test("end-to-end: dispatch + type-guarded listener carries prompt text", () => {
  // The integration case — the production ChatWorkspace listener
  // does `if (!isSeedPromptEvent(e)) return; setInput(e.detail.prompt)`.
  // This test simulates that pattern: dispatch via the helper,
  // narrow via the guard, read the payload. A regression in
  // either side (bad dispatch shape or bad guard) shows up here.
  const target = new EventTarget();
  let seen: string | null = null;
  target.addEventListener(SEED_PROMPT_EVENT, (e) => {
    if (!isSeedPromptEvent(e)) return;
    seen = e.detail.prompt;
  });

  seedComposerPrompt("Send invites for Summer Gala", target);

  assert.equal(seen, "Send invites for Summer Gala");
});
