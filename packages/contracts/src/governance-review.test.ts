import { describe, expect, it } from "vitest";
import {
  governanceEvidenceKeySchema,
  governanceReviewCandidateSchema,
} from "./governance-review.js";
import { agentKeySchema, agentProfileAgentKeySchema } from "./agent-key.js";
import { promptNodeAssemblySchema, promptNodeAssemblyV3Schema } from "./prompt-assembly.js";
import { runAttemptV1Schema, runAttemptV2Schema } from "./product.js";
import {
  workflowDefinitionRevisionV1Schema,
  workflowDefinitionRevisionV2Schema,
} from "./workflow-definition.js";

const blocking = {
  severity: "blocking" as const,
  code: "tests.required_gate_missing",
  summary: "必要测试缺失",
  detail: "当前候选没有证明必要测试已经通过。",
  evidenceKeys: ["step:abc123"],
};

describe("Governance Review合同", () => {
  it("pass只能没有blocking，fail必须至少有一个blocking", () => {
    expect(
      governanceReviewCandidateSchema.safeParse({
        schemaVersion: "governance-review-candidate.v1",
        outcome: "pass",
        summary: "满足采用门。",
        findings: [],
        residualRisks: [],
      }).success,
    ).toBe(true);
    expect(
      governanceReviewCandidateSchema.safeParse({
        schemaVersion: "governance-review-candidate.v1",
        outcome: "fail",
        summary: "缺少必要证据。",
        findings: [blocking],
        residualRisks: [],
      }).success,
    ).toBe(true);
    expect(
      governanceReviewCandidateSchema.safeParse({
        schemaVersion: "governance-review-candidate.v1",
        outcome: "pass",
        summary: "自相矛盾。",
        findings: [blocking],
        residualRisks: [],
      }).success,
    ).toBe(false);
  });

  it("证据键只接受candidate、step和tool命名空间", () => {
    for (const key of ["candidate:abc123", "step:step-1", "tool:att_1:call_1"]) {
      expect(governanceEvidenceKeySchema.safeParse(key).success).toBe(true);
    }
    for (const key of ["file:/etc/passwd", "http:https://example.com", "step:含正文"]) {
      expect(governanceEvidenceKeySchema.safeParse(key).success).toBe(false);
    }
  });

  it("治理语义只进入新代合同，旧代继续精确只读", () => {
    const now = "2026-08-26T12:00:00.000Z";
    const semanticRoot = {
      kind: "sequence" as const,
      elements: [
        {
          kind: "task" as const,
          definitionNodeId: "planning.governance-check",
          nodeType: "agent.governance_check" as const,
          schemaVersion: 1,
          config: { strictEvidence: true },
        },
      ],
    };
    const revision = {
      workflowDefinitionRevisionId: "wfr_governancev2",
      workflowDefinitionId: "wfd_governancev2",
      definitionRevision: 2,
      state: "published" as const,
      blueprintKey: "planning" as const,
      blueprintVersion: 1,
      title: "治理检查",
      semanticRoot,
      definitionSha256: "a".repeat(64),
      revision: 1 as const,
      createdAt: now,
      updatedAt: now,
      publishedAt: now,
    };
    expect(
      workflowDefinitionRevisionV1Schema.safeParse({
        ...revision,
        schemaVersion: "workflow-definition-revision.v1",
      }).success,
    ).toBe(false);
    expect(
      workflowDefinitionRevisionV2Schema.safeParse({
        ...revision,
        schemaVersion: "workflow-definition-revision.v2",
      }).success,
    ).toBe(true);

    const attempt = {
      attemptId: "att_governancev2",
      productRunId: "run_governancev2",
      kind: "governance_review" as const,
      executionCandidateId: "xcd_governancev2",
      outcome: "running" as const,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    expect(
      runAttemptV1Schema.safeParse({ ...attempt, schemaVersion: "run-attempt.v1" }).success,
    ).toBe(false);
    expect(
      runAttemptV2Schema.safeParse({ ...attempt, schemaVersion: "run-attempt.v2" }).success,
    ).toBe(true);

    const promptNode = {
      definitionNodeId: "planning.governance-check",
      nodeType: "agent.governance_check" as const,
      profileVersion: "governance-review.v1",
      regions: [],
      systemPromptAppend: "检查冻结候选",
      sha256: "b".repeat(64),
    };
    expect(promptNodeAssemblyV3Schema.safeParse(promptNode).success).toBe(false);
    expect(promptNodeAssemblySchema.safeParse(promptNode).success).toBe(true);
    expect(agentKeySchema.safeParse("governance_reviewer").success).toBe(false);
    expect(agentProfileAgentKeySchema.safeParse("governance_reviewer").success).toBe(true);
  });
});
