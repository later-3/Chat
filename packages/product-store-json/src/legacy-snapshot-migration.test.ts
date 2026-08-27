import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "@chat/contracts";
import { migrateLegacyProductSnapshot } from "./legacy-snapshot-migration.js";

const NOW = "2026-08-27T00:00:00.000Z";

describe("Project删除后的历史Store兼容", () => {
  it("保留当前Chat事实并丢弃退出产品的实体集合", () => {
    const current = createEmptySnapshot(NOW);
    current.entities.sessions["psn_legacy1" as never] = {
      schemaVersion: "product-session.v1",
      sessionId: "psn_legacy1" as never,
      ownerPrincipalId: "usr_legacy1" as never,
      status: "active",
      lastMessageSequence: 0,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const legacy = {
      ...current,
      schemaVersion: "chat-product-store.v26",
      entities: {
        ...current.entities,
        projects: {
          prj_legacy1: { projectId: "prj_legacy1", name: "已退出的历史对象" },
        },
      },
    };

    const migrated = migrateLegacyProductSnapshot(legacy);

    expect(migrated.schemaVersion).toBe("chat-product-store.v27");
    expect(migrated.entities.sessions["psn_legacy1"]).toBeDefined();
    expect(
      Object.keys(migrated.entities).some((key) => key.toLowerCase().includes("project")),
    ).toBe(false);
  });

  it("删除project_bootstrap失败运行及其关联事实", () => {
    const current = createEmptySnapshot(NOW);
    const legacy = {
      ...current,
      schemaVersion: "chat-product-store.v26",
      storeRevision: 1,
      entities: {
        ...current.entities,
        runs: { run_retired1: { productRunId: "run_retired1", workflowRunSpecId: "wrs_retired1" } },
        attempts: { att_retired1: { productRunId: "run_retired1" } },
        promptAssemblies: {
          pma_retired1: {
            productRunId: "run_retired1",
            tools: { capabilityMode: "project_bootstrap" },
          },
        },
        workflowRunSpecs: {
          wrs_retired1: {
            workflowRunSpecId: "wrs_retired1",
            productRunId: "run_retired1",
          },
        },
        workflowNodeRuns: {
          wnr_retired1: {
            workflowNodeRunId: "wnr_retired1",
            productRunId: "run_retired1",
            workflowRunSpecId: "wrs_retired1",
          },
        },
        nodeRunTransitions: {
          nrt_retired1: { workflowNodeRunId: "wnr_retired1" },
        },
        nodeValueManifests: {
          nvm_retired1: { workflowNodeRunId: "wnr_retired1" },
        },
      },
      commandReceipts: {
        cmd_retired1: {
          commandId: "cmd_retired1",
          commandType: "SubmitUserMessage",
          requestSha256: "a".repeat(64),
          resultRefs: { productRunId: "run_retired1" },
          committedStoreRevision: 1,
          createdAt: NOW,
        },
      },
      outbox: {
        obx_retired1: {
          schemaVersion: "outbox-entry.v1",
          outboxId: "obx_retired1",
          kind: "workflow_start",
          productRunId: "run_retired1",
          workflowRunSpecId: "wrs_retired1",
          runnerFamily: "direct-agent.v1",
          runnerBundleVersion: "direct-agent.bundle.v1",
          status: "acknowledged",
          dispatchAttempts: 1,
          revision: 2,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    };

    const migrated = migrateLegacyProductSnapshot(legacy);

    expect(migrated.entities.runs).toEqual({});
    expect(migrated.entities.attempts).toEqual({});
    expect(migrated.entities.promptAssemblies).toEqual({});
    expect(migrated.entities.workflowRunSpecs).toEqual({});
    expect(migrated.entities.workflowNodeRuns).toEqual({});
    expect(migrated.entities.nodeRunTransitions).toEqual({});
    expect(migrated.entities.nodeValueManifests).toEqual({});
    expect(migrated.storeRevision).toBe(1);
    expect(migrated.commandReceipts["cmd_retired1"]).toMatchObject({
      commandType: "RetiredFeatureCommand",
      committedStoreRevision: 1,
      resultRefs: {},
    });
    expect(migrated.outbox).toEqual({});
  });

  it("未收敛的Project Outbox失败关闭", () => {
    const current = createEmptySnapshot(NOW);
    const legacy = {
      ...current,
      schemaVersion: "chat-product-store.v26",
      outbox: {
        obx_retired1: {
          schemaVersion: "outbox-entry.v1",
          outboxId: "obx_retired1",
          kind: "project_intake_start",
          status: "pending",
        },
      },
    };

    expect(() => migrateLegacyProductSnapshot(legacy)).toThrow("Project Outbox尚未收敛");
  });

  it("v1-v9和嵌入核心事实的Project证据给出明确恢复动作", () => {
    expect(() => migrateLegacyProductSnapshot({ schemaVersion: "chat-product-store.v9" })).toThrow(
      "备份分支升级到v10",
    );

    const current = createEmptySnapshot(NOW);
    const legacy = {
      ...current,
      schemaVersion: "chat-product-store.v26",
      entities: {
        ...current.entities,
        executionContracts: {
          exc_retired1: {
            workspaceRef: {
              projectId: "prj_retired1",
              projectResourceId: "prs_retired1",
              rootId: "root_chat",
              revision: 1,
            },
          },
        },
      },
    };
    expect(() => migrateLegacyProductSnapshot(legacy)).toThrow("备份分支导出或归档这些历史证据");

    const legacyRule = {
      ...current,
      schemaVersion: "chat-product-store.v26",
      entities: {
        ...current.entities,
        ruleRevisions: {
          rrv_retired1: {
            scopes: [
              {
                kind: "contextual",
                projectMethodProfileId: "software_delivery",
                projectStageKey: "delivery",
              },
            ],
          },
        },
      },
    };
    expect(() => migrateLegacyProductSnapshot(legacyRule)).toThrow("备份分支解除作用域后再升级");
  });
});
