import { getWorkflowRuntimeContext } from "./runtime-context.js";
import { cmdId, runStep, wrapApiError } from "./workflow-step-support.js";

/* ---------- 候选、验证与提交 ---------- */

/**
 * 调试导航：这三个Step把“Agent说完成”逐级收敛为“Chat产品事实”。
 *
 * AssembledExecutionCandidate保存每个Plan Step的Attempt、输入Manifest、依赖、输出和Hash；
 * 它仍是候选。persist只取得耐久候选引用，validate用确定性规则产生Validation事实，最后
 * commit才原子写入正式Assistant Message与Run终态。拆成三步后，Product Commit失败可以用
 * 同一候选和稳定commandId重试，而不重新调用付费Executor。
 */

export interface AssembledExecutionCandidate {
  readonly stepResults: readonly {
    stepId: string;
    executionAttemptId: string;
    inputManifestSha256: string;
    dependencyRefs: { stepId: string; executionAttemptId: string; sha256: string }[];
    output: string;
    sections: { heading: string; body: string }[];
    successCriteriaEvidence: string[];
    criteriaEvidence: string[];
    executionEvidenceRefs?: import("@chat/contracts").ExecutionEvidenceRef[];
    warnings: string[];
    sha256: string;
  }[];
  readonly finalOutput: {
    format: "markdown_sections";
    sections: { heading: string; body: string }[];
  };
  readonly completionCriteriaEvidence: string[];
  readonly warnings: string[];
}

export async function persistExecutionCandidateStep(input: {
  productRunId: string;
  attemptId: string;
  executionContractId: string;
  candidate: AssembledExecutionCandidate;
}): Promise<{ executionCandidateId: string; sha256: string }> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "persist_execution_candidate", async () => {
    const ctx = getWorkflowRuntimeContext();
    try {
      return await ctx.api.persistExecutionCandidate({
        commandId: cmdId(
          "persist-execution-candidate",
          input.productRunId,
          input.executionContractId,
        ) as never,
        productRunId: input.productRunId as never,
        executionContractId: input.executionContractId as never,
        evidencePolicyVersion: "structured-tool-result.v1",
        stepResults: input.candidate.stepResults as never,
        finalOutput: input.candidate.finalOutput,
        completionCriteriaEvidence: input.candidate.completionCriteriaEvidence,
        warnings: input.candidate.warnings,
      });
    } catch (error) {
      wrapApiError(error);
    }
  });
}

export async function validateExecutionStep(
  input:
    | {
        productRunId: string;
        executionContractId: string;
        executionCandidateId: string;
        workflowAttemptId: string;
        strictEvidence: boolean;
      }
    | {
        /** Legacy Runner兼容输入；新Runner禁止把完整Contract跨checkpoint传入。 */
        contract: import("@chat/contracts").ExecutionContract;
        executionCandidateId: string;
        workflowAttemptId: string;
      },
): Promise<{
  outcome: "pass" | "fail";
  validationResultId: string;
  failures: { code: string; detail: string }[];
}> {
  "use step";
  const productRunId = "contract" in input ? input.contract.productRunId : input.productRunId;
  const executionContractId =
    "contract" in input ? input.contract.executionContractId : input.executionContractId;
  const strictEvidence = "strictEvidence" in input ? input.strictEvidence : true;
  return runStep(productRunId, input.workflowAttemptId, "validate_execution", async () => {
    const ctx = getWorkflowRuntimeContext();
    try {
      const result = await ctx.api.persistValidationResult({
        commandId: cmdId(
          "persist-validation-result",
          productRunId,
          input.executionCandidateId,
        ) as never,
        productRunId: productRunId as never,
        executionContractId: executionContractId as never,
        executionCandidateId: input.executionCandidateId as never,
        strictEvidence,
      } as never);
      return {
        outcome: result.outcome,
        validationResultId: result.validationResultId,
        failures: result.failures,
      };
    } catch (error) {
      wrapApiError(error);
    }
  });
}

export async function commitExecutionResultStep(input: {
  productRunId: string;
  attemptId: string;
  executionContractId: string;
  executionCandidateId: string;
  validationResultId: string;
  planSha256: string;
}): Promise<{ finalMessageId: string }> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "product_commit", async () => {
    const ctx = getWorkflowRuntimeContext();
    try {
      const result = await ctx.api.commitExecutionResult({
        commandId: cmdId("commit-execution-result", input.productRunId, input.planSha256) as never,
        productRunId: input.productRunId as never,
        executionContractId: input.executionContractId as never,
        executionCandidateId: input.executionCandidateId as never,
        validationResultId: input.validationResultId as never,
      });
      return { finalMessageId: result.finalMessageId };
    } catch (error) {
      wrapApiError(error);
    }
  });
}

export async function commitRejectedRunStep(input: {
  productRunId: string;
  attemptId: string;
  decisionId: string;
}): Promise<void> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "commit_rejected_run", async () => {
    const ctx = getWorkflowRuntimeContext();
    try {
      await ctx.api.commitRejectedRun({
        commandId: cmdId("commit-rejected-run", input.productRunId, input.decisionId) as never,
        productRunId: input.productRunId as never,
        decisionId: input.decisionId as never,
      });
    } catch (error) {
      wrapApiError(error);
    }
  });
}

export async function commitRunFailureStep(input: {
  productRunId: string;
  attemptId: string;
  errorCode: string;
  summary: string;
}): Promise<void> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "commit_run_failure", async () => {
    const ctx = getWorkflowRuntimeContext();
    try {
      await ctx.api.commitRunFailure({
        commandId: cmdId("commit-run-failure", input.productRunId, input.errorCode) as never,
        productRunId: input.productRunId as never,
        errorCode: input.errorCode,
        summary: input.summary,
      });
    } catch (error) {
      wrapApiError(error);
    }
  });
}

/**
 * 外部副作用越过请求边界后失去响应时，必须提交独立unknown终态；不能降级为普通
 * failed后让调度器自动重试。commandId按Run+error稳定，Workflow重放不会重复处置。
 */
export async function commitRunOutcomeUnknownStep(input: {
  productRunId: string;
  attemptId: string;
  errorCode: string;
  summary: string;
}): Promise<void> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "commit_run_outcome_unknown", async () => {
    const ctx = getWorkflowRuntimeContext();
    try {
      await ctx.api.commitRunOutcomeUnknown({
        commandId: cmdId(
          "commit-run-outcome-unknown",
          input.productRunId,
          input.errorCode,
        ) as never,
        productRunId: input.productRunId,
        errorCode: input.errorCode,
        summary: input.summary,
      });
    } catch (error) {
      wrapApiError(error);
    }
  });
}
