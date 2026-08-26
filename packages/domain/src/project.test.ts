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
  assertProjectLifecycleTransition,
  assertProjectWorkResume,
  assertProjectWorkTransition,
  computeProjectDecisionPayloadSha256,
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
      schemaVersion: "project-work.v2" as const,
      projectId: "prj_demo" as never,
      stageId: "pst_demo" as never,
      workKey: "demo-work",
      kind: "generic" as const,
      title: "Work",
      objective: "交付",
      acceptanceCriteria: ["有证据"],
      ownerParticipantId: "ppt_owner" as never,
      status: "approved" as const,
      practiceRevisionIds: [],
      resourceRefs: [],
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
  it("Project完成、暂停、归档与恢复是不同的显式生命周期", () => {
    expect(() =>
      assertProjectLifecycleTransition({ from: "active", to: "paused", evidenceIds: [] }),
    ).not.toThrow();
    expect(() =>
      assertProjectLifecycleTransition({ from: "paused", to: "completed", evidenceIds: [] }),
    ).toThrow("Evidence");
    expect(() =>
      assertProjectLifecycleTransition({
        from: "paused",
        to: "completed",
        evidenceIds: ["pev_done"],
      }),
    ).not.toThrow();
    expect(() =>
      assertProjectLifecycleTransition({ from: "completed", to: "active", evidenceIds: [] }),
    ).toThrow("不允许");
    expect(() =>
      assertProjectLifecycleTransition({ from: "archived", to: "active", evidenceIds: [] }),
    ).not.toThrow();
  });

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

describe("content-production.v1 Work规则", () => {
  it("区分Agent审核请求、用户Ready决定和真实Publication Outcome", () => {
    expect(() =>
      assertProjectWorkTransition({
        kind: "content_delivery",
        from: "producing",
        to: "needs_review",
        actorKind: "agent",
        hasActiveClaim: true,
        evidenceRoles: ["content_revision", "qc_report"],
        hasConfirmedPublicationOutcome: false,
        hasPracticeRevisionEvidence: false,
      }),
    ).not.toThrow();
    expect(() =>
      assertProjectWorkTransition({
        kind: "content_delivery",
        from: "needs_review",
        to: "ready",
        actorKind: "agent",
        hasActiveClaim: true,
        decisionId: "pdc_ready",
        evidenceRoles: ["content_revision", "qc_report"],
        hasConfirmedPublicationOutcome: false,
        hasPracticeRevisionEvidence: false,
      }),
    ).toThrow("只能由用户决定");
    expect(() =>
      assertProjectWorkTransition({
        kind: "content_delivery",
        from: "ready",
        to: "published",
        actorKind: "human",
        hasActiveClaim: false,
        decisionId: "pdc_publish",
        evidenceRoles: [],
        hasConfirmedPublicationOutcome: false,
        hasPracticeRevisionEvidence: false,
      }),
    ).toThrow("Publication Outcome");
  });

  it("Blocked只能凭恢复Evidence回原State，也能由用户终态决定关闭", () => {
    expect(() =>
      assertProjectWorkResume({
        kind: "content_delivery",
        previousState: "producing",
        targetState: "needs_review",
        recoveryEvidenceIds: ["pev_restore"],
      }),
    ).toThrow("原State");
    expect(() =>
      assertProjectWorkResume({
        kind: "content_delivery",
        previousState: "producing",
        targetState: "producing",
        recoveryEvidenceIds: ["pev_restore"],
      }),
    ).not.toThrow();
    expect(() =>
      assertProjectWorkTransition({
        kind: "content_delivery",
        from: "blocked",
        to: "dropped",
        actorKind: "human",
        hasActiveClaim: false,
        decisionId: "pdc_drop",
        evidenceRoles: [],
        hasConfirmedPublicationOutcome: false,
        hasPracticeRevisionEvidence: false,
      }),
    ).not.toThrow();
  });

  it("Decision Payload Hash绑定精确Work revision和用户看到的语义", () => {
    const base = {
      projectId: "prj_content",
      boundProjectRevision: 2,
      boundWorkId: "pwk_content",
      boundWorkRevision: 4,
      question: "是否Ready？",
      options: ["ready"],
      choice: "ready",
      rationale: "QC通过",
    };
    expect(computeProjectDecisionPayloadSha256(base)).not.toBe(
      computeProjectDecisionPayloadSha256({ ...base, boundWorkRevision: 5 }),
    );
  });
});

describe("generic Work规则", () => {
  const base = {
    kind: "generic" as const,
    actorKind: "agent" as const,
    hasActiveClaim: true,
    hasConfirmedPublicationOutcome: false,
    hasPracticeRevisionEvidence: false,
  };

  it("Agent只能凭Claim和Evidence请求Review，Done必须由用户决定", () => {
    expect(() =>
      assertProjectWorkTransition({
        ...base,
        from: "in_progress",
        to: "review",
        evidenceRoles: [],
      }),
    ).toThrow("精确Evidence");
    expect(() =>
      assertProjectWorkTransition({
        ...base,
        from: "in_progress",
        to: "review",
        evidenceRoles: ["test"],
      }),
    ).not.toThrow();
    expect(() =>
      assertProjectWorkTransition({
        ...base,
        from: "review",
        to: "done",
        decisionId: "pdc_done",
        evidenceRoles: ["commit", "test"],
      }),
    ).toThrow("只能由用户决定");
    expect(() =>
      assertProjectWorkTransition({
        ...base,
        actorKind: "human",
        hasActiveClaim: false,
        from: "review",
        to: "done",
        decisionId: "pdc_done",
        evidenceRoles: ["commit", "test"],
      }),
    ).not.toThrow();
  });

  it("Block作为正交对象恢复到原generic状态并要求Evidence", () => {
    expect(() =>
      assertProjectWorkResume({
        kind: "generic",
        previousState: "in_progress",
        targetState: "review",
        recoveryEvidenceIds: ["pev_restore"],
      }),
    ).toThrow("原State");
    expect(() =>
      assertProjectWorkResume({
        kind: "generic",
        previousState: "in_progress",
        targetState: "in_progress",
        recoveryEvidenceIds: [],
      }),
    ).toThrow("Evidence");
    expect(() =>
      assertProjectWorkResume({
        kind: "generic",
        previousState: "in_progress",
        targetState: "in_progress",
        recoveryEvidenceIds: ["pev_restore"],
      }),
    ).not.toThrow();
  });
});
