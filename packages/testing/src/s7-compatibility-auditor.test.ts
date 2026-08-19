import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { productSnapshotSchema, type ProductSnapshot } from "@chat/contracts";
import { hashCanonical } from "@chat/domain";
import {
  JsonProductStore,
  assertSnapshotIntegrity,
  migrateProductSnapshotV10ToV11,
  migrateProductSnapshotV11ToV12,
  productSnapshotV1Schema,
} from "@chat/product-store-json";
import {
  S7_VERSIONED_FIXTURE_MANIFEST,
  buildS7VersionedFixture,
  fixtureContentSha256,
  fixtureObjectCount,
  migrateS7FixtureToCurrent,
} from "./fixtures/s7-versioned-fixtures.js";
import { auditProductIntegrity } from "./product-integrity-auditor.js";

const NOW = "2026-08-10T16:00:00.000Z";

describe("S7 versioned fixture与v1→最终兼容矩阵", () => {
  it("Manifest冻结来源commit、schema、对象计数与内容Hash", async () => {
    const actual = [];
    for (const entry of S7_VERSIONED_FIXTURE_MANIFEST) {
      const snapshot = await buildS7VersionedFixture(entry);
      expect(snapshot.schemaVersion).toBe(entry.schemaVersion);
      actual.push({
        fixtureId: entry.fixtureId,
        objectCount: fixtureObjectCount(snapshot),
        contentSha256: fixtureContentSha256(snapshot),
      });
    }
    expect(actual).toEqual(
      S7_VERSIONED_FIXTURE_MANIFEST.map((entry) => ({
        fixtureId: entry.fixtureId,
        objectCount: entry.objectCount,
        contentSha256: entry.contentSha256,
      })),
    );
    const historical = S7_VERSIONED_FIXTURE_MANIFEST.filter(
      (entry) => entry.sourceKind === "historical_contract",
    );
    const workingTree = S7_VERSIONED_FIXTURE_MANIFEST.filter(
      (entry) => entry.sourceKind === "working_tree_generated",
    );
    expect(historical.every((entry) => entry.sourceCommit?.length === 40)).toBe(true);
    expect(workingTree.every((entry) => entry.sourceCommit === null)).toBe(true);
  });

  it.each(S7_VERSIONED_FIXTURE_MANIFEST)(
    "$fixtureId逐版迁移/重复升级确定，重启后Auditor零矛盾",
    async (entry) => {
      const source = await buildS7VersionedFixture(entry);
      const migrated = migrateS7FixtureToCurrent(source);
      const migratedAgain = migrateS7FixtureToCurrent(source);
      expect(migratedAgain).toEqual(migrated);
      expect(productSnapshotSchema.parse(migrated)).toEqual(migrated);
      expect(() => assertSnapshotIntegrity(migrated)).not.toThrow();
      expect(auditProductIntegrity(migrated)).toMatchObject({ ok: true, issues: [] });

      const directory = await mkdtemp(join(tmpdir(), "chat-s7-compat-"));
      const filePath = join(directory, "product.json");
      await writeFile(filePath, JSON.stringify(source, null, 2));
      const store = await JsonProductStore.open({ filePath, now: () => NOW });
      const probeId = `psn_${entry.fixtureId.replaceAll("-", "")}`;
      await store.transact({
        commandId: `cmd_${entry.fixtureId.replaceAll("-", "")}` as never,
        commandType: "CreateProductSession",
        requestSha256: hashCanonical("s7-post-migration-probe.v1", { probeId }),
        mutate: (draft) => {
          draft.entities.sessions[probeId] = {
            schemaVersion: "product-session.v1",
            sessionId: probeId as never,
            ownerPrincipalId: "usr_s7postmigration" as never,
            status: "active",
            lastMessageSequence: 0,
            revision: 1,
            createdAt: NOW,
            updatedAt: NOW,
          };
          return { resultRefs: { sessionId: probeId } };
        },
      });
      const firstOpen = await readFile(filePath, "utf8");
      await JsonProductStore.open({ filePath, now: () => NOW });
      expect(await readFile(filePath, "utf8")).toBe(firstOpen);
      const afterProbe = (await store.read({ kind: "committedSnapshot" })).snapshot;
      expect(auditProductIntegrity(afterProbe)).toMatchObject({ ok: true, issues: [] });

      const runs = Object.values(migrated.entities.runs);
      expect(runs).toHaveLength(1);
      const run = runs[0];
      expect(run?.runKind).toBe(entry.workload === "note_capture" ? "note_capture" : "planning");
      if (entry.workload === "legacy_planning") {
        expect(run).toMatchObject({ runnerFamily: "legacy-planning.v1" });
        expect(run?.workflowRunSpecId).toBeUndefined();
      } else {
        expect(run?.workflowRunSpecId).toBeDefined();
      }
      if (entry.lifecycle === "waiting") {
        expect(run?.status).toBe("waiting_human");
        expect(entry.compatibility).toBe("resumable");
      }
      if (entry.lifecycle === "terminal") {
        expect(["succeeded", "failed", "cancelled"]).toContain(run?.status);
      }
    },
  );

  it("v12旧输入升级到当前格式且再次读取保持确定", async () => {
    const entry = S7_VERSIONED_FIXTURE_MANIFEST.find(
      (candidate) => candidate.fixtureId === "v10-new-planning-active",
    );
    if (entry === undefined) throw new Error("Manifest缺少v10 active Planning Fixture");
    const v10 = await buildS7VersionedFixture(entry);
    if (v10.schemaVersion !== "chat-product-store.v10") {
      throw new Error("v10 active Fixture schema错误");
    }
    const v12 = migrateProductSnapshotV11ToV12(migrateProductSnapshotV10ToV11(v10));
    const sourceBefore = structuredClone(v12);

    const migrated = migrateS7FixtureToCurrent(v12);

    expect(v12).toEqual(sourceBefore);
    expect(migrated.schemaVersion).toBe("chat-product-store.v14");
    expect(migrated.entities.runs).toEqual(v12.entities.runs);
    expect(migrated.entities.directAgentCandidates).toEqual({});
    expect(migrated.entities.promptReviewRequests).toEqual({});
    expect(migrated.entities.promptReviewDecisions).toEqual({});
    expect(migrateS7FixtureToCurrent(migrated)).toEqual(migrated);
  });

  it("v10 active Fixture不为queued Planner伪造输入Manifest", async () => {
    const entry = S7_VERSIONED_FIXTURE_MANIFEST.find(
      (candidate) =>
        candidate.fixtureId === "v10-new-planning-active" && candidate.objectCount === 33,
    );
    if (entry === undefined) throw new Error("Manifest缺少v10 active Planning Fixture");
    const snapshot = await buildS7VersionedFixture(entry);
    if (snapshot.schemaVersion !== "chat-product-store.v10") {
      throw new Error("v10 active Fixture schema错误");
    }
    const planner = Object.values(snapshot.entities.workflowNodeRuns).find(
      (node) => node.definitionNodeId === "planning.plan",
    );
    expect(planner).toMatchObject({ status: "queued" });
    expect(planner?.inputManifestId).toBeUndefined();
    expect(
      Object.values(snapshot.entities.nodeValueManifests).filter(
        (manifest) => manifest.workflowNodeRunId === planner?.workflowNodeRunId,
      ),
    ).toHaveLength(0);
  });

  it("v1…v9每个物理版本迁移rename故障都保留源文件逐字节不变", async () => {
    const representatives = [
      ...new Map(
        S7_VERSIONED_FIXTURE_MANIFEST.filter(
          (entry) => entry.schemaVersion !== "chat-product-store.v10",
        ).map((entry) => [entry.schemaVersion, entry] as const),
      ).values(),
    ];
    expect(representatives.map((entry) => entry.schemaVersion).sort()).toEqual(
      Array.from({ length: 9 }, (_, index) => `chat-product-store.v${String(index + 1)}`).sort(),
    );
    for (const entry of representatives) {
      const source = await buildS7VersionedFixture(entry);
      const directory = await mkdtemp(join(tmpdir(), `chat-s7-fault-${entry.schemaVersion}-`));
      const filePath = join(directory, "product.json");
      const before = JSON.stringify(source, null, 2);
      await writeFile(filePath, before);
      await expect(
        JsonProductStore.open({
          filePath,
          now: () => NOW,
          io: {
            renameTempFile: async () => {
              throw new Error("injected_migration_rename_failure");
            },
          },
        }),
      ).rejects.toThrow("atomic rename前失败");
      expect(await readFile(filePath, "utf8")).toBe(before);
    }
  });

  it("v1物理格式不能伪装new planning或note_capture，未知版本也逐字节失败关闭", async () => {
    const legacy = await buildS7VersionedFixture(S7_VERSIONED_FIXTURE_MANIFEST[0]!);
    const unsupportedRun = structuredClone(legacy) as unknown as Record<string, unknown>;
    const entities = unsupportedRun["entities"] as Record<string, Record<string, unknown>>;
    const firstRun = Object.values(entities["runs"] ?? {})[0] as
      Record<string, unknown> | undefined;
    if (firstRun === undefined) throw new Error("S7 legacy Fixture缺少Run");
    firstRun["runKind"] = "note_capture";
    expect(productSnapshotV1Schema.safeParse(unsupportedRun).success).toBe(false);

    const unknownVersion = { ...structuredClone(legacy), schemaVersion: "chat-product-store.v999" };
    const directory = await mkdtemp(join(tmpdir(), "chat-s7-unsupported-"));
    const filePath = join(directory, "product.json");
    const before = JSON.stringify(unknownVersion, null, 2);
    await writeFile(filePath, before);
    await expect(JsonProductStore.open({ filePath, now: () => NOW })).rejects.toThrow();
    expect(await readFile(filePath, "utf8")).toBe(before);
  });
});

describe("S7只读Product Integrity Auditor", () => {
  it("对真实Planning/Note终态Fixture只读审计且不修改快照", async () => {
    for (const entry of S7_VERSIONED_FIXTURE_MANIFEST.filter(
      (candidate) => candidate.lifecycle === "terminal",
    )) {
      const snapshot = migrateS7FixtureToCurrent(await buildS7VersionedFixture(entry));
      const before = JSON.stringify(snapshot);
      const report = auditProductIntegrity(snapshot);
      expect(report.ok, JSON.stringify(report.issues)).toBe(true);
      expect(report.issues).toEqual([]);
      expect(JSON.stringify(snapshot)).toBe(before);
    }
  });

  it("一次报告Run/Transition/RunSpec/Definition/View/业务对象/Decision/Outbox/Attempt断链", async () => {
    const entry = S7_VERSIONED_FIXTURE_MANIFEST.find(
      (candidate) => candidate.workload === "new_planning" && candidate.lifecycle === "waiting",
    );
    if (entry === undefined) throw new Error("Manifest缺少new planning waiting");
    const damaged = structuredClone(
      migrateS7FixtureToCurrent(await buildS7VersionedFixture(entry)),
    ) as ProductSnapshot;
    const run = Object.values(damaged.entities.runs)[0];
    const runSpec = Object.values(damaged.entities.workflowRunSpecs)[0];
    const node = Object.values(damaged.entities.workflowNodeRuns)[0];
    const plan = Object.values(damaged.entities.plans)[0];
    const approval = Object.values(damaged.entities.approvalRequests)[0];
    const outbox = Object.values(damaged.outbox).find(
      (candidate) => candidate.kind === "workflow_start",
    );
    const attempt = Object.values(damaged.entities.attempts)[0];
    if (
      run === undefined ||
      runSpec === undefined ||
      node === undefined ||
      plan === undefined ||
      approval === undefined ||
      outbox === undefined ||
      attempt === undefined
    ) {
      throw new Error("S7 damaged Fixture缺少目标对象");
    }
    run.sessionId = "psn_missingaudit1" as never;
    runSpec.sha256 = "0".repeat(64);
    runSpec.definitionRef.definitionSha256 = "1".repeat(64);
    damaged.entities.workflowViewDefinitions[run.workflowViewDefinitionId]!.sha256 = "2".repeat(64);
    const transitions = Object.values(damaged.entities.nodeRunTransitions)
      .filter((candidate) => candidate.workflowNodeRunId === node.workflowNodeRunId)
      .sort((left, right) => left.nodeSequence - right.nodeSequence);
    transitions.at(-1)!.toStatus = transitions.at(-1)!.toStatus === "queued" ? "running" : "queued";
    plan.planningAttemptId = "att_missingaudit1" as never;
    approval.planSha256 = "3".repeat(64);
    outbox.workflowRunSpecId = "wrs_missingaudit1" as never;
    attempt.productRunId = "run_missingaudit1" as never;
    const receipt = Object.values(damaged.commandReceipts).find(
      (candidate) => candidate.resultRefs["productRunId"] !== undefined,
    );
    if (receipt === undefined) throw new Error("S7 damaged Fixture缺少Run Receipt");
    receipt.resultRefs["productRunId"] = "run_missingaudit1";

    const report = auditProductIntegrity(damaged);
    expect(report.ok).toBe(false);
    expect(new Set(report.issues.map((candidate) => candidate.code))).toEqual(
      expect.objectContaining(
        new Set([
          "run.session_missing",
          "runspec.hash_invalid",
          "runspec.definition_binding_invalid",
          "view.hash_or_graph_invalid",
          "node.last_transition_mismatch",
          "plan.run_attempt_invalid",
          "approval.plan_binding_invalid",
          "outbox.runspec_binding_invalid",
          "attempt.run_missing",
          "receipt.result_ref_missing",
        ]),
      ),
    );
    expect(JSON.stringify(report)).not.toContain("生成脱敏兼容计划");
  });

  it("Planning与Note Decision被篡改后分别报告绑定矛盾", async () => {
    const planningEntry = S7_VERSIONED_FIXTURE_MANIFEST.find(
      (candidate) => candidate.workload === "new_planning" && candidate.lifecycle === "terminal",
    );
    const noteEntry = S7_VERSIONED_FIXTURE_MANIFEST.find(
      (candidate) => candidate.workload === "note_capture" && candidate.lifecycle === "terminal",
    );
    if (planningEntry === undefined || noteEntry === undefined) {
      throw new Error("S7 Manifest缺少Decision终态Fixture");
    }
    const planning = migrateS7FixtureToCurrent(await buildS7VersionedFixture(planningEntry));
    const planningDecision = Object.values(planning.entities.decisions)[0];
    if (planningDecision === undefined) throw new Error("Planning Fixture缺少Decision");
    planningDecision.planSha256 = "4".repeat(64);
    expect(auditProductIntegrity(planning).issues.map((candidate) => candidate.code)).toContain(
      "decision.binding_invalid",
    );

    const note = migrateS7FixtureToCurrent(await buildS7VersionedFixture(noteEntry));
    const noteDecision = Object.values(note.entities.noteDecisions)[0];
    if (noteDecision === undefined) throw new Error("Note Fixture缺少Decision");
    noteDecision.candidateSha256 = "5".repeat(64);
    expect(auditProductIntegrity(note).issues.map((candidate) => candidate.code)).toContain(
      "note_decision.binding_invalid",
    );
  });

  it("Note waiting/terminal正式投影缺失时分别报告审核与提交矛盾", async () => {
    const waitingEntry = S7_VERSIONED_FIXTURE_MANIFEST.find(
      (candidate) => candidate.workload === "note_capture" && candidate.lifecycle === "waiting",
    );
    const terminalEntry = S7_VERSIONED_FIXTURE_MANIFEST.find(
      (candidate) => candidate.workload === "note_capture" && candidate.lifecycle === "terminal",
    );
    if (waitingEntry === undefined || terminalEntry === undefined) {
      throw new Error("S7 Manifest缺少Note waiting/terminal Fixture");
    }
    const waiting = migrateS7FixtureToCurrent(await buildS7VersionedFixture(waitingEntry));
    const reviewNode = Object.values(waiting.entities.workflowNodeRuns).find(
      (node) => node.nodeType === "human.note_review",
    );
    if (reviewNode === undefined) throw new Error("Note waiting Fixture缺少审核Node");
    reviewNode.status = "failed";
    expect(auditProductIntegrity(waiting).issues.map((candidate) => candidate.code)).toContain(
      "note_run.waiting_projection_missing",
    );

    const terminal = migrateS7FixtureToCurrent(await buildS7VersionedFixture(terminalEntry));
    const commitNode = Object.values(terminal.entities.workflowNodeRuns).find(
      (node) => node.nodeType === "note.commit",
    );
    if (commitNode === undefined) throw new Error("Note terminal Fixture缺少提交Node");
    commitNode.status = "failed";
    expect(auditProductIntegrity(terminal).issues.map((candidate) => candidate.code)).toContain(
      "note_run.commit_projection_missing",
    );
  });
});
