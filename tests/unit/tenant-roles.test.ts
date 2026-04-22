import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TENANT_ROLE_LABEL,
  allowedInviteRoles,
  appRankForTenantRole,
  canAssignTenantRole,
  canRemoveTenantMember,
  hasTenantRoleValue,
} from "../../src/lib/tenant-roles";

test("tenant roles: labels stay stable", () => {
  assert.equal(TENANT_ROLE_LABEL.owner, "Owner");
  assert.equal(TENANT_ROLE_LABEL.admin, "Admin");
  assert.equal(TENANT_ROLE_LABEL.editor, "Editor");
  assert.equal(TENANT_ROLE_LABEL.viewer, "Viewer");
});

test("tenant roles: app access rank lets viewer through viewer-only paths", () => {
  assert.equal(appRankForTenantRole("viewer"), 0);
  assert.equal(appRankForTenantRole("editor"), 1);
  assert.equal(appRankForTenantRole("admin"), 2);
  assert.equal(appRankForTenantRole("owner"), 2);
});

test("tenant roles: owner and admin satisfy tenant admin checks", () => {
  assert.equal(hasTenantRoleValue("owner", "admin"), true);
  assert.equal(hasTenantRoleValue("admin", "admin"), true);
  assert.equal(hasTenantRoleValue("editor", "admin"), false);
});

test("tenant roles: platform admins can assign any workspace role", () => {
  assert.deepEqual(allowedInviteRoles(null, true), ["owner", "admin", "editor", "viewer"]);
});

test("tenant roles: owner can invite admin/editor/viewer but not owner", () => {
  assert.deepEqual(allowedInviteRoles("owner", false), ["admin", "editor", "viewer"]);
  assert.equal(canAssignTenantRole("owner", "owner", false), false);
});

test("tenant roles: workspace admin can invite editor/viewer only", () => {
  assert.deepEqual(allowedInviteRoles("admin", false), ["editor", "viewer"]);
  assert.equal(canAssignTenantRole("admin", "editor", false), true);
  assert.equal(canAssignTenantRole("admin", "admin", false), false);
});

test("tenant roles: editors and viewers cannot manage people", () => {
  assert.deepEqual(allowedInviteRoles("editor", false), []);
  assert.deepEqual(allowedInviteRoles("viewer", false), []);
});

test("tenant roles: last owner cannot be removed", () => {
  assert.equal(canRemoveTenantMember("owner", "owner", 1, false), false);
  assert.equal(canRemoveTenantMember(null, "owner", 1, true), false);
});

test("tenant roles: owner can remove admin/editor/viewer but not another owner directly", () => {
  assert.equal(canRemoveTenantMember("owner", "admin", 2, false), true);
  assert.equal(canRemoveTenantMember("owner", "editor", 2, false), true);
  assert.equal(canRemoveTenantMember("owner", "viewer", 2, false), true);
  assert.equal(canRemoveTenantMember("owner", "owner", 2, false), false);
});

test("tenant roles: platform admin can remove any non-last member role", () => {
  assert.equal(canRemoveTenantMember(null, "owner", 2, true), true);
  assert.equal(canRemoveTenantMember(null, "admin", 1, true), true);
});
