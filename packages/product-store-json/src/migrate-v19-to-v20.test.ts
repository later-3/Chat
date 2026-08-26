import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileProjectMethodSnapshotPolicies, hashCanonical } from "@chat/domain";
import { describe, expect, it } from "vitest";
import { JsonProductStore } from "./json-product-store.js";
import { productSnapshotV19Schema } from "./legacy-v19.js";
import { productSnapshotV20Schema } from "./legacy-v20.js";
import { migrateProductSnapshotV19ToV20 } from "./migrate-v19-to-v20.js";
import { migrateProductSnapshotV20ToV21 } from "./migrate-v20-to-v21.js";
import { migrateProductSnapshotV21ToV22 } from "./migrate-v21-to-v22.js";
import { migrateProductSnapshotV22ToV23 } from "./migrate-v22-to-v23.js";
import { migrateProductSnapshotV23ToV24 } from "./migrate-v23-to-v24.js";
import { migrateProductSnapshotV24ToV25 } from "./migrate-v24-to-v25.js";
import { migrateProductSnapshotV25ToV26 } from "./migrate-v25-to-v26.js";
import { assertSnapshotIntegrity } from "./snapshot-integrity.js";

const NOW = "2026-08-24T08:00:00.000Z";

const migrateProductSnapshotV20ToCurrent = (
  snapshot: Parameters<typeof migrateProductSnapshotV20ToV21>[0],
) =>
  migrateProductSnapshotV25ToV26(
    migrateProductSnapshotV24ToV25(
      migrateProductSnapshotV23ToV24(
        migrateProductSnapshotV22ToV23(
          migrateProductSnapshotV21ToV22(migrateProductSnapshotV20ToV21(snapshot)),
        ),
      ),
    ),
  );

async function nonEmptyV19() {
  const directory = await mkdtemp(join(tmpdir(), "chat-v19-v20-fixture-"));
  const store = await JsonProductStore.open({
    filePath: join(directory, "product-store.json"),
    now: () => NOW,
  });
  const current = (await store.read({ kind: "committedSnapshot" })).snapshot;
  const entities = structuredClone(current.entities) as Record<string, unknown>;
  for (const key of [
    "projectWorkBlocks",
    "projectWorkClaims",
    "projectWorkHandoffs",
    "projectPracticeRevisions",
    "projectWorkOutcomes",
    "projectContextMaps",
    "projectProviderBindings",
    "projectProviderProjections",
    "projectCoordinationOperations",
    "projectInboundChanges",
    "toolExecutionIntents",
    "toolExecutionDecisions",
    "toolExecutionResults",
    "projectProfileRevisions",
    "projectConfigurationRevisions",
    "projectEvents",
    "projectNeeds",
    "projectRequirements",
    "projectArtifactRefs",
    "projectMetricObservations",
    "supervisedPlanningEpochs",
    "supervisedCarryForwards",
    "supervisedStepStates",
    "supervisedAgentAttempts",
    "supervisedStepEvidence",
    "supervisedStepCandidates",
    "supervisedPlannerVerdicts",
    "supervisedStepReviewRequests",
    "supervisedStepHumanDecisions",
    "supervisedAgentOutcomeObservations",
    "supervisedExecutionResults",
    "memorySessionImports",
    "memoryAgentOperations",
    "memoryAgentWriteCandidates",
    "memoryAgentWriteDecisions",
  ]) {
    delete entities[key];
  }
  const { coordination: _coordination, ...policies } =
    compileProjectMethodSnapshotPolicies("software-delivery.v1");
  void _coordination;
  entities["projects"] = {
    prj_v19migration1: {
      schemaVersion: "project.v2",
      projectId: "prj_v19migration1",
      ownerPrincipalId: "usr_v19migration1",
      name: "v19迁移项目",
      summary: "验证非空Project事实升级",
      goal: "无损升级到内容协调内核",
      scopeIn: ["保留旧事实"],
      scopeOut: [],
      successCriteria: ["升级后完整性门通过"],
      status: "active",
      methodSnapshotId: "pms_v19migration1",
      currentStageId: "pst_v19migration1",
      revision: 3,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
  entities["projectMethodSnapshots"] = {
    pms_v19migration1: {
      schemaVersion: "project-method-snapshot.v2",
      projectMethodSnapshotId: "pms_v19migration1",
      projectId: "prj_v19migration1",
      profileId: "software-delivery.v1",
      rationale: "旧软件交付方法",
      policies,
      source: "project_intake",
      sha256: hashCanonical("project-method-snapshot.v2", {
        profileId: "software-delivery.v1",
        rationale: "旧软件交付方法",
        policies,
        source: "project_intake",
      }),
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
  entities["projectStages"] = {
    pst_v19migration1: {
      schemaVersion: "project-stage.v2",
      projectStageId: "pst_v19migration1",
      projectId: "prj_v19migration1",
      methodSnapshotId: "pms_v19migration1",
      key: "delivery",
      name: "交付",
      goal: "完成旧工作",
      successCriteria: ["旧Work仍可恢复"],
      status: "active",
      sequence: 1,
      startedAt: NOW,
      completionEvidenceIds: [],
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
  entities["projectParticipants"] = {
    ppt_v19migration1: {
      schemaVersion: "project-participant.v1",
      projectParticipantId: "ppt_v19migration1",
      projectId: "prj_v19migration1",
      kind: "human",
      principalId: "usr_v19migration1",
      displayName: "旧项目所有者",
      role: "owner",
      status: "active",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
  entities["projectWorks"] = {
    pwk_v19migration1: {
      schemaVersion: "project-work.v1",
      projectWorkId: "pwk_v19migration1",
      projectId: "prj_v19migration1",
      stageId: "pst_v19migration1",
      title: "旧Work",
      objective: "保留旧Work语义",
      acceptanceCriteria: ["迁移后成为generic Work"],
      dependsOn: [],
      ownerParticipantId: "ppt_v19migration1",
      status: "draft",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
  entities["projectEvidence"] = {
    pev_v19migration1: {
      schemaVersion: "project-evidence.v1",
      projectEvidenceId: "pev_v19migration1",
      projectId: "prj_v19migration1",
      kind: "artifact",
      label: "旧Artifact引用",
      revisionRef: "legacy-r1",
      sha256: "a".repeat(64),
      observedAt: NOW,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
  entities["projectDecisions"] = {
    pdc_v19migration1: {
      schemaVersion: "project-decision.v1",
      projectDecisionId: "pdc_v19migration1",
      projectId: "prj_v19migration1",
      question: "是否保留旧项目？",
      options: ["保留", "删除"],
      choice: "保留",
      rationale: "历史用户决定",
      decidedByParticipantId: "ppt_v19migration1",
      boundProjectRevision: 1,
      status: "active",
      commandId: "cmd_v19migration1",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
  return productSnapshotV19Schema.parse({
    ...current,
    schemaVersion: "chat-product-store.v19",
    entities,
  });
}

describe("Product Store v19到v20内容协调内核迁移", () => {
  it("无损升级非空Project事实且不伪造内容Work、Claim、Outcome或Provider Binding", async () => {
    const legacy = await nonEmptyV19();
    const migrated = migrateProductSnapshotV19ToV20(legacy);

    expect(migrated.schemaVersion).toBe("chat-product-store.v20");
    expect(migrated.entities.projectMethodSnapshots["pms_v19migration1"]).toMatchObject({
      schemaVersion: "project-method-snapshot.v3",
      revision: 2,
    });
    expect(migrated.entities.projectWorks["pwk_v19migration1"]).toMatchObject({
      schemaVersion: "project-work.v2",
      kind: "generic",
      workKey: "legacy:pwk_v19migration1",
      revision: 2,
    });
    expect(migrated.entities.projectEvidence["pev_v19migration1"]).toMatchObject({
      schemaVersion: "project-evidence.v2",
      role: "artifact",
      verification: "reported",
      sourceKind: "runtime",
    });
    expect(migrated.entities.projectDecisions["pdc_v19migration1"]?.payloadSha256).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    expect(migrated.entities.projectWorkClaims).toEqual({});
    expect(migrated.entities.projectWorkOutcomes).toEqual({});
    expect(migrated.entities.projectProviderBindings).toEqual({});
    expect(() => productSnapshotV20Schema.parse(migrated)).not.toThrow();
  });

  it("真实v19字节首次打开原子升级，第二次打开不再改写", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-v19-v20-open-"));
    const filePath = join(directory, "product-store.json");
    await writeFile(filePath, JSON.stringify(await nonEmptyV19(), null, 2));

    await JsonProductStore.open({ filePath, now: () => NOW });
    const once = await readFile(filePath, "utf8");
    expect(JSON.parse(once)).toMatchObject({ schemaVersion: "chat-product-store.v24" });
    await JsonProductStore.open({ filePath, now: () => NOW });
    expect(await readFile(filePath, "utf8")).toBe(once);
  });

  it("v20非空Provider事实升级为待核对v21且不制造Operation或入站事实", async () => {
    const legacy = migrateProductSnapshotV19ToV20(await nonEmptyV19());
    legacy.entities.projectResources["prs_v20planeroot1"] = {
      schemaVersion: "project-resource.v1",
      projectResourceId: "prs_v20planeroot1" as never,
      projectId: "prj_v19migration1" as never,
      rootId: "root_v20plane",
      displayName: "v20 Plane迁移Root",
      kind: "workspace",
      enabledAdapters: ["local-git-workspace.v1"],
      status: "active",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    legacy.entities.projectProviderBindings["pvb_v20plane1"] = {
      schemaVersion: "project-provider-binding.v1",
      projectProviderBindingId: "pvb_v20plane1" as never,
      projectId: "prj_v19migration1" as never,
      ownerPrincipalId: "usr_v19migration1" as never,
      providerKind: "plane_ce",
      providerVersion: "1.4.1",
      externalWorkspaceId: "later",
      externalProjectId: "00000000-0000-4000-8000-000000000020",
      externalProjectIdentifier: "LEGACY",
      syncPolicyVersion: "content-lab-plane-mapping.v1",
      status: "active",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    legacy.entities.projectProviderProjections["pvp_v20plane1"] = {
      schemaVersion: "project-provider-projection.v1",
      projectProviderProjectionId: "pvp_v20plane1" as never,
      projectId: "prj_v19migration1" as never,
      bindingId: "pvb_v20plane1" as never,
      objectType: "work",
      objectId: "pwk_v19migration1",
      providerObjectType: "work_item",
      providerObjectId: "00000000-0000-4000-8000-000000000021",
      externalKey: "legacy:pwk_v19migration1",
      chatObjectRevision: 2,
      providerFingerprint: "b".repeat(64),
      syncStatus: "healthy",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };

    const projectV21 = migrateProductSnapshotV20ToV21(productSnapshotV20Schema.parse(legacy));
    const migrated = migrateProductSnapshotV21ToV22(projectV21);

    expect(migrated.entities.projectProviderBindings["pvb_v20plane1"]).toMatchObject({
      schemaVersion: "project-provider-binding.v2",
      workspaceRootId: "root_v20plane",
      status: "needs_attention",
      revision: 2,
    });
    expect(migrated.entities.projectProviderProjections["pvp_v20plane1"]).toMatchObject({
      schemaVersion: "project-provider-projection.v2",
      syncStatus: "needs_attention",
      revision: 2,
    });
    expect(migrated.entities.projectCoordinationOperations).toEqual({});
    expect(migrated.entities.projectInboundChanges).toEqual({});
    expect(migrated.entities.toolExecutionIntents).toEqual({});
    expect(migrated.entities.toolExecutionDecisions).toEqual({});
    expect(migrated.entities.toolExecutionResults).toEqual({});
    expect(() =>
      assertSnapshotIntegrity(
        migrateProductSnapshotV25ToV26(
          migrateProductSnapshotV24ToV25(
            migrateProductSnapshotV23ToV24(migrateProductSnapshotV22ToV23(migrated)),
          ),
        ),
      ),
    ).not.toThrow();

    const v21Directory = await mkdtemp(join(tmpdir(), "chat-project-v21-v22-"));
    const v21Path = join(v21Directory, "product-store.json");
    await writeFile(v21Path, JSON.stringify(projectV21));
    const v23Store = await JsonProductStore.open({ filePath: v21Path, now: () => NOW });
    const v23FromDisk = (await v23Store.read({ kind: "committedSnapshot" })).snapshot;
    expect(v23FromDisk.schemaVersion).toBe("chat-product-store.v24");
    expect(v23FromDisk.entities.projectProviderBindings).toEqual(
      projectV21.entities.projectProviderBindings,
    );
    expect(v23FromDisk.entities.projectProfileRevisions).toEqual({});
    const once = await readFile(v21Path, "utf8");
    await JsonProductStore.open({ filePath: v21Path, now: () => NOW });
    expect(await readFile(v21Path, "utf8")).toBe(once);

    const withoutRoot = structuredClone(legacy);
    delete withoutRoot.entities.projectResources["prs_v20planeroot1"];
    const quarantinedWithoutRoot = migrateProductSnapshotV20ToCurrent(
      productSnapshotV20Schema.parse(withoutRoot),
    );
    expect(quarantinedWithoutRoot.entities.projectProviderBindings["pvb_v20plane1"]).toMatchObject({
      status: "needs_attention",
    });
    expect(
      quarantinedWithoutRoot.entities.projectProviderBindings["pvb_v20plane1"]?.workspaceRootId,
    ).toBeUndefined();
    expect(() => assertSnapshotIntegrity(quarantinedWithoutRoot)).not.toThrow();

    const withAmbiguousRoots = structuredClone(legacy);
    withAmbiguousRoots.entities.projectResources["prs_v20planeroot2"] = {
      ...withAmbiguousRoots.entities.projectResources["prs_v20planeroot1"]!,
      projectResourceId: "prs_v20planeroot2" as never,
      rootId: "root_v20planeother",
      displayName: "v20 Plane迁移另一个Root",
    };
    const quarantinedAmbiguous = migrateProductSnapshotV20ToCurrent(
      productSnapshotV20Schema.parse(withAmbiguousRoots),
    );
    expect(
      quarantinedAmbiguous.entities.projectProviderBindings["pvb_v20plane1"]?.workspaceRootId,
    ).toBeUndefined();
    expect(() => assertSnapshotIntegrity(quarantinedAmbiguous)).not.toThrow();
  });
});
