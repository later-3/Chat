import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { loadCompatibilityPolicy, validateCompatibilityPolicy } from "./compatibility-policy.mjs";
import {
  assertCompatibilityFactsBaselineChain,
  assertCompatibilityFactsCompatible,
  generateCompatibilityFacts,
} from "./compatibility-facts.mjs";

const root = resolve(import.meta.dirname, "../..");
const factsBaseline = JSON.parse(
  readFileSync(resolve(root, "config/compatibility-facts.baseline.json"), "utf8"),
);

test("统一compat policy覆盖六类事实且factSource真实存在", () => {
  const policy = validateCompatibilityPolicy(loadCompatibilityPolicy());
  assert.equal(policy.domains.length, 6);
  assert.ok(policy.rules.includes("read_old_write_current"));
  assert.ok(policy.rules.includes("breaking_change_requires_explicit_user_approval"));
  assert.deepEqual(generateCompatibilityFacts(policy), factsBaseline);
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
    (policy) => policy.domains[0].ownerRoots.pop(),
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

test("compat factSource拒绝README或不相关源码冒充真实Owner", () => {
  for (const path of ["README.md", "packages/domain/src/index.ts"]) {
    const policy = structuredClone(loadCompatibilityPolicy());
    policy.domains[0].factSources = [path];
    assert.throws(() => validateCompatibilityPolicy(policy), /README|真实Owner/u);
  }
});

test("六域事实指纹拒绝同literal漂移、历史删除、无升代写变化与旧代扩权", () => {
  const product = factsBaseline.domains.find((domain) => domain.id === "product-store");
  assert.ok(product);

  const sameLiteral = structuredClone(factsBaseline);
  sameLiteral.domains.find(
    (domain) => domain.id === "product-store",
  ).generations[0].canonicalSha256 = "f".repeat(64);
  assert.throws(
    () => assertCompatibilityFactsCompatible(factsBaseline, sameLiteral),
    /同一schema literal/u,
  );

  const deletedHistory = structuredClone(factsBaseline);
  const deletedDomain = deletedHistory.domains.find((domain) => domain.id === "product-store");
  const historical = deletedDomain.historicalReadableGenerations[0];
  deletedDomain.generations = deletedDomain.generations.filter(
    (generation) => generation.identity !== historical,
  );
  assert.throws(
    () => assertCompatibilityFactsCompatible(factsBaseline, deletedHistory),
    /删除历史代际/u,
  );

  const noGenerationBump = structuredClone(factsBaseline);
  noGenerationBump.domains.find((domain) => domain.id === "product-store").currentWriteGenerations =
    [];
  assert.throws(
    () => assertCompatibilityFactsCompatible(factsBaseline, noGenerationBump),
    /未升代际/u,
  );

  const authorityExpansion = structuredClone(factsBaseline);
  authorityExpansion.domains.find((domain) => domain.id === "bridge-state").legacyAuthority =
    "read_write";
  assert.throws(
    () => assertCompatibilityFactsCompatible(factsBaseline, authorityExpansion),
    /历史代际获得写权限/u,
  );
});

test("新代际没有read-old/migration入口时失败", () => {
  const changed = structuredClone(factsBaseline);
  const product = changed.domains.find((domain) => domain.id === "product-store");
  const previous = product.generations.find(
    (generation) => generation.identity === "chat-product-store.v20",
  );
  product.generations.push({
    ...previous,
    identity: "chat-product-store.v21",
    generation: 21,
    canonicalSha256: "e".repeat(64),
  });
  product.currentWriteGenerations = ["chat-product-store.v21"];
  assert.throws(
    () => assertCompatibilityFactsCompatible(factsBaseline, changed),
    /缺少read-old\/migration/u,
  );
});

test("同分支同时修改Owner与compatibility baseline仍由Git base失败关闭", () => {
  const changed = structuredClone(factsBaseline);
  const product = changed.domains.find((domain) => domain.id === "product-store");
  assert.ok(product);
  product.generations[0].canonicalSha256 = "d".repeat(64);
  assert.throws(
    () => assertCompatibilityFactsBaselineChain(factsBaseline, changed, changed),
    /同一schema literal/u,
  );
  assert.deepEqual(
    assertCompatibilityFactsBaselineChain(undefined, factsBaseline, factsBaseline),
    factsBaseline,
  );
});
