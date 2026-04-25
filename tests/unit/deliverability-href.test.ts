import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDeliverabilityHref } from "../../src/app/deliverability/CampaignScopeSelect";

test("buildDeliverabilityHref: empty params collapse to /deliverability", () => {
  assert.equal(buildDeliverabilityHref({}, {}), "/deliverability");
  assert.equal(
    buildDeliverabilityHref({ campaign: "all", channel: "all", status: "all" }, {}),
    "/deliverability",
  );
});

test("buildDeliverabilityHref: keeps non-all filters and applies patch", () => {
  assert.equal(
    buildDeliverabilityHref(
      { campaign: "camp-1", channel: "whatsapp", status: "failed" },
      { campaign: "camp-2" },
    ),
    "/deliverability?campaign=camp-2&channel=whatsapp&status=failed",
  );
});

test("buildDeliverabilityHref: clearing campaign removes just that filter", () => {
  assert.equal(
    buildDeliverabilityHref(
      { campaign: "camp-1", channel: "whatsapp", status: "bounced" },
      { campaign: undefined },
    ),
    "/deliverability?channel=whatsapp&status=bounced",
  );
});
