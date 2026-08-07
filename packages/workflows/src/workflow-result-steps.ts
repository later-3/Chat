import type { ExecutionContract } from "@chat/contracts";
import { getWorkflowRuntimeContext } from "./runtime-context.js";
import { cmdId, runStep, wrapApiError } from "./workflow-step-support.js";

/* ---------- 候选、验证与提交 ---------- */

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

export async function validateExecutionStep(input: {
  contract: ExecutionContract;
  executionCandidateId: string;
  workflowAttemptId: string;
}): Promise<{
  outcome: "pass" | "fail";
  validationResultId: string;
  failures: { code: string; detail: string }[];
}> {
  "use step";
  const productRunId = input.contract.productRunId;
  return runStep(productRunId, input.workflowAttemptId, "validate_execution", async () => {
    const ctx = getWorkflowRuntimeContext();
    try {
      const result = await ctx.api.persistValidationResult({
        commandId: cmdId(
          "persist-validation-result",
          input.contract.productRunId,
          input.executionCandidateId,
        ) as never,
        productRunId: input.contract.productRunId as never,
        executionContractId: input.contract.executionContractId as never,
        executionCandidateId: input.executionCandidateId as never,
      });
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
