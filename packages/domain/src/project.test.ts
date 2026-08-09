import { describe, expect, it } from "vitest";
import {
  assertProjectWorkGraph,
  assertProjectActionTransition,
  compileProjectIntakeProposal,
  computeProjectCandidateSha256,
  computeProjectObservationSha256,
  compileProjectMethodSnapshotPolicies,
  assertProjectStageTransition,
  assertProjectMilestoneTransition,
  type ProjectIntakeUnderstandingShape,
  type ProjectObservationDataShape,
  type ProjectWorkShape,
} from "./project.js";

const understanding: ProjectIntakeUnderstandingShape = {
  name: "Chat",
  goal: "持续开发Chat产品",
  summary: "建立长期项目并梳理待办",
  scopeHints: ["维护代码与项目文档"],
  successCriteriaHints: ["项目事实可跨会话恢复"],
  initialWorkHints: ["建立项目基线"],
  openQuestions: [],
};
const observation: ProjectObservationDataShape = {
  git: {
    headSha: "a".repeat(40),
    branch: "main",
    dirty: false,
    trackedFileCount: 12,
    recentCommitCount: 3,
  },
  documents: [
    { relativePath: "docs/architecture.md", sha256: "b".repeat(64) as never, sizeBytes: 20 },
  ],
  scripts: [{ name: "test", command: "vitest run" }],
};

describe("Project领域规则", () => {
  it("根据真实软件信号确定性编译方法和Candidate Hash", () => {
    const proposal = compileProjectIntakeProposal({ understanding, observation });
    expect(proposal.method.profileId).toBe("software-delivery.v1");
    const observationSha256 = computeProjectObservationSha256(observation);
    expect(
      computeProjectCandidateSha256({
        proposal,
        observationSha256,
        sourceMessageId: "msg_demo",
        rootId: "root_demo",
        enabledAdapters: ["local-git-workspace.v1"],
      }),
    ).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("拒绝Work自依赖和循环", () => {
    const base = {
      schemaVersion: "project-work.v1" as const,
      projectId: "prj_demo" as never,
      stageId: "pst_demo" as never,
      title: "Work",
      objective: "交付",
      acceptanceCriteria: ["有证据"],
      ownerParticipantId: "ppt_owner" as never,
      status: "approved" as const,
      revision: 1,
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    };
    const works: ProjectWorkShape[] = [
      { ...base, projectWorkId: "pwk_a" as never, dependsOn: ["pwk_b" as never] },
      { ...base, projectWorkId: "pwk_b" as never, dependsOn: ["pwk_a" as never] },
    ];
    expect(() => assertProjectWorkGraph(works)).toThrow("循环");
  });
});

describe("Project Action状态机", () => {
  it("允许正常推进并要求blocked原因", () => {
    expect(() => assertProjectActionTransition({ from: "todo", to: "doing" })).not.toThrow();
    expect(() =>
      assertProjectActionTransition({ from: "doing", to: "blocked", blockedReason: "等待审核" }),
    ).not.toThrow();
    expect(() => assertProjectActionTransition({ from: "doing", to: "blocked" })).toThrow(
      "blocked必须说明原因",
    );
  });

  it("done/cancelled终态不能回退", () => {
    expect(() => assertProjectActionTransition({ from: "done", to: "doing" })).toThrow("不允许");
    expect(() => assertProjectActionTransition({ from: "cancelled", to: "todo" })).toThrow(
      "不允许",
    );
  });
});

describe("PS2.1 Method、Stage与Milestone规则", () => {
  it("按profile编译完整且不同的软件/轻量策略", () => {
    const software = compileProjectMethodSnapshotPolicies("software-delivery.v1");
    const lightweight = compileProjectMethodSnapshotPolicies("lightweight.v1");
    expect(software).toMatchObject({
      iteration: { enabled: true, circuitBreaker: true },
      artifact: { requiredRoles: ["requirements", "architecture", "testing_strategy"] },
      work: { readyGate: "required", doneGate: "required" },
    });
    expect(lightweight).toMatchObject({
      iteration: { enabled: false, appetiteKind: "review_trigger" },
      artifact: { requiredRoles: [] },
    });
  });

  it("Stage终态必须有Decision，软件完成还必须有Evidence", () => {
    expect(() =>
      assertProjectStageTransition({
        from: "active",
        to: "review",
        evidenceIds: [],
        evidenceRequirement: "required",
      }),
    ).not.toThrow();
    expect(() =>
      assertProjectStageTransition({
        from: "review",
        to: "completed",
        evidenceIds: [],
        evidenceRequirement: "required",
      }),
    ).toThrow("Decision");
    expect(() =>
      assertProjectStageTransition({
        from: "review",
        to: "completed",
        decisionId: "pdc_done",
        evidenceIds: [],
        evidenceRequirement: "required",
      }),
    ).toThrow("Evidence");
  });

  it("Milestone达成不能由Action计数推导，必须显式Decision和Evidence", () => {
    expect(() =>
      assertProjectMilestoneTransition({
        from: "planned",
        to: "achieved",
        decisionId: "pdc_done",
        evidenceIds: [],
      }),
    ).toThrow("Evidence");
    expect(() =>
      assertProjectMilestoneTransition({
        from: "planned",
        to: "achieved",
        decisionId: "pdc_done",
        evidenceIds: ["pev_proof"],
      }),
    ).not.toThrow();
  });
});
