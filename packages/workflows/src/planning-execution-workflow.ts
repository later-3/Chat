import { defineHook } from "workflow";
import {
  planDecisionHookPayloadSchema,
  type PlanningExecutionWorkflowInput,
} from "./workflow-input.js";
import {
  commitExecutionResultStep,
  commitRejectedRunStep,
  commitRunFailureStep,
  compileExecutionContractStep,
  compilePlanningInputStep,
  beginExecutionAttemptStep,
  completeRunAttemptStep,
  claimDecisionHookStep,
  loadCommittedDecisionStep,
  persistExecutionCandidateStep,
  publishPlanReviewStep,
  runPiExecutorStep,
  runPiPlannerStep,
  validateExecutionStep,
  PiStepFailure,
  type AssembledExecutionCandidate,
} from "./workflow-steps.js";
import type { ExecutorStepCandidate } from "@chat/pi-runtime";

/**
 * PlanningExecutionWorkflow.v1（唯一Workflow，任务书§13）。
 *
 * 不变量：
 * - 每个Product Run只启动一个Workflow Run；修改/批准/拒绝都恢复同一Run。
 * - 模型Step（pi.plan/pi.execute）maxRetries=0，不自动重试付费调用。
 * - Workflow返回值只用于诊断；Product Store终态才是产品成功。
 * - Product Commit失败后只重试提交已验证候选，不重新调用Executor。
 * - 达到5个Plan revision后不再调用模型，Run进入明确失败。
 */

const planDecisionHook = defineHook({ schema: planDecisionHookPayloadSchema });

export interface PlanningExecutionWorkflowResult {
  readonly outcome: "product_committed" | "cancelled" | "failed";
  readonly productRunId: string;
  readonly errorCode?: string;
}

/** 确定性组装：不新增模型调用，finalOutput由有序step sections拼成。 */
function assembleCandidate(
  stepCandidates: readonly ExecutorStepCandidate[],
): AssembledExecutionCandidate {
  const sections = stepCandidates.flatMap((candidate) => candidate.sections);
  return {
    stepResults: stepCandidates.map((candidate) => ({
      stepId: candidate.stepId,
      output: candidate.output,
      successCriteriaEvidence: candidate.successCriteriaEvidence,
    })),
    finalOutput: { format: "markdown_sections", sections },
    completionCriteriaEvidence: stepCandidates.flatMap((candidate) => candidate.criteriaEvidence),
    warnings: stepCandidates.flatMap((candidate) => candidate.warnings),
  };
}

/** 服务端确定性渲染Markdown（模型只提供section数据）。 */
function renderMarkdown(sections: readonly { heading: string; body: string }[]): string {
  return sections.map((section) => `## ${section.heading}\n\n${section.body}`).join("\n\n");
}

function failureSummary(error: unknown): { code: string; summary: string } {
  if (error instanceof PiStepFailure) {
    return { code: error.stableCode, summary: "后台工作失败，请稍后重试或调整目标后重新开始" };
  }
  return { code: "workflow.step_failed", summary: "后台工作遇到内部错误" };
}

export async function planningExecutionWorkflow(
  input: PlanningExecutionWorkflowInput,
): Promise<PlanningExecutionWorkflowResult> {
  "use workflow";

  const { productRunId, attemptId } = input;

  for (let planRevision = 1; planRevision <= input.maxPlanRevisions; planRevision += 1) {
    let planningInput;
    try {
      planningInput = await compilePlanningInputStep({ productRunId, attemptId, planRevision });
    } catch (error) {
      const failure = failureSummary(error);
      await commitRunFailureStep({
        productRunId,
        attemptId,
        errorCode: failure.code,
        summary: failure.summary,
      });
      return { outcome: "failed", productRunId, errorCode: failure.code };
    }

    let planCandidate;
    try {
      planCandidate = await runPiPlannerStep(planningInput);
    } catch (error) {
      const failure = failureSummary(error);
      await commitRunFailureStep({
        productRunId,
        attemptId,
        errorCode: failure.code,
        summary: failure.summary,
      });
      return { outcome: "failed", productRunId, errorCode: failure.code };
    }

    let review;
    try {
      review = await publishPlanReviewStep({
        productRunId,
        attemptId,
        planningAttemptId: planningInput.attemptId,
        content: planCandidate,
      });
    } catch (error) {
      const failure = failureSummary(error);
      await commitRunFailureStep({
        productRunId,
        attemptId,
        errorCode: failure.code,
        summary: failure.summary,
      });
      return { outcome: "failed", productRunId, errorCode: failure.code };
    }

    await claimDecisionHookStep({
      productRunId,
      attemptId,
      planRevision: review.planRevision,
      approvalRequestId: review.approvalRequestId,
    });

    using decisionHook = planDecisionHook.create({
      token: `pdh-${productRunId}-${String(review.planRevision)}`,
    });
    const conflict = await decisionHook.getConflict();
    if (conflict !== null) {
      await commitRunFailureStep({
        productRunId,
        attemptId,
        errorCode: "workflow.hook_conflict",
        summary: "后台工作状态冲突，已安全停止",
      });
      return { outcome: "failed", productRunId, errorCode: "workflow.hook_conflict" };
    }

    const resumeSignal = await decisionHook;
    let decision;
    try {
      decision = await loadCommittedDecisionStep({
        productRunId,
        attemptId,
        decisionId: resumeSignal.decisionId,
        expectedPlanId: review.planId,
        expectedPlanRevision: review.planRevision,
        expectedPlanSha256: review.planSha256,
      });
    } catch (error) {
      const failure = failureSummary(error);
      await commitRunFailureStep({
        productRunId,
        attemptId,
        errorCode: failure.code,
        summary: failure.summary,
      });
      return { outcome: "failed", productRunId, errorCode: failure.code };
    }

    if (decision.kind === "request_revision") {
      continue;
    }

    if (decision.kind === "reject") {
      await commitRejectedRunStep({ productRunId, attemptId, decisionId: decision.decisionId });
      return { outcome: "cancelled", productRunId };
    }

    // approve：生成不可变Execution Contract并逐步执行
    let contract;
    try {
      contract = await compileExecutionContractStep({
        productRunId,
        attemptId,
        approvalDecisionId: decision.decisionId,
      });
    } catch (error) {
      const failure = failureSummary(error);
      await commitRunFailureStep({
        productRunId,
        attemptId,
        errorCode: failure.code,
        summary: failure.summary,
      });
      return { outcome: "failed", productRunId, errorCode: failure.code };
    }

    const stepCandidates: ExecutorStepCandidate[] = [];
    let lastExecutionAttemptId = "";
    let executionFailed: { code: string; summary: string } | undefined;
    for (const planStep of contract.steps) {
      const begun = await beginExecutionAttemptStep({
        productRunId,
        attemptId,
        stepId: planStep.stepId,
      });
      lastExecutionAttemptId = begun.attemptId;
      try {
        const candidate = await runPiExecutorStep({
          contract,
          stepId: planStep.stepId,
          workflowAttemptId: attemptId,
        });
        await completeRunAttemptStep({
          productRunId,
          attemptId,
          targetAttemptId: begun.attemptId,
          outcome: "success",
        });
        stepCandidates.push(candidate);
      } catch (error) {
        const failure = failureSummary(error);
        await completeRunAttemptStep({
          productRunId,
          attemptId,
          targetAttemptId: begun.attemptId,
          outcome: "failure",
          errorCode: failure.code,
        });
        executionFailed = failure;
        break;
      }
    }
    if (executionFailed !== undefined) {
      await commitRunFailureStep({
        productRunId,
        attemptId,
        errorCode: executionFailed.code,
        summary: executionFailed.summary,
      });
      return { outcome: "failed", productRunId, errorCode: executionFailed.code };
    }

    const assembled = assembleCandidate(stepCandidates);
    const persisted = await persistExecutionCandidateStep({
      productRunId,
      attemptId,
      executionContractId: contract.executionContractId,
      candidateAttemptId: lastExecutionAttemptId,
      candidate: assembled,
    });

    const validation = await validateExecutionStep({
      contract,
      executionCandidateId: persisted.executionCandidateId,
      candidate: assembled,
      workflowAttemptId: attemptId,
    });
    if (validation.outcome === "fail") {
      await commitRunFailureStep({
        productRunId,
        attemptId,
        errorCode: "execution.validation_failed",
        summary: "执行结果未通过服务端验证，未提交为正式结果",
      });
      return { outcome: "failed", productRunId, errorCode: "execution.validation_failed" };
    }

    const renderedMarkdown = renderMarkdown(assembled.finalOutput.sections);
    await commitExecutionResultStep({
      productRunId,
      attemptId,
      executionContractId: contract.executionContractId,
      executionCandidateId: persisted.executionCandidateId,
      validationResultId: validation.validationResultId,
      renderedMarkdown,
      planSha256: contract.approvedPlanSha256,
    });
    return { outcome: "product_committed", productRunId };
  }

  // 达到规划修订上限：第6次不再调用模型，进入明确失败
  await commitRunFailureStep({
    productRunId,
    attemptId,
    errorCode: "plan_revision_limit_reached",
    summary: "规划修订已达上限，请调整目标后重新开始",
  });
  return { outcome: "failed", productRunId, errorCode: "plan_revision_limit_reached" };
}
