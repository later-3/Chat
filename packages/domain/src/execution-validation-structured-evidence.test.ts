import { describe, expect, it } from "vitest";
import { validateExecutionCandidate } from "./execution-validation.js";

const contract = {
  executionContractId: "exc_evidence1",
  approvedPlanId: "pln_evidence1",
  approvedPlanRevision: 1,
  approvedPlanSha256: "1".repeat(64),
  steps: [
    {
      stepId: "test",
      dependsOn: [],
      successCriteria: ["测试通过"],
      capabilityRefs: ["shell_execute"],
    },
  ],
  completionCriteria: ["测试通过"],
};

const textualCandidate = {
  executionContractId: "exc_evidence1",
  stepResults: [
    {
      stepId: "test",
      executionAttemptId: "att_evidence1",
      successCriteriaEvidence: ["测试通过｜模型声称测试已通过"],
    },
  ],
  finalOutputSections: [{ heading: "验证", body: "测试已通过" }],
  completionCriteriaEvidence: ["测试通过｜模型声称测试已通过"],
  structuredEvidenceRequired: true,
};

describe("Execution Validation结构化证据", () => {
  it("模型只声称测试通过但没有Tool Result引用时失败", () => {
    expect(
      validateExecutionCandidate(contract, textualCandidate, { strictEvidence: true }),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "structured_evidence_missing" })]),
    );
  });

  it("引用成功Tool Result Hash后通过结构化证据门", () => {
    const candidate = {
      ...textualCandidate,
      stepResults: [
        {
          ...textualCandidate.stepResults[0]!,
          executionEvidenceRefs: [
            {
              outcome: "completed" as const,
              executionAttemptId: "att_evidence1",
              capabilityId: "pi_planning:tool:builtin:bash",
              localName: "bash",
              toolCallId: "call_1",
              inputSha256: "1".repeat(64),
              resultSha256: "2".repeat(64),
            },
          ],
        },
      ],
    };
    expect(validateExecutionCandidate(contract, candidate, { strictEvidence: true })).toEqual([]);
  });

  it("strictEvidence=false仍要求结构化证据，read不能冒充shell_execute", () => {
    const readEvidence = {
      ...textualCandidate,
      stepResults: [
        {
          ...textualCandidate.stepResults[0]!,
          executionEvidenceRefs: [
            {
              outcome: "completed" as const,
              executionAttemptId: "att_evidence1",
              capabilityId: "pi_planning:tool:builtin:read",
              localName: "read",
              toolCallId: "call_read",
              inputSha256: "3".repeat(64),
              resultSha256: "4".repeat(64),
            },
          ],
        },
      ],
    };
    expect(
      validateExecutionCandidate(contract, textualCandidate, { strictEvidence: false }),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "structured_evidence_missing" })]),
    );
    expect(validateExecutionCandidate(contract, readEvidence, { strictEvidence: true })).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "structured_evidence_missing" })]),
    );
  });
});
