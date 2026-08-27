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
  mechanicallyGeneratedBaseFactsForTest,
  mechanicallyGeneratedAuthorityProofsForTest,
  mechanicallyGeneratedExtractorMigrationProofsForTest,
  mechanicallyApprovedBaselineRepairsForTest,
  recordedBaselineRepairProofForTest,
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
  const deletedDomain = deletedHistory.domains.find((domain) => domain.id === "workflow-run-spec");
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
    (generation) => generation.identity === "chat-product-store.v27",
  );
  product.generations.push({
    ...previous,
    identity: "chat-product-store.v28",
    generation: 28,
    canonicalSha256: "e".repeat(64),
  });
  product.currentWriteGenerations = ["chat-product-store.v28"];
  product.writeAuthority.generations = ["chat-product-store.v28"];
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
  promoteGeneration(product, "chat-product-store.v27", "chat-product-store.v28");
  assert.deepEqual(assertCompatibilityFactsCompatible(factsBaseline, valid), valid);

  const missingMigration = structuredClone(valid);
  const missingMigrationProduct = missingMigration.domains.find(
    (domain) => domain.id === "product-store",
  );
  missingMigrationProduct.compatibilityEntries =
    missingMigrationProduct.compatibilityEntries.filter(
      (entry) => !entry.generations.includes("chat-product-store.v28"),
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
      (identity) => identity !== "chat-product-store.v27",
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
    (generation) => generation.identity === "chat-product-store.v27",
  );
  assert.ok(current.evidenceCount > 100, "v27必须包含当前Product实体及Tool/Agent Schema闭包");
  assert.deepEqual(product.currentWriteGenerations, ["chat-product-store.v27"]);
  assert.deepEqual(product.writeAuthority.generations, ["chat-product-store.v27"]);
  assert.equal(product.writeAuthority.entry, "JsonProductStore.doTransact->persist");
  assert.deepEqual(product.historicalReadableGenerations, []);
  assert.deepEqual(product.compatibilityEntries, []);
  const migrationSource = readFileSync(
    resolve(root, "packages/product-store-json/src/legacy-snapshot-migration.ts"),
    "utf8",
  );
  assert.match(migrationSource, /v\(\?:1\[0-9\]\|2\[0-6\]\)/u);
  assert.match(migrationSource, /v1-v9已退役.*备份分支/u);
  assert.equal(
    product.generations.some((generation) => generation.identity === "chat-product-store.v28"),
    false,
    "未被reader/writer采用的version literal不得产生generation",
  );

  const writerMismatch = structuredClone(factsBaseline);
  const mismatch = writerMismatch.domains.find((domain) => domain.id === "product-store");
  mismatch.generations.push({
    ...current,
    identity: "chat-product-store.v28",
    generation: 28,
  });
  mismatch.currentWriteGenerations = ["chat-product-store.v28"];
  assert.throws(
    () => assertCompatibilityFactsCompatible(factsBaseline, writerMismatch),
    /writeAuthority与真实入口漂移/u,
  );

  const filenameOnlyMigration = structuredClone(factsBaseline);
  filenameOnlyMigration.domains
    .find((domain) => domain.id === "product-store")
    .compatibilityEntries.push({
      entry: "packages/product-store-json/src/migrate-v20-to-v21.ts",
      generations: ["chat-product-store.v27"],
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

test("产品退役与历史baseline修复只接受精确Hash且登记必须被消费", () => {
  const generationChanged = structuredClone(factsBaseline);
  const previousProduct = factsBaseline.domains.find((domain) => domain.id === "product-store");
  const changedProduct = generationChanged.domains.find((domain) => domain.id === "product-store");
  const previousV27 = previousProduct.generations.find(
    (entry) => entry.identity === "chat-product-store.v27",
  );
  const changedV27 = changedProduct.generations.find(
    (entry) => entry.identity === "chat-product-store.v27",
  );
  changedV27.canonicalSha256 = "d".repeat(64);
  const exactGenerationBreak = new Map([
    [
      "product-store:chat-product-store.v27",
      {
        previousCanonicalSha256: previousV27.canonicalSha256,
        currentCanonicalSha256: changedV27.canonicalSha256,
      },
    ],
  ]);
  assert.deepEqual(
    assertCompatibilityFactsCompatible(factsBaseline, generationChanged, {
      approvedGenerationBreaks: exactGenerationBreak,
    }),
    generationChanged,
  );
  assert.throws(
    () =>
      assertCompatibilityFactsCompatible(factsBaseline, generationChanged, {
        approvedGenerationBreaks: new Map([
          [
            "product-store:chat-product-store.v27",
            {
              previousCanonicalSha256: previousV27.canonicalSha256,
              currentCanonicalSha256: "e".repeat(64),
            },
          ],
        ]),
      }),
    /原地语义漂移/u,
  );

  const authorityRepaired = structuredClone(factsBaseline);
  const previousBridge = factsBaseline.domains.find((domain) => domain.id === "bridge-state");
  const repairedBridge = authorityRepaired.domains.find((domain) => domain.id === "bridge-state");
  repairedBridge.legacyAuthority.canonicalSha256 = "e".repeat(64);
  assert.deepEqual(
    assertCompatibilityFactsCompatible(factsBaseline, authorityRepaired, {
      approvedAuthorityRepairs: new Map([
        [
          "bridge-state:legacyAuthority",
          {
            recordedCanonicalSha256: previousBridge.legacyAuthority.canonicalSha256,
            recomputedCanonicalSha256: repairedBridge.legacyAuthority.canonicalSha256,
          },
        ],
      ]),
    }),
    authorityRepaired,
  );
  assert.throws(
    () =>
      assertCompatibilityFactsCompatible(factsBaseline, factsBaseline, {
        approvedGenerationBreaks: exactGenerationBreak,
      }),
    /未被精确消费/u,
  );

  const mechanicalRepairs = mechanicallyApprovedBaselineRepairsForTest(
    "3fd5b65c4819187c2b02150ff3e69fc41a59cc4b",
  );
  assert.deepEqual(mechanicalRepairs.generations["bridge-state:chat-dsh-lifeos-state.v13"], {
    recordedCanonicalSha256: "5586e3a5ffd1918dfdb583d062bb2fc08a2b5bc0b83e31e67afbda0bedd5c61b",
    recomputedCanonicalSha256: "d20927c6ab551d35315617789651c1f5590ae2c3289f472d76164889d3f3d9e7",
  });
  assert.deepEqual(mechanicalRepairs.authorities["bridge-state:legacyAuthority"], {
    recordedCanonicalSha256: "c02f5e36f7edbca4e4ccd0d406e3c2d4a6b46dfb7cb664e60a9bc27f1ba88ef6",
    recomputedCanonicalSha256: "faf79bed1c84f98e476d643a6ba7a4647aa6fb0f3e590d490e16ef6c46d1ebc9",
  });
});

test("RunSpec extractor v3显式修复历史baseline并只绑定真实Schema/compiler/reader闭包", () => {
  const current = generateCompatibilityFacts(loadCompatibilityPolicy());
  const domain = current.domains.find((entry) => entry.id === "workflow-run-spec");
  assert.ok(domain);
  assert.equal(domain.generationCanonicalVersion, 3);
  assert.deepEqual(domain.currentWriteGenerations, ["workflow-run-spec.v3"]);
  const generationV1 = domain.generations.find(
    (entry) => entry.identity === "workflow-run-spec.v1",
  );
  const generationV2 = domain.generations.find(
    (entry) => entry.identity === "workflow-run-spec.v2",
  );
  assert.ok(generationV1);
  assert.ok(generationV2);
  const proofs = mechanicallyGeneratedExtractorMigrationProofsForTest();
  const v1Repair = proofs["workflow-run-spec:workflow-run-spec.v1:3"];
  const v2Repair = proofs["workflow-run-spec:workflow-run-spec.v2:3"];
  assert.equal(proofs["workflow-run-spec:workflow-run-spec.v1:2"].proofKind, "reproducible-base");
  for (const [generation, proof] of [
    [generationV1, v1Repair],
    [generationV2, v2Repair],
  ]) {
    assert.equal(proof.proofKind, "recorded-baseline-repair");
    assert.equal(proof.baseCommit, "8a6a8133229bfd9a7f38528bb1062e1c65718a48");
    assert.equal(generation.previousExtractorCanonicalSha256, proof.previousCanonicalSha256);
    assert.equal(generation.previousExtractorProofKind, proof.proofKind);
    assert.equal(generation.previousExtractorBaseCommit, proof.baseCommit);
    assert.equal(
      generation.previousExtractorRecomputedCanonicalSha256,
      proof.recomputedBaseCanonicalSha256,
    );
  }
  assert.equal(
    v2Repair.previousCanonicalSha256,
    "fc989a62ea61f625485cd48e923f460ca0008ca4aa5792aacf507fa0c15bcefe",
  );
  assert.equal(
    v2Repair.recomputedBaseCanonicalSha256,
    "91f62cab860c34ddcc9e1b0635355b1380b77bc34b5d6b02fb8a6869f8b74d75",
  );
  assert.notEqual(v2Repair.previousCanonicalSha256, v2Repair.recomputedBaseCanonicalSha256);
  assert.throws(
    () => mechanicallyGeneratedBaseFactsForTest("8a6a8133229bfd9a7f38528bb1062e1c65718a48"),
    /旧源码机械重算结果与其事实记录不一致/u,
  );

  const repair = {
    proofKind: "recorded-baseline-repair",
    domainId: "workflow-run-spec",
    fromCanonicalVersion: 2,
    toCanonicalVersion: 3,
    baseCommit: "8a6a8133229bfd9a7f38528bb1062e1c65718a48",
    identities: ["workflow-run-spec.v1", "workflow-run-spec.v2"],
    repairReason: "historical-source-baseline-divergence",
  };
  assert.equal(Object.keys(recordedBaselineRepairProofForTest(repair)).length, 2);
  assert.throws(
    () => recordedBaselineRepairProofForTest({ ...repair, identities: ["workflow-run-spec.v2"] }),
    /必须覆盖目标域全部代际/u,
  );
  assert.throws(
    () => recordedBaselineRepairProofForTest({ ...repair, fromCanonicalVersion: 1 }),
    /base canonical版本不匹配/u,
  );
  assert.throws(
    () => recordedBaselineRepairProofForTest({ ...repair, repairReason: "manual-digest" }),
    /原因非法/u,
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
