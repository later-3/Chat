import { describe, expect, it } from "vitest";
import {
  supervisedCapabilityManifestV3Schema,
  supervisedStepReviewRequestV3Schema,
  supervisedToolExecutionResultRefV2Schema,
} from "./supervised-planning-v3.js";

const NOW = "2026-08-26T08:00:00.000Z";
const SHA = (character: string) => character.repeat(64);

function capability(localName: string, capabilityId: string, marker: string) {
  return {
    ref: {
      capabilityId,
      descriptorSha256: SHA(marker),
      inputSchemaSha256: SHA("a"),
      resolvedImplementationSha256: SHA("b"),
      scopeRef: { kind: "global" as const },
    },
    localName,
    kind: "executable_tool" as const,
    runtimeOwner: "pi_direct" as const,
    sourceRef: {
      sourceKind: "builtin" as const,
      package: "@earendil-works/pi-coding-agent",
      revision: "1".repeat(40),
      resourcePath: `packages/coding-agent/src/core/tools/${localName}.ts`,
    },
    effect: "read" as const,
    scopePolicy: "global" as const,
    approvalPolicy: "run_policy" as const,
    evidencePolicy: "runtime_journal" as const,
  };
}

const STEP_IDENTITY = {
  productRunId: "run_supervised1",
  planningEpochRef: {
    planningEpochId: "spe_supervised1",
    epochNumber: 1,
    revision: 1,
    sha256: SHA("1"),
  },
  executionContractRef: {
    executionContractId: "exc_supervised1",
    revision: 1,
    sha256: SHA("2"),
  },
  stepId: "draft",
  stepRevision: 1,
} as const;

describe("监督执行v3基础合同", () => {
  it("完整Capability Manifest按ID、qualified Ref与localName三层拒绝碰撞", () => {
    const read = capability("read", "later.pi.builtin.read.v1", "3");
    const base = {
      schemaVersion: "supervised-capability-manifest.v3",
      capabilities: [read],
      sha256: SHA("4"),
    } as const;
    expect(supervisedCapabilityManifestV3Schema.safeParse(base).success).toBe(true);
    expect(
      supervisedCapabilityManifestV3Schema.safeParse({
        ...base,
        capabilities: [read, capability("grep", "later.pi.builtin.read.v1", "5")],
      }).success,
    ).toBe(false);
    expect(
      supervisedCapabilityManifestV3Schema.safeParse({
        ...base,
        capabilities: [read, capability("read", "later.pi.builtin.grep.v1", "5")],
      }).success,
    ).toBe(false);
  });

  it("Product Review使用独立身份域，不能夹带Tool Review身份", () => {
    const review = {
      schemaVersion: "supervised-step-review-request.v3",
      reviewRequestId: "srr_review1",
      decisionBoundary: "product_review",
      reviewKind: "executor_candidate",
      stepIdentity: STEP_IDENTITY,
      candidateRef: {
        candidateId: "scd_candidate1",
        revision: 1,
        sha256: SHA("5"),
      },
      decisionState: { status: "open" },
      sha256: SHA("6"),
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    } as const;
    expect(supervisedStepReviewRequestV3Schema.safeParse(review).success).toBe(true);
    expect(
      supervisedStepReviewRequestV3Schema.safeParse({
        ...review,
        toolExecutionIntentId: "tei_forbidden1",
      }).success,
    ).toBe(false);
  });

  it("未来ToolExecution v2引用必须携带完整Step与Attempt身份，裸Result ID无效", () => {
    const ref = {
      schemaVersion: "tool-execution-result-ref.v2",
      toolExecutionResultId: "ter_result1",
      stepIdentity: STEP_IDENTITY,
      attemptRef: {
        attemptId: "att_supervised1",
        role: "executor",
        agentRound: 1,
        revision: 1,
        inputManifestSha256: SHA("7"),
        sha256: SHA("8"),
      },
      resultSha256: SHA("9"),
    } as const;
    expect(supervisedToolExecutionResultRefV2Schema.safeParse(ref).success).toBe(true);
    const { stepIdentity: _stepIdentity, ...withoutIdentity } = ref;
    void _stepIdentity;
    expect(supervisedToolExecutionResultRefV2Schema.safeParse(withoutIdentity).success).toBe(false);
  });
});
