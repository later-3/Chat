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
  readonly successCriteriaEvidence: readonly string[];
}

export interface ValidationCandidate {
  readonly executionContractId: string;
  readonly stepResults: readonly ValidationCandidateStepResult[];
  readonly finalOutputSections: readonly { readonly heading: string; readonly body: string }[];
  readonly completionCriteriaEvidence: readonly string[];
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

export function validateExecutionCandidate(
  contract: ValidationContract,
  candidate: ValidationCandidate,
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
    seen.add(actual.stepId);
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
    // 每条Step成功标准必须有证据
    for (const criterion of expected.successCriteria) {
      if (!mentions(actual.successCriteriaEvidence, criterion)) {
        failures.push({
          code: "step_evidence_missing",
          detail: `步骤${actual.stepId}缺少成功标准证据:${criterion.slice(0, 80)}`,
        });
      }
    }
  }

  // 每条完成条件必须有对应证据
  for (const criterion of contract.completionCriteria) {
    if (!mentions(candidate.completionCriteriaEvidence, criterion)) {
      failures.push({
        code: "completion_evidence_missing",
        detail: `完成条件缺少证据:${criterion.slice(0, 80)}`,
      });
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
