import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRACE_SCHEMA_VERSION,
  traceEventSchema,
  type TraceEvent,
  type TraceEventInput,
} from "@chat/contracts";

vi.mock("workflow", async (importOriginal) => {
  const original = await importOriginal<typeof import("workflow")>();
  return { ...original, getStepMetadata: () => ({ attempt: 1 }) };
});

import { setWorkflowRuntimeContext } from "./runtime-context.js";
import { reviewExecutionGovernanceStep } from "./workflow-governance-review-steps.js";

const SHA = "a".repeat(64);

function prepared() {
  return {
    schemaVersion: "chat-internal-runtime.v1",
    reviewInput: {
      attemptId: "att_governancereviewer1",
      inputManifestSha256: "f".repeat(64),
      productRunId: "run_governancestep1",
      contract: {
        schemaVersion: "execution-contract.v1",
        executionContractId: "exc_governancestep1",
        productRunId: "run_governancestep1",
        approvedPlanId: "pln_governancestep1",
        approvedPlanRevision: 1,
        approvedPlanSha256: SHA,
        approvalDecisionId: "dec_governancestep1",
        steps: [
          {
            stepId: "implement",
            title: "实现",
            purpose: "交付节点",
            dependsOn: [],
            inputRefs: [],
            expectedOutput: "实现",
            successCriteria: ["测试通过"],
            capabilityRefs: [],
          },
        ],
        completionCriteria: ["测试通过"],
        capabilityRefs: [],
        limits: { maxTurnsPerStep: 1, timeoutMsPerStep: 10_000 },
        sha256: SHA,
        revision: 1,
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
      },
      candidate: {
        schemaVersion: "execution-candidate.v1",
        executionCandidateId: "xcd_governancestep1",
        productRunId: "run_governancestep1",
        executionContractId: "exc_governancestep1",
        stepResults: [
          {
            stepId: "implement",
            executionAttemptId: "att_governancestep1",
            inputManifestSha256: SHA,
            dependencyRefs: [],
            output: "PRIVATE_CANDIDATE_BODY",
            sections: [{ heading: "实现", body: "完成" }],
            successCriteriaEvidence: ["测试通过"],
            criteriaEvidence: ["测试通过"],
            warnings: [],
            sha256: "b".repeat(64),
          },
        ],
        finalOutput: {
          format: "markdown_sections",
          sections: [{ heading: "实现", body: "完成" }],
        },
        completionCriteriaEvidence: ["测试通过"],
        warnings: [],
        sha256: "c".repeat(64),
        revision: 1,
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
      },
      nodePrompt: {
        promptAssemblyId: "pma_governancestep1",
        promptAssemblySha256: "d".repeat(64),
        definitionNodeId: "planning.governance-check",
        nodeAssemblySha256: "e".repeat(64),
        profileVersion: "governance-review.v1",
        systemPromptAppend: "PRIVATE_GOVERNANCE_RULE_BODY",
      },
      strictEvidence: true,
      allowedEvidenceKeys: ["candidate:final_output", "step:implement"],
      limits: { maxTurns: 1, tokenBudget: 4_096, timeoutMs: 90_000 },
    },
  } as never;
}

function install(input: {
  readonly governanceReview?: ReturnType<typeof vi.fn>;
  readonly prepare?: ReturnType<typeof vi.fn>;
  readonly persist?: ReturnType<typeof vi.fn>;
  readonly events?: TraceEvent[];
}) {
  const events = input.events ?? [];
  const prepare = input.prepare ?? vi.fn(async () => prepared());
  const persist =
    input.persist ??
    vi.fn(async () => ({
      schemaVersion: "chat-internal-runtime.v1",
      outcome: "pass" as const,
      validationResultId: "val_governancestep1",
      failures: [],
    }));
  let eventSequence = 0;
  const completeRunAttempt = vi.fn(async () => ({
    schemaVersion: "chat-internal-runtime.v1",
    outcome: "failure" as const,
  }));
  setWorkflowRuntimeContext({
    api: {
      prepareGovernanceReviewInput: prepare,
      persistValidationResult: persist,
      completeRunAttempt,
    } as never,
    bindings: {} as never,
    memoryBackends: { list: () => [], get: () => undefined },
    workflowMemoryProviders: {
      list: () => [],
      getQuery: () => undefined,
      getWrite: () => undefined,
    },
    trace: (event) =>
      events.push(
        traceEventSchema.parse({
          schemaVersion: TRACE_SCHEMA_VERSION,
          eventId: `evt_governancestep${String(++eventSequence)}`,
          timestamp: "2026-08-26T00:00:00.000Z",
          ...(event as TraceEventInput),
        }),
      ),
    now: () => "2026-08-26T00:00:00.000Z",
    bailian: {
      apiKey: "test-key",
      baseUrl: "https://example.invalid/v1",
      endpointHost: "example.invalid",
    },
    planner: vi.fn() as never,
    noteCapture: vi.fn() as never,
    governanceReview: input.governanceReview as never,
    executor: vi.fn() as never,
  });
  return { prepare, persist, completeRunAttempt, events };
}

const passCandidate = {
  schemaVersion: "governance-review-candidate.v1" as const,
  outcome: "pass" as const,
  summary: "通过治理采用门。",
  findings: [],
  residualRisks: [],
};

afterEach(() => setWorkflowRuntimeContext(undefined));

describe("治理检查耐久Step", () => {
  it("在同一Step准备冻结输入、调用一次Reviewer、持久化候选并留下完整Provider证据", async () => {
    const reviewer = vi.fn(async (input: { onProviderRequestStart?: () => void }) => {
      input.onProviderRequestStart?.();
      return {
        kind: "candidate" as const,
        candidate: passCandidate,
        durationMs: 17,
        providerCallCount: 1,
        providerMeta: {
          httpStatus: 200,
          providerRequestId: "provider-governance-1",
          providerStopReason: "toolUse" as const,
          toolCallCount: 1,
        },
        usage: { inputTokens: 30, outputTokens: 12 },
      };
    });
    const events: TraceEvent[] = [];
    const { prepare, persist } = install({ governanceReview: reviewer, events });

    const result = await reviewExecutionGovernanceStep({
      productRunId: "run_governancestep1",
      workflowAttemptId: "att_governanceworkflow1",
      workflowRunSpecId: "wrs_governancestep1",
      executionCandidateId: "xcd_governancestep1",
    });

    expect(result).toEqual({
      outcome: "pass",
      validationResultId: "val_governancestep1",
      failures: [],
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        strictEvidence: true,
        governanceReview: passCandidate,
        executionCandidateId: "xcd_governancestep1",
        governanceReviewAttemptId: "att_governancereviewer1",
        governanceReviewInputManifestSha256: "f".repeat(64),
      }),
    );
    const serialized = JSON.stringify(events);
    expect(serialized).toContain("provider.request.started");
    expect(serialized).toContain("provider.request.completed");
    expect(serialized).toContain("pi.node.completed");
    expect(serialized).toContain("governance_reviewer");
    expect(serialized).not.toContain("PRIVATE_CANDIDATE_BODY");
    expect(serialized).not.toContain("PRIVATE_GOVERNANCE_RULE_BODY");
    expect(
      (
        reviewExecutionGovernanceStep as typeof reviewExecutionGovernanceStep & {
          maxRetries: number;
        }
      ).maxRetries,
    ).toBe(0);
  });

  it("Application返回fail时阻断采用；Reviewer缺少完整Provider证据时失败关闭", async () => {
    const blocking = {
      ...passCandidate,
      outcome: "fail" as const,
      summary: "必要测试缺失。",
      findings: [
        {
          severity: "blocking" as const,
          code: "tests.required_gate_missing",
          summary: "测试证据缺失",
          detail: "候选未证明必要测试。",
          evidenceKeys: ["step:implement"],
        },
      ],
    };
    const reviewer = vi.fn(async (input: { onProviderRequestStart?: () => void }) => {
      input.onProviderRequestStart?.();
      return {
        kind: "candidate" as const,
        candidate: blocking,
        durationMs: 10,
        providerCallCount: 1,
        providerMeta: { httpStatus: 200, providerRequestId: "provider-governance-2" },
        usage: { inputTokens: 20, outputTokens: 8 },
      };
    });
    install({
      governanceReview: reviewer,
      persist: vi.fn(async () => ({
        schemaVersion: "chat-internal-runtime.v1",
        outcome: "fail" as const,
        validationResultId: "val_governancestepfail1",
        failures: [{ code: "tests.required_gate_missing", detail: "测试证据缺失" }],
      })),
    });
    await expect(
      reviewExecutionGovernanceStep({
        productRunId: "run_governancestep1",
        workflowAttemptId: "att_governanceworkflow1",
        workflowRunSpecId: "wrs_governancestep1",
        executionCandidateId: "xcd_governancestep1",
      }),
    ).resolves.toMatchObject({ outcome: "fail" });

    const noEvidence = vi.fn(async (input: { onProviderRequestStart?: () => void }) => {
      input.onProviderRequestStart?.();
      return {
        kind: "candidate" as const,
        candidate: passCandidate,
        durationMs: 2,
        providerCallCount: 1,
        providerMeta: {},
      };
    });
    install({ governanceReview: noEvidence });
    await expect(
      reviewExecutionGovernanceStep({
        productRunId: "run_governancestep1",
        workflowAttemptId: "att_governanceworkflow1",
        workflowRunSpecId: "wrs_governancestep1",
        executionCandidateId: "xcd_governancestep1",
      }),
    ).rejects.toMatchObject({ stableCode: "provider.evidence_missing" });
  });
});
