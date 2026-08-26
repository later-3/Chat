import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { loadCompatibilityPolicy, validateCompatibilityPolicy } from "./compatibility-policy.mjs";
import {
  assertCompatibilityFactsBaselineChain,
  assertCompatibilityFactsCompatible,
  authorityBoundaryForTest,
  generateCompatibilityFacts,
  mechanicallyGeneratedAuthorityProofsForTest,
  mechanicallyGeneratedExtractorMigrationProofsForTest,
  workflowRunSpecGenerationEvidenceForTest,
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
    (generation) => generation.identity === "chat-product-store.v24",
  );
  product.generations.push({
    ...previous,
    identity: "chat-product-store.v25",
    generation: 25,
    canonicalSha256: "e".repeat(64),
  });
  product.currentWriteGenerations = ["chat-product-store.v25"];
  product.writeAuthority.generations = ["chat-product-store.v25"];
  assert.throws(
    () => assertCompatibilityFactsCompatible(factsBaseline, changed),
    /缺少read-old\/migration/u,
  );
});

function promoteGeneration(domain, currentIdentity, nextIdentity) {
  const current = domain.generations.find((entry) => entry.identity === currentIdentity);
  assert.ok(current);
  const generation = Number(/v(\d+)$/u.exec(nextIdentity)?.[1]);
  domain.generations.push({
    ...current,
    identity: nextIdentity,
    generation,
    canonicalSha256: "d".repeat(64),
    previousExtractorCanonicalSha256: "e".repeat(64),
  });
  domain.currentWriteGenerations = domain.currentWriteGenerations.map((identity) =>
    identity === currentIdentity ? nextIdentity : identity,
  );
  domain.historicalReadableGenerations.push(currentIdentity);
  domain.writeAuthority.generations = [...domain.currentWriteGenerations].sort();
  domain.writeAuthority.canonicalSha256 = "b".repeat(64);
  domain.legacyAuthority.generations = [...domain.historicalReadableGenerations].sort();
  domain.legacyAuthority.canonicalSha256 = "c".repeat(64);
  domain.compatibilityEntries.push({
    entry: `migrate:${currentIdentity}->${nextIdentity}`,
    generations: [currentIdentity, nextIdentity],
    evidenceKind: "resolved-call-input-output",
    canonicalSha256: "a".repeat(64),
  });
}

test("合法Writer升代不冒充Owner漂移，缺兼容边或read-old仍失败", () => {
  const valid = structuredClone(factsBaseline);
  const product = valid.domains.find((domain) => domain.id === "product-store");
  promoteGeneration(product, "chat-product-store.v24", "chat-product-store.v25");
  assert.deepEqual(assertCompatibilityFactsCompatible(factsBaseline, valid), valid);

  const missingMigration = structuredClone(valid);
  const missingMigrationProduct = missingMigration.domains.find(
    (domain) => domain.id === "product-store",
  );
  missingMigrationProduct.compatibilityEntries =
    missingMigrationProduct.compatibilityEntries.filter(
      (entry) => !entry.generations.includes("chat-product-store.v25"),
    );
  assert.throws(
    () => assertCompatibilityFactsCompatible(factsBaseline, missingMigration),
    /缺少read-old\/migration/u,
  );

  const missingReadOld = structuredClone(valid);
  const missingReadOldProduct = missingReadOld.domains.find(
    (domain) => domain.id === "product-store",
  );
  missingReadOldProduct.historicalReadableGenerations =
    missingReadOldProduct.historicalReadableGenerations.filter(
      (identity) => identity !== "chat-product-store.v24",
    );
  missingReadOldProduct.legacyAuthority.generations = [
    ...missingReadOldProduct.historicalReadableGenerations,
  ];
  assert.throws(
    () => assertCompatibilityFactsCompatible(factsBaseline, missingReadOld),
    /缺少read-old\/migration/u,
  );
});

test("Owner root、entry和action policy继续失败，同literal不得原地漂移", () => {
  const ownerChanged = structuredClone(factsBaseline);
  const ownerDomain = ownerChanged.domains.find((domain) => domain.id === "product-store");
  ownerDomain.ownerRoots[0] = "packages/contracts/src/changed-owner.ts";
  ownerDomain.authorityBoundarySha256 = authorityBoundaryForTest(ownerDomain);
  assert.throws(
    () => assertCompatibilityFactsCompatible(factsBaseline, ownerChanged),
    /Owner边界漂移/u,
  );

  for (const mutate of [
    (domain) => {
      domain.writeAuthority.entry = "ChangedWriter.persist";
    },
    (domain) => {
      domain.writeAuthority.allowedActions.push("bypass");
    },
  ]) {
    const policyChanged = structuredClone(factsBaseline);
    const domain = policyChanged.domains.find((entry) => entry.id === "product-store");
    mutate(domain);
    domain.authorityBoundarySha256 = authorityBoundaryForTest(domain);
    assert.throws(
      () => assertCompatibilityFactsCompatible(factsBaseline, policyChanged),
      /Owner\/entry\/action policy漂移/u,
    );
  }

  const sameLiteral = structuredClone(factsBaseline);
  sameLiteral.domains.find(
    (domain) => domain.id === "product-store",
  ).generations[0].canonicalSha256 = "0".repeat(64);
  assert.throws(
    () => assertCompatibilityFactsCompatible(factsBaseline, sameLiteral),
    /同一schema literal原地语义漂移/u,
  );
});

test("Direct/Generic新增v4保持v1-v3 canonical hash并通过read-old/migration", () => {
  const changed = structuredClone(factsBaseline);
  const domain = changed.domains.find((entry) => entry.id === "direct-generic-journals");
  const oldHashes = new Map(
    domain.generations.map((entry) => [entry.identity, entry.canonicalSha256]),
  );
  promoteGeneration(domain, "full-operation.v3", "full-operation.v4");
  for (const [identity, hash] of oldHashes) {
    assert.equal(
      domain.generations.find((entry) => entry.identity === identity).canonicalSha256,
      hash,
    );
  }
  assert.deepEqual(assertCompatibilityFactsCompatible(factsBaseline, changed), changed);
});

test("Authority外部投影提取器只允许有机械证明的连续迁移", () => {
  const previous = structuredClone(factsBaseline);
  for (const id of ["network-contracts", "browser-dto-events"]) {
    const domain = previous.domains.find((entry) => entry.id === id);
    domain.authorityCanonicalVersion = 2;
    domain.legacyAuthority.canonicalSha256 = factsBaseline.domains.find(
      (entry) => entry.id === id,
    ).legacyAuthority.previousExtractorCanonicalSha256;
    domain.writeAuthority.canonicalSha256 = factsBaseline.domains.find(
      (entry) => entry.id === id,
    ).writeAuthority.previousExtractorCanonicalSha256;
  }
  assert.deepEqual(assertCompatibilityFactsCompatible(previous, factsBaseline), factsBaseline);

  const sameVersionDrift = structuredClone(factsBaseline);
  sameVersionDrift.domains.find(
    (entry) => entry.id === "network-contracts",
  ).writeAuthority.canonicalSha256 = "2".repeat(64);
  assert.throws(
    () => assertCompatibilityFactsCompatible(factsBaseline, sameVersionDrift),
    /writer implementation未升代际漂移/u,
  );

  const unprovenUpgrade = structuredClone(factsBaseline);
  unprovenUpgrade.domains.find(
    (entry) => entry.id === "network-contracts",
  ).authorityCanonicalVersion = 4;
  assert.throws(
    () => assertCompatibilityFactsCompatible(factsBaseline, unprovenUpgrade),
    /authority canonical提取器/u,
  );
});

test("compat事实绑定真实Schema闭包、writer authority与resolved migration edge", () => {
  const product = factsBaseline.domains.find((domain) => domain.id === "product-store");
  const current = product.generations.find(
    (generation) => generation.identity === "chat-product-store.v24",
  );
  assert.ok(
    current.evidenceCount > 100,
    "v24必须包含productEntities及Imported Tool/Agent Schema闭包",
  );
  assert.deepEqual(product.currentWriteGenerations, ["chat-product-store.v24"]);
  assert.deepEqual(product.writeAuthority.generations, ["chat-product-store.v24"]);
  assert.equal(product.writeAuthority.entry, "JsonProductStore.doTransact->persist");
  const directMigrationEntries = product.compatibilityEntries.filter((entry) =>
    entry.entry.startsWith("packages/product-store-json/src/migrate-"),
  );
  assert.ok(
    directMigrationEntries.length > 0 &&
      directMigrationEntries.every((entry) => entry.evidenceKind === "resolved-call-input-output"),
  );
  assert.ok(
    product.compatibilityEntries.some(
      (entry) =>
        entry.entry ===
          "JsonProductStore.open:migration-path:chat-product-store.v20->chat-product-store.v24" &&
        entry.evidenceKind === "resolved-call-migration-path" &&
        JSON.stringify(entry.generations) ===
          JSON.stringify([
            "chat-product-store.v20",
            "chat-product-store.v21",
            "chat-product-store.v22",
            "chat-product-store.v23",
            "chat-product-store.v24",
          ]),
    ),
    "Writer升代必须由真实resolved migration edge组成read-old path",
  );
  assert.ok(
    product.compatibilityEntries.some(
      (entry) =>
        entry.entry ===
          "JsonProductStore.open:migration-path:chat-product-store.v20->chat-product-store.v24:capability-lineage" &&
        JSON.stringify(entry.generations) ===
          JSON.stringify([
            "chat-product-store.v20",
            "chat-product-store.v22",
            "chat-product-store.v23",
            "chat-product-store.v24",
          ]),
    ),
    "同literal的Capability v20必须保留独立真实迁移链，不能与Content v20串线",
  );
  assert.equal(
    product.generations.some((generation) => generation.identity === "chat-product-store.v25"),
    false,
    "未被reader/writer采用的version literal不得产生generation",
  );

  const writerMismatch = structuredClone(factsBaseline);
  const mismatch = writerMismatch.domains.find((domain) => domain.id === "product-store");
  mismatch.generations.push({
    ...current,
    identity: "chat-product-store.v25",
    generation: 25,
  });
  mismatch.currentWriteGenerations = ["chat-product-store.v25"];
  assert.throws(
    () => assertCompatibilityFactsCompatible(factsBaseline, writerMismatch),
    /writeAuthority与真实入口漂移/u,
  );

  const filenameOnlyMigration = structuredClone(factsBaseline);
  filenameOnlyMigration.domains
    .find((domain) => domain.id === "product-store")
    .compatibilityEntries.push({
      entry: "packages/product-store-json/src/migrate-v20-to-v21.ts",
      generations: ["chat-product-store.v24"],
      canonicalSha256: "a".repeat(64),
    });
  assert.throws(
    () => assertCompatibilityFactsCompatible(factsBaseline, filenameOnlyMigration),
    /无真实转换edge/u,
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

test("RunSpec extractor v2机械证明旧hash且只绑定真实Schema/compiler/reader闭包", () => {
  const current = generateCompatibilityFacts(loadCompatibilityPolicy());
  const domain = current.domains.find((entry) => entry.id === "workflow-run-spec");
  assert.ok(domain);
  assert.equal(domain.generationCanonicalVersion, 2);
  const generation = domain.generations.find((entry) => entry.identity === "workflow-run-spec.v1");
  assert.ok(generation);
  const proofs = mechanicallyGeneratedExtractorMigrationProofsForTest();
  assert.equal(
    generation.previousExtractorCanonicalSha256,
    proofs["workflow-run-spec:workflow-run-spec.v1"],
  );

  const evidence = workflowRunSpecGenerationEvidenceForTest();
  assert.ok(evidence.some((entry) => entry.includes("workflowRunSpecSchema")));
  assert.ok(evidence.some((entry) => entry.includes("compileWorkflowRunSpec")));
  assert.ok(evidence.some((entry) => entry.includes("loadRestrictedRunSpec")));
  assert.ok(evidence.some((entry) => entry.includes("interpretRestrictedRunSpec")));
  assert.ok(evidence.some((entry) => entry.includes("loadDefinitionKernelRunSpecStep")));
  assert.equal(
    evidence.some((entry) => entry.includes("json-product-store.ts")),
    false,
    "无关Store v23 migration分支不能进入RunSpec canonical闭包",
  );

  const digest = (entries) => createHash("sha256").update(entries.join("\n")).digest("hex");
  const changedSchema = evidence.map((entry) =>
    entry.includes("workflowRunSpecSchema") ? `${entry} requiredField: z.string()` : entry,
  );
  assert.notEqual(digest(evidence), digest(changedSchema));
});

test("Journal历史reader authority只取自base旧提取器机械证明", () => {
  const current = generateCompatibilityFacts(loadCompatibilityPolicy());
  const domain = current.domains.find((entry) => entry.id === "direct-generic-journals");
  assert.ok(domain);
  const proofs = mechanicallyGeneratedAuthorityProofsForTest();
  assert.equal(
    domain.legacyAuthority.canonicalSha256,
    proofs["direct-generic-journals:legacyAuthority"],
  );

  const tampered = structuredClone(current);
  tampered.domains.find(
    (entry) => entry.id === "direct-generic-journals",
  ).legacyAuthority.canonicalSha256 = "0".repeat(64);
  assert.throws(
    () => assertCompatibilityFactsCompatible(current, tampered),
    /reader implementation未升代际漂移/u,
  );
});
