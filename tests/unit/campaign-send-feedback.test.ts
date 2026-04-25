import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildDispatchFlash,
  summarizeFailureReasons,
  type DispatchFailureReason,
} from "../../src/lib/campaign-send-feedback";

test("summarizeFailureReasons: sorts by count and respects the limit", () => {
  const reasons: DispatchFailureReason[] = [
    { channel: "sms", error: "rate limited", count: 1 },
    { channel: "whatsapp", error: "template missing", count: 4 },
    { channel: "email", error: "mailbox full", count: 2 },
  ];

  assert.equal(
    summarizeFailureReasons(reasons, 2),
    "4 WhatsApp: template missing | 2 email: mailbox full",
  );
});

test("summarizeFailureReasons: returns null when there is nothing to report", () => {
  assert.equal(summarizeFailureReasons([]), null);
});

test("buildDispatchFlash: send success omits detail when there are no failures", () => {
  assert.deepEqual(
    buildDispatchFlash({
      kind: "send",
      result: {
        email: 2,
        sms: 0,
        whatsapp: 3,
        skipped: 1,
        failed: 0,
        failureReasons: [],
      },
    }),
    {
      kind: "success",
      text: "Send finished - 5 sent, 1 skipped.",
      detail: undefined,
    },
  );
});

test("buildDispatchFlash: retry warning includes top failure reasons and operator hint", () => {
  const flash = buildDispatchFlash({
    kind: "retry",
    result: {
      email: 0,
      sms: 1,
      whatsapp: 0,
      skipped: 0,
      failed: 3,
      failureReasons: [
        { channel: "whatsapp", error: "template rejected", count: 2 },
        { channel: "sms", error: "number unreachable", count: 1 },
      ],
    },
  });

  assert.equal(flash.kind, "warn");
  assert.equal(flash.text, "Retry finished - 1 sent, 3 failed.");
  assert.match(
    flash.detail ?? "",
    /Top failures: 2 WhatsApp: template rejected \| 1 SMS: number unreachable\./,
  );
  assert.match(flash.detail ?? "", /Open Deliverability or Activity log/);
});
