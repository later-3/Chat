import { describe, expect, it } from "vitest";
import {
  beginProjectAdvancementPayloadSchema,
  projectAdvancementUnderstandingSchema,
  projectMethodSnapshotPoliciesSchema,
  projectMilestoneSchema,
  projectStateTransitionSchema,
  projectUpdateSchema,
} from "./index.js";

const now = "2026-08-09T12:00:00.000Z";

describe("PS2.1 Project Advancement合同", () => {
  it("接受完整Method Policy并拒绝未知口袋字段", () => {
    const policies = {
      stage: {
        singleActive: true as const,
        completionDecision: "required" as const,
        completionEvidence: "required" as const,
      },
      iteration: {
        enabled: true,
        singleActive: true as const,
        appetiteKind: "timebox_days" as const,
        minDays: 1,
        maxDays: 42,
        circuitBreaker: true,
      },
      work: {
        scopeEnabled: true,
        readyGate: "required" as const,
        doneGate: "required" as const,
      },
      artifact: {
        requiredRoles: ["requirements", "architecture", "testing_strategy"] as const,
      },
      quality: { evidenceRequired: true, waiverRequiresApproverAndExpiry: true as const },
      change: {
        stageTransitionDecision: "required" as const,
        iterationCommitmentDecision: "required" as const,
      },
      coordination: {
        workKinds: ["generic"] as const,
        claimPolicy: "optional" as const,
        blockedRecoveryEvidence: false,
        terminalDecision: "required" as const,
        publicationOutcomeRequired: false,
        practiceAdoptionEvidenceRequired: false,
      },
    };
    expect(projectMethodSnapshotPoliciesSchema.parse(policies)).toEqual(policies);
    expect(() =>
      projectMethodSnapshotPoliciesSchema.parse({ ...policies, metadata: { arbitrary: true } }),
    ).toThrow();
  });

  it("Milestone、Update与Transition使用严格类型化引用", () => {
    expect(
      projectMilestoneSchema.parse({
        schemaVersion: "project-milestone.v1",
        projectMilestoneId: "pml_demo",
        projectId: "prj_demo",
        stageId: "pst_demo",
        outcome: "完成纵向闭环",
        acceptanceCriteria: ["浏览器可完成核心路径"],
        status: "planned",
        evidenceIds: [],
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }).status,
    ).toBe("planned");
    expect(
      projectUpdateSchema.parse({
        schemaVersion: "project-update.v1",
        projectUpdateId: "pup_demo",
        projectId: "prj_demo",
        stageId: "pst_demo",
        authorParticipantId: "ppt_owner",
        confirmedByPrincipalId: "usr_owner",
        health: "at_risk",
        narrative: "真实浏览器门尚未完成。",
        observedChanges: [],
        blockers: ["等待验证"],
        nextFocus: ["完成验证"],
        evidenceIds: [],
        boundProjectRevision: 2,
        boundStageRevision: 2,
        publishedAt: now,
        commandId: "cmd_update",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }).health,
    ).toBe("at_risk");
    expect(
      projectStateTransitionSchema.parse({
        schemaVersion: "project-state-transition.v1",
        projectStateTransitionId: "ptr_demo",
        projectId: "prj_demo",
        objectType: "stage",
        objectId: "pst_demo",
        from: "active",
        to: "review",
        actorParticipantId: "ppt_owner",
        commandId: "cmd_transition",
        beforeRevision: 1,
        afterRevision: 2,
        reason: "进入阶段评审",
        decisionId: "pdc_demo",
        evidenceIds: [],
        occurredAt: now,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }).objectType,
    ).toBe("stage");
  });

  it("真实模型Understanding严格，浏览器不能指定Provider或模型", () => {
    const understanding = {
      stage: { name: "推进", goal: "完成闭环", successCriteria: ["可恢复"] },
      milestones: [],
      update: {
        health: "unknown" as const,
        narrative: "尚未形成负责人判断。",
        observedChanges: [],
        blockers: [],
        nextFocus: ["等待确认"],
      },
    };
    expect(projectAdvancementUnderstandingSchema.parse(understanding)).toEqual(understanding);
    expect(() =>
      beginProjectAdvancementPayloadSchema.parse({
        sessionId: "psn_demo",
        projectId: "prj_demo",
        text: "推进项目",
        provider: "bailian",
        model: "qwen3.7-plus",
      }),
    ).toThrow();
  });
});
