import { test } from "node:test";
import assert from "node:assert/strict";

import { dispatch } from "../../src/lib/ai/tools";
import type { ToolCtx } from "../../src/lib/ai/tools/types";

// Guards the dispatcher short-circuit for destructive tools. Any
// destructive tool invoked without `allowDestructive: true` MUST
// return `{ok: false, error: "needs_confirmation"}` without running
// the handler — that's the whole trust model behind the Confirm
// directive. A future refactor that accidentally drops the scope
// check would re-expose the model to real sends from a tool call;
// this test catches that regression in isolation (no network, no
// DB, no Anthropic client).
//
// Why `send_campaign`: it's the only destructive tool in the
// registry today and the only one the confirm route ever hands
// `allowDestructive: true`. If we add more, they should each get
// one line here.
//
// The ctx shape below is the minimum needed to satisfy ToolCtx's
// type — the handler never runs, so the Prisma-typed `campaignScope`
// can be an empty object literal and `user` can be a bare id/email
// stand-in. If dispatch did run the handler, it would fail against
// a real database, which is the point: the short-circuit is the
// only reason this test passes at all.

const fakeCtx: ToolCtx = {
  user: { id: "u-fake", email: "fake@test" } as ToolCtx["user"],
  isAdmin: false,
  locale: "en",
  campaignScope: {},
};

test("dispatch short-circuits destructive tools without allowDestructive", async () => {
  const result = await dispatch(
    "send_campaign",
    { campaign_id: "c-fake" },
    fakeCtx,
  );
  assert.equal(result.ok, false);
  if (result.ok) return; // type narrow
  assert.equal(result.error, "needs_confirmation");
});

test("dispatch reports unknown_tool for names not in the registry", async () => {
  const result = await dispatch("definitely_not_a_tool", {}, fakeCtx);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "unknown_tool:definitely_not_a_tool");
});
