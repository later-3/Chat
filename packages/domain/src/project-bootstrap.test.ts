import { describe, expect, it } from "vitest";
import {
  assertProjectBootstrapCandidateTransition,
  assertProjectBootstrapDecisionBinding,
  computeProjectBootstrapCandidateSha256,
  deriveProjectBootstrapOutcome,
} from "./project-bootstrap.js";

const immutable = {
  ownerPrincipalId: "usr_owner",
  sourceProductSessionId: "psn_session",
  sourceProductRunId: "run_direct",
  proposal: {
    name: "AI 学习",
    objective: "形成公开课、论文与开源实践产物。",
    planeWorkspaceSlug: "learning",
    planeProjectIdentifier: "AI2026",
    workspaceRootId: "root_code",
    directoryName: "ai-learning",
    initializerProfile: "ai_learning" as const,
    initialModules: ["公开课", "论文"],
  },
  preview: {
    planeProjectLabel: "Learning/AI2026",
    workspaceLabel: "Code/ai-learning",
    gitAction: "initialize" as const,
    initialModules: ["公开课", "论文"],
  },
};

describe("Project Bootstrap Domain", () => {
  it("候选Hash只绑定不可变计划，确认必须绑定revision与hash", () => {
    const sha256 = computeProjectBootstrapCandidateSha256(immutable);
    const candidate = {
      schemaVersion: "project-bootstrap.v1",
      projectBootstrapCandidateId: "pbc_one",
      ...immutable,
      status: "prepared",
      sha256,
      revision: 1,
      createdAt: "2026-08-20T10:00:00.000Z",
      updatedAt: "2026-08-20T10:00:00.000Z",
    } as const;
    const decision = {
      schemaVersion: "project-bootstrap.v1",
      projectBootstrapDecisionId: "pbd_one",
      projectBootstrapCandidateId: candidate.projectBootstrapCandidateId,
      candidateRevision: 1,
      candidateSha256: sha256,
      decidedByPrincipalId: "usr_owner",
      kind: "confirm",
      decidedAt: "2026-08-20T10:01:00.000Z",
    } as const;
    expect(() => assertProjectBootstrapDecisionBinding({ candidate, decision })).not.toThrow();
    const confirmed = {
      ...candidate,
      status: "confirmed",
      revision: 2,
      updatedAt: decision.decidedAt,
    } as const;
    expect(() =>
      assertProjectBootstrapCandidateTransition({ current: candidate, next: confirmed }),
    ).not.toThrow();
  });

  it("只有两边完成才ready，局部成功进入needs_attention", () => {
    expect(deriveProjectBootstrapOutcome({ workspace: "completed", plane: "completed" })).toBe(
      "ready",
    );
    expect(deriveProjectBootstrapOutcome({ workspace: "completed", plane: "failed" })).toBe(
      "needs_attention",
    );
    expect(
      deriveProjectBootstrapOutcome({ workspace: "outcome_unknown", plane: "completed" }),
    ).toBe("outcome_unknown");
  });
});
