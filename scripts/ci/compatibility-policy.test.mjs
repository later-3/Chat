import assert from "node:assert/strict";
import test from "node:test";

import { loadCompatibilityPolicy, validateCompatibilityPolicy } from "./compatibility-policy.mjs";

test("统一compat policy覆盖六类事实且factSource真实存在", () => {
  const policy = validateCompatibilityPolicy(loadCompatibilityPolicy());
  assert.equal(policy.domains.length, 6);
  assert.ok(policy.rules.includes("read_old_write_current"));
  assert.ok(policy.rules.includes("breaking_change_requires_explicit_user_approval"));
});

test("缺域、原地改语义、扩张旧代权限或缺回滚信息对应规则均不能被删除", () => {
  const cases = [
    (policy) => policy.domains.pop(),
    (policy) => policy.rules.splice(policy.rules.indexOf("same_schema_literal_immutable"), 1),
    (policy) =>
      policy.rules.splice(policy.rules.indexOf("read_only_legacy_cannot_expand_authority"), 1),
    (policy) =>
      policy.rules.splice(
        policy.rules.indexOf("breaking_change_requires_detect_why_fix_verify_rollback"),
        1,
      ),
    (policy) => {
      policy.domains[0].readOld = false;
    },
  ];
  for (const mutate of cases) {
    const policy = structuredClone(loadCompatibilityPolicy());
    mutate(policy);
    assert.throws(() => validateCompatibilityPolicy(policy, { skipFilesystem: true }));
  }
});

test("compat factSource拒绝路径穿越", () => {
  const policy = structuredClone(loadCompatibilityPolicy());
  policy.domains[0].factSources = ["../outside.ts"];
  assert.throws(() => validateCompatibilityPolicy(policy), /安全相对路径/u);
});
