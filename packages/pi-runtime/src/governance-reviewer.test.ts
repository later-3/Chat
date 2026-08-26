import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { GovernanceReviewInputDto } from "@chat/contracts";
import { buildGovernanceReviewUserPrompt, runPiGovernanceReview } from "./governance-reviewer.js";

const SHA = "a".repeat(64);
const config = {
  apiKey: "test-key",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  endpointHost: "dashscope.aliyuncs.com",
};

const reviewInput: GovernanceReviewInputDto = {
  attemptId: "att_governancereviewer1" as never,
  inputManifestSha256: SHA,
  productRunId: "run_governancereview1" as never,
  contract: {
    schemaVersion: "execution-contract.v1",
    executionContractId: "exc_governancereview1" as never,
    productRunId: "run_governancereview1" as never,
    approvedPlanId: "pln_governancereview1" as never,
    approvedPlanRevision: 1,
    approvedPlanSha256: SHA,
    approvalDecisionId: "dec_governancereview1" as never,
    steps: [
      {
        stepId: "implement",
        title: "实现治理检查",
        purpose: "交付独立检查节点",
        dependsOn: [],
        inputRefs: [],
        expectedOutput: "可验证实现",
        successCriteria: ["相关测试通过"],
        capabilityRefs: ["pi_planning:tool:builtin:read"],
      },
    ],
    completionCriteria: ["相关测试通过"],
    capabilityRefs: ["pi_planning:tool:builtin:read"],
    limits: { maxTurnsPerStep: 1, timeoutMsPerStep: 10_000, tokenBudgetPerStep: 4_096 },
    sha256: SHA,
    revision: 1,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  },
  candidate: {
    schemaVersion: "execution-candidate.v1",
    executionCandidateId: "xcd_governancereview1" as never,
    productRunId: "run_governancereview1" as never,
    executionContractId: "exc_governancereview1" as never,
    evidencePolicyVersion: "structured-tool-result.v1",
    stepResults: [
      {
        stepId: "implement",
        executionAttemptId: "att_governancereview1" as never,
        inputManifestSha256: SHA,
        dependencyRefs: [],
        output: "已实现独立治理检查节点并运行相关测试。",
        sections: [{ heading: "实现", body: "治理检查节点与测试。" }],
        successCriteriaEvidence: ["相关测试通过：step:implement"],
        criteriaEvidence: ["相关测试通过：step:implement"],
        executionEvidenceRefs: [
          {
            kind: "pi_tool_result",
            executionAttemptId: "att_governancereview1" as never,
            capabilityId: "pi_planning:tool:builtin:read",
            localName: "read",
            toolCallId: "call_governance_read",
            inputSha256: SHA,
            resultSha256: "b".repeat(64),
            outcome: "completed",
          },
        ],
        warnings: [],
        sha256: "c".repeat(64),
      },
    ],
    finalOutput: {
      format: "markdown_sections",
      sections: [{ heading: "实现", body: "治理检查节点与测试。" }],
    },
    completionCriteriaEvidence: ["相关测试通过：step:implement"],
    warnings: [],
    sha256: "d".repeat(64),
    revision: 1,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  },
  nodePrompt: {
    promptAssemblyId: "pma_governancereview1" as never,
    promptAssemblySha256: "e".repeat(64),
    definitionNodeId: "planning.governance-check",
    nodeAssemblySha256: "f".repeat(64),
    profileVersion: "governance-review.v1",
    systemPromptAppend: "GOVERNANCE_RULE_CANARY：架构边界变化必须有合同测试。",
  },
  strictEvidence: true,
  allowedEvidenceKeys: [
    "candidate:final_output",
    "step:implement",
    "tool:att_governancereview1:call_governance_read",
  ],
  limits: { maxTurns: 1, tokenBudget: 4_096, timeoutMs: 10_000 },
};

function fauxStreamFn(
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
  inspect?: (context: unknown) => void,
): StreamFn {
  const provider = fauxProvider({ provider: "bailian" });
  provider.setResponses(responses);
  return (model, context, options) => {
    inspect?.(context);
    return provider.provider.streamSimple(model, context, options);
  };
}

describe("runPiGovernanceReview", () => {
  it("把选中规范与冻结候选交给真实pi工具循环，并只产生一次结构化pass候选", async () => {
    let providerCalls = 0;
    let providerContext = "";
    const candidate = {
      schemaVersion: "governance-review-candidate.v1" as const,
      outcome: "pass" as const,
      summary: "候选满足当前工程治理采用门。",
      findings: [
        {
          severity: "advisory" as const,
          code: "tests.more_edge_cases",
          summary: "可继续补充边界测试",
          detail: "当前证据足以采用，后续可增加更多异常路径。",
          evidenceKeys: ["step:implement"],
        },
      ],
      residualRisks: ["未运行真实付费Provider门；本任务不要求。"],
    };
    const result = await runPiGovernanceReview({
      config,
      reviewInput,
      onProviderRequestStart: () => {
        providerCalls += 1;
      },
      streamFnOverride: fauxStreamFn(
        [fauxAssistantMessage([fauxToolCall("submit_governance_review", candidate)])],
        (context) => {
          providerContext = JSON.stringify(context);
        },
      ),
    });

    expect(result.kind).toBe("candidate");
    if (result.kind === "candidate") expect(result.candidate).toEqual(candidate);
    expect(result.providerCallCount).toBe(1);
    expect(providerCalls).toBe(1);
    expect(providerContext).toContain("GOVERNANCE_RULE_CANARY");
    expect(providerContext).toContain("allowedEvidenceKeys");
    expect(providerContext).toContain("submit_governance_review");
  });

  it("接受有blocking证据的fail，并拒绝未知证据、普通文本和outcome矛盾", async () => {
    const blocking = {
      schemaVersion: "governance-review-candidate.v1" as const,
      outcome: "fail" as const,
      summary: "缺少当前完成门证据。",
      findings: [
        {
          severity: "blocking" as const,
          code: "tests.required_gate_missing",
          summary: "必要测试未证明",
          detail: "候选没有证明合同测试已经通过。",
          evidenceKeys: ["step:implement"],
        },
      ],
      residualRisks: [],
    };
    const failed = await runPiGovernanceReview({
      config,
      reviewInput,
      streamFnOverride: fauxStreamFn([
        fauxAssistantMessage([fauxToolCall("submit_governance_review", blocking)]),
      ]),
    });
    expect(failed).toMatchObject({ kind: "candidate", candidate: { outcome: "fail" } });

    const unknownEvidence = await runPiGovernanceReview({
      config,
      reviewInput,
      streamFnOverride: fauxStreamFn([
        fauxAssistantMessage([
          fauxToolCall("submit_governance_review", {
            ...blocking,
            findings: [{ ...blocking.findings[0], evidenceKeys: ["step:invented"] }],
          }),
        ]),
      ]),
    });
    expect(unknownEvidence).toMatchObject({
      kind: "invalid_candidate",
      errorCode: "capability_violation",
    });

    const ordinaryText = await runPiGovernanceReview({
      config,
      reviewInput,
      streamFnOverride: fauxStreamFn([fauxAssistantMessage([fauxText("检查通过")])]),
    });
    expect(ordinaryText).toMatchObject({ kind: "invalid_candidate", errorCode: "no_tool_call" });

    const contradictory = await runPiGovernanceReview({
      config,
      reviewInput,
      streamFnOverride: fauxStreamFn([
        fauxAssistantMessage([
          fauxToolCall("submit_governance_review", { ...blocking, outcome: "pass" }),
        ]),
      ]),
    });
    expect(contradictory).toMatchObject({
      kind: "invalid_candidate",
      errorCode: "schema_invalid",
    });
  });

  it("用户Prompt明确只允许冻结证据，费用边界和凭据在Provider前失败关闭", async () => {
    const prompt = buildGovernanceReviewUserPrompt(reviewInput);
    expect(prompt).toContain("严格证据策略：开启");
    expect(prompt).toContain("candidate:final_output");
    expect(prompt).toContain("Execution Contract");
    expect(prompt).toContain("Execution Candidate");

    await expect(
      runPiGovernanceReview({
        config: { ...config, apiKey: undefined },
        reviewInput,
      }),
    ).rejects.toMatchObject({ code: "provider.pre_request.no_api_key" });
    await expect(
      runPiGovernanceReview({
        config,
        reviewInput: { ...reviewInput, limits: { ...reviewInput.limits, maxTurns: 2 as never } },
      }),
    ).rejects.toThrow("Governance Review费用边界");
  });
});
