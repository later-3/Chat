import { DomainInvariantError } from "./plan-state.js";
import { hashCanonical } from "./canonical-hash.js";

interface ValidationRunSpecShape {
  readonly nodeResolutions: readonly {
    readonly activation: "enabled" | "skipped";
    readonly nodeType: string;
    readonly definitionNodeId: string;
    readonly config: Readonly<Record<string, unknown>>;
  }[];
}

interface ExecutionCandidateEvidenceShape {
  readonly sha256: string;
  readonly stepResults: readonly {
    readonly stepId: string;
    readonly sha256: string;
    readonly executionEvidenceRefs?: readonly unknown[] | undefined;
  }[];
}

export type PlanningValidationPolicy =
  | {
      readonly kind: "deterministic";
      readonly definitionNodeId: string;
      readonly strictEvidence: boolean;
    }
  | {
      readonly kind: "governance_review";
      readonly definitionNodeId: string;
      readonly strictEvidence: boolean;
    };

/** Validation策略只由本轮冻结RunSpec决定，Runtime请求不能自行降级或跳过治理节点。 */
export function resolvePlanningValidationPolicy(
  runSpec: ValidationRunSpecShape,
): PlanningValidationPolicy {
  const nodes = runSpec.nodeResolutions.filter(
    (node) =>
      node.activation === "enabled" &&
      (node.nodeType === "result.validate" || node.nodeType === "agent.governance_check"),
  );
  if (nodes.length !== 1) {
    throw new DomainInvariantError(
      "validation_policy_ambiguous",
      "Workflow RunSpec必须且只能启用一个Validation节点",
    );
  }
  const node = nodes[0]!;
  const strictEvidence = node.config["strictEvidence"];
  if (typeof strictEvidence !== "boolean") {
    throw new DomainInvariantError(
      "validation_policy_invalid",
      "Workflow RunSpec的Validation节点缺少strictEvidence",
    );
  }
  return {
    kind: node.nodeType === "agent.governance_check" ? "governance_review" : "deterministic",
    definitionNodeId: node.definitionNodeId,
    strictEvidence,
  };
}

/** Tool证据键绑定完整Evidence Ref，而不是只绑定可能跨Attempt重复的结果正文Hash。 */
export function governanceEvidenceKeys(candidate: ExecutionCandidateEvidenceShape): string[] {
  return [
    `candidate:${candidate.sha256}`,
    ...candidate.stepResults.flatMap((step) => [
      `step:${step.sha256}`,
      ...(step.executionEvidenceRefs ?? []).map(
        (evidence) =>
          `tool:${hashCanonical("governance-evidence-ref.v1", {
            stepId: step.stepId,
            evidence,
          })}`,
      ),
    ]),
  ].filter((value, index, values) => values.indexOf(value) === index);
}

/** 精确覆盖Reviewer真实输入身份；正文由Contract/Candidate/Prompt各自的内容Hash绑定。 */
export function computeGovernanceReviewInputManifestSha256(input: {
  readonly productRunId: string;
  readonly workflowRunSpecId: string;
  readonly workflowRunSpecSha256: string;
  readonly contract: { readonly executionContractId: string; readonly sha256: string };
  readonly candidate: { readonly executionCandidateId: string; readonly sha256: string };
  readonly nodePrompt: {
    readonly promptAssemblyId: string;
    readonly promptAssemblySha256: string;
    readonly definitionNodeId: string;
    readonly nodeAssemblySha256: string;
    readonly profileVersion: string;
  };
  readonly strictEvidence: boolean;
  readonly allowedEvidenceKeys: readonly string[];
  readonly limits: {
    readonly maxTurns: number;
    readonly tokenBudget: number;
    readonly timeoutMs: number;
  };
  readonly modelConfigVersion: string;
}): string {
  return hashCanonical("governance-review-input-manifest.v1", {
    productRunId: input.productRunId,
    workflowRunSpecId: input.workflowRunSpecId,
    workflowRunSpecSha256: input.workflowRunSpecSha256,
    executionContractId: input.contract.executionContractId,
    executionContractSha256: input.contract.sha256,
    executionCandidateId: input.candidate.executionCandidateId,
    executionCandidateSha256: input.candidate.sha256,
    promptAssemblyId: input.nodePrompt.promptAssemblyId,
    promptAssemblySha256: input.nodePrompt.promptAssemblySha256,
    definitionNodeId: input.nodePrompt.definitionNodeId,
    nodeAssemblySha256: input.nodePrompt.nodeAssemblySha256,
    profileVersion: input.nodePrompt.profileVersion,
    strictEvidence: input.strictEvidence,
    allowedEvidenceKeys: input.allowedEvidenceKeys,
    limits: input.limits,
    modelConfigVersion: input.modelConfigVersion,
  });
}
