import { describe, expect, it } from "vitest";
import {
  assertPlanningProjectContextIntegrity,
  computePlanningProjectContextSha256,
  type PlanningProjectContextShape,
} from "./planning-project-context.js";

function makeSnapshot() {
  return {
    name: "Chat",
    summary: "对话产品",
    goal: "交付可验证工作",
    scopeIn: ["工作流"],
    scopeOut: [],
    successCriteria: ["验证通过"],
    status: "active" as const,
    methodProfileId: "software-delivery.v1" as const,
    stage: {
      key: "delivery",
      name: "交付",
      goal: "完成纵向链",
      successCriteria: ["测试通过"],
      status: "active" as const,
    },
    milestones: [],
    activeWorks: [],
  };
}

function makeContext(): PlanningProjectContextShape {
  const snapshot = makeSnapshot();
  const base = {
    productRunId: "run_planning1",
    projectId: "prj_chat1",
    projectRevision: 2,
    projectSha256: "a".repeat(64),
    methodRef: {
      projectMethodSnapshotId: "pms_method1",
      revision: 1,
      sha256: "b".repeat(64),
    },
    stageRef: { projectStageId: "pst_stage1", revision: 3, sha256: "c".repeat(64) },
    snapshot,
    sourceRefs: [
      { kind: "project" as const, objectId: "prj_chat1", revision: 2, sha256: "a".repeat(64) },
      { kind: "method" as const, objectId: "pms_method1", revision: 1, sha256: "b".repeat(64) },
      { kind: "stage" as const, objectId: "pst_stage1", revision: 3, sha256: "c".repeat(64) },
    ],
  };
  return {
    schemaVersion: "planning-project-context.v1",
    planningProjectContextId: "pcx_context1",
    ...base,
    sha256: computePlanningProjectContextSha256(base),
    revision: 1,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

describe("Planning Project Context", () => {
  it("冻结正文或来源证据被改写时Hash失败", () => {
    const context = makeContext();
    expect(() => assertPlanningProjectContextIntegrity(context)).not.toThrow();
    expect(() =>
      assertPlanningProjectContextIntegrity({
        ...context,
        methodRef: { ...context.methodRef, revision: 2 },
      }),
    ).toThrow("三元组");
    expect(() =>
      assertPlanningProjectContextIntegrity({
        ...context,
        snapshot: { ...makeSnapshot(), goal: "被改写" },
      }),
    ).toThrow("Hash");
  });
});
