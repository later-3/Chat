/**
 * 执行候选的确定性验证规则（纯领域规则，任务书§14.3、§9.2）。
 *
 * 模型输出只是候选：Executor说“完成了”不改变任何状态。
 * 本函数是唯一验证实现，Workflow Step与Application提交门共用；
 * 测试Fixture不得复制这些规则。
 */

export interface ValidationContractStep {
  readonly stepId: string;
  readonly dependsOn: readonly string[];
  readonly successCriteria: readonly string[];
  readonly capabilityRefs?: readonly string[];
}

export interface ValidationContract {
  readonly executionContractId: string;
  readonly approvedPlanId: string;
  readonly approvedPlanRevision: number;
  readonly approvedPlanSha256: string;
  readonly steps: readonly ValidationContractStep[];
  readonly completionCriteria: readonly string[];
}

export interface ValidationCandidateStepResult {
  readonly stepId: string;
  readonly executionAttemptId: string;
  readonly successCriteriaEvidence: readonly string[];
  readonly executionEvidenceRefs?:
    | readonly {
        readonly outcome: "completed" | "failed";
        readonly executionAttemptId: string;
        readonly capabilityId: string;
        readonly localName: string;
        readonly toolCallId: string;
        readonly inputSha256: string;
        readonly resultSha256: string;
      }[]
    | undefined;
}

export interface ValidationCandidate {
  readonly executionContractId: string;
  readonly stepResults: readonly ValidationCandidateStepResult[];
  readonly finalOutputSections: readonly { readonly heading: string; readonly body: string }[];
  readonly completionCriteriaEvidence: readonly string[];
  readonly structuredEvidenceRequired?: boolean;
}

export interface ValidationFailure {
  readonly code: string;
  readonly detail: string;
}

function mentions(haystacks: readonly string[], needle: string): boolean {
  const normalizedNeedle = needle.trim();
  if (normalizedNeedle === "") return false;
  return haystacks.some((haystack) => haystack.includes(normalizedNeedle));
}

function requiresStructuredToolEvidence(capabilityRefs: readonly string[] | undefined): boolean {
  return capabilityRefs?.some((capability) => capability !== "markdown_text_compose") ?? false;
}

function evidenceMatchesAllowedCapability(
  evidence: NonNullable<ValidationCandidateStepResult["executionEvidenceRefs"]>[number],
  capabilityRefs: readonly string[] | undefined,
): boolean {
  return (
    capabilityRefs?.some((capability) => {
      if (capability === "workspace_read") {
        return ["read", "grep", "find", "ls"].includes(evidence.localName);
      }
      if (capability === "workspace_write") return ["edit", "write"].includes(evidence.localName);
      if (capability === "shell_execute") return evidence.localName === "bash";
      if (capability === "workspace_write_shell") {
        return ["edit", "write", "bash"].includes(evidence.localName);
      }
      return capability === evidence.localName || capability === evidence.capabilityId;
    }) ?? false
  );
}

export function validateExecutionCandidate(
  contract: ValidationContract,
  candidate: ValidationCandidate,
  options: { readonly strictEvidence: boolean } = { strictEvidence: true },
): ValidationFailure[] {
  const failures: ValidationFailure[] = [];

  if (candidate.executionContractId !== contract.executionContractId) {
    failures.push({
      code: "contract_ref_mismatch",
      detail: "候选引用的Execution Contract与当前合同不一致",
    });
    return failures;
  }

  // Step数量、顺序与依赖必须与Approved Plan一致
  if (candidate.stepResults.length !== contract.steps.length) {
    failures.push({
      code: "step_count_mismatch",
      detail: `候选stepResults数量${String(candidate.stepResults.length)}与Approved Plan步骤数${String(contract.steps.length)}不一致`,
    });
  }
  const seen = new Set<string>();
  const count = Math.min(candidate.stepResults.length, contract.steps.length);
  for (let index = 0; index < count; index += 1) {
    const expected = contract.steps[index];
    const actual = candidate.stepResults[index];
    if (expected === undefined || actual === undefined) continue;
    if (actual.stepId !== expected.stepId) {
      failures.push({
        code: "step_order_mismatch",
        detail: `第${String(index + 1)}步应为${expected.stepId}，候选给出${actual.stepId}`,
      });
    }
    for (const dependency of expected.dependsOn) {
      if (!seen.has(dependency)) {
        failures.push({
          code: "step_dependency_violation",
          detail: `步骤${expected.stepId}依赖${dependency}，但依赖未在其之前完成`,
        });
      }
    }
    seen.add(actual.stepId);
    // strictEvidence=false只放宽“逐条文字覆盖”，不放宽合同、顺序、依赖或输出结构。
    // 这样配置影响真实行为，但不能把验证节点变成无条件通过开关。
    // 结构化Tool证据是不可关闭的授权/事实门；strictEvidence只控制文字逐条匹配。
    if (
      requiresStructuredToolEvidence(expected.capabilityRefs) &&
      !actual.executionEvidenceRefs?.some(
        (evidence) =>
          evidence.outcome === "completed" &&
          evidence.executionAttemptId === actual.executionAttemptId &&
          evidenceMatchesAllowedCapability(evidence, expected.capabilityRefs),
      )
    ) {
      failures.push({
        code: "structured_evidence_missing",
        detail: `步骤${actual.stepId}缺少匹配Attempt与允许Capability的成功Tool Result`,
      });
    }
    if (options.strictEvidence) {
      for (const criterion of expected.successCriteria) {
        if (!mentions(actual.successCriteriaEvidence, criterion)) {
          failures.push({
            code: "step_evidence_missing",
            detail: `步骤${actual.stepId}缺少成功标准证据:${criterion.slice(0, 80)}`,
          });
        }
      }
    }
  }

  // 每条完成条件必须有对应证据
  if (options.strictEvidence) {
    for (const criterion of contract.completionCriteria) {
      if (!mentions(candidate.completionCriteriaEvidence, criterion)) {
        failures.push({
          code: "completion_evidence_missing",
          detail: `完成条件缺少证据:${criterion.slice(0, 80)}`,
        });
      }
    }
  }

  // finalOutput必须是允许的Markdown section结构且非空
  if (candidate.finalOutputSections.length === 0) {
    failures.push({ code: "final_output_invalid", detail: "finalOutput没有任何Markdown section" });
  }
  for (const section of candidate.finalOutputSections) {
    if (section.heading.trim() === "" || section.body.trim() === "") {
      failures.push({
        code: "final_output_invalid",
        detail: "finalOutput存在空heading或空body的section",
      });
      break;
    }
  }

  return failures;
}
