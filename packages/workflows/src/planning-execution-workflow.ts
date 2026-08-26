import { defineHook, sleep } from "workflow";
import { EXECUTOR_PROMPT_TEMPLATE_VERSION, MODEL_CONFIG_VERSION } from "@chat/contracts";
import {
  planDecisionHookPayloadSchema,
  type PlanningExecutionWorkflowInput,
} from "./workflow-input.js";
import {
  beginPlanningContextStep,
  compilePlanningInputStep,
  persistPlanningContextResultStep,
  publishPlanReviewStep,
  queryMemoryContextStep,
  runPiPlannerStep,
} from "./workflow-planning-steps.js";
import {
  claimDecisionHookStep,
  expireApprovalStep,
  loadCommittedDecisionStep,
} from "./workflow-decision-steps.js";
import {
  beginExecutionAttemptStep,
  completeRunAttemptStep,
  compileExecutionContractStep,
  runPiExecutorStep,
  type DurableExecutorStepCandidate,
} from "./workflow-execution-steps.js";
import {
  commitExecutionResultStep,
  commitRejectedRunStep,
  commitRunFailureStep,
  persistExecutionCandidateStep,
  validateExecutionStep,
  type AssembledExecutionCandidate,
} from "./workflow-result-steps.js";
import { PiStepFailure } from "./workflow-error.js";

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
  stepCandidates: readonly DurableExecutorStepCandidate[],
): AssembledExecutionCandidate {
  const sections = stepCandidates.flatMap((candidate) => candidate.sections);
  return {
    stepResults: stepCandidates.map((candidate) => ({
      stepId: candidate.stepId,
      executionAttemptId: candidate.executionAttemptId,
      inputManifestSha256: candidate.inputManifestSha256,
      dependencyRefs: candidate.dependencyRefs,
      output: candidate.output,
      sections: candidate.sections,
      successCriteriaEvidence: candidate.successCriteriaEvidence,
      criteriaEvidence: candidate.criteriaEvidence,
      ...(candidate.executionEvidenceRefs === undefined
        ? {}
        : { executionEvidenceRefs: candidate.executionEvidenceRefs }),
      warnings: candidate.warnings,
      sha256: candidate.sha256,
    })),
    finalOutput: { format: "markdown_sections", sections },
    completionCriteriaEvidence: stepCandidates.flatMap((candidate) => candidate.criteriaEvidence),
    warnings: stepCandidates.flatMap((candidate) => candidate.warnings),
  };
}

function failureSummary(error: unknown): { code: string; summary: string } {
  if (error instanceof PiStepFailure) {
    return { code: error.stableCode, summary: "后台工作失败，请稍后重试或调整目标后重新开始" };
  }
  if (error instanceof Error && STABLE_ERROR_CODE.test(error.message)) {
    return { code: error.message, summary: "后台工作失败，请稍后重试或调整目标后重新开始" };
  }
  return { code: "workflow.step_failed", summary: "后台工作遇到内部错误" };
}

const STABLE_ERROR_CODE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;

export async function planningExecutionWorkflow(
  input: PlanningExecutionWorkflowInput,
): Promise<PlanningExecutionWorkflowResult> {
  "use workflow";

  // productRunId是Chat产品身份；attemptId是Chat的Workflow Attempt证据。
  // 二者都不是Vercel Workflow Run ID，Step只能借它们调用内部Application API。
  const { productRunId, attemptId } = input;
  try {
    // 阶段A：按用户本轮ContextRequest准备一次不可变上下文包；后续Plan修订复用它。
    let preparedContext;
    try {
      // 3个耐久节点都在修订循环外：Plan v2+复用同一不可变包，不再查询Memory。
      const begun = await beginPlanningContextStep({ productRunId, attemptId });
      if (begun.status === "dispatch_required") {
        const result = await queryMemoryContextStep({ attemptId, query: begun.query });
        preparedContext = await persistPlanningContextResultStep({
          productRunId,
          attemptId,
          memoryQueryId: begun.query.memoryQueryId,
          result,
        });
      } else {
        preparedContext = begun;
      }
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
    if (preparedContext.status === "required_failed") {
      const errorCode = "memory_context_required_failed";
      await commitRunFailureStep({
        productRunId,
        attemptId,
        errorCode,
        summary: "必需Memory上下文不可用，后台工作已安全停止",
      });
      return { outcome: "failed", productRunId, errorCode };
    }
    const contextPackageRef =
      preparedContext.status === "ready" || preparedContext.status === "optional_failed"
        ? preparedContext.contextPackageRef
        : undefined;

    // 阶段B：规划—用户决定循环。request_revision只增加Plan版本，不启动第二个Workflow。
    for (let planRevision = 1; planRevision <= input.maxPlanRevisions; planRevision += 1) {
      let planningInput;
      try {
        planningInput = await compilePlanningInputStep({
          productRunId,
          attemptId,
          planRevision,
          ...(contextPackageRef !== undefined ? { contextPackageRef } : {}),
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
          expectedRunRevision: planningInput.inputRunRevision,
          inputManifestSha256: planningInput.inputManifestSha256,
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

      // Plan先由Application提交成under_review事实，再创建耐久Hook等待用户决定。
      // 浏览器提交的是Decision Command；Runtime收到Resume Outbox后才恢复这个Hook。
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

      // Hook先由Workflow World耐久注册，之后才对Runtime暴露绑定；Resume永远看不到未注册Hook。
      await claimDecisionHookStep({
        productRunId,
        attemptId,
        planRevision: review.planRevision,
        approvalRequestId: review.approvalRequestId,
      });

      const waitResult = await Promise.race([
        decisionHook.then((resumeSignal) => ({ kind: "decision" as const, resumeSignal })),
        sleep(new Date(review.approvalExpiresAt)).then(() => ({ kind: "expired" as const })),
      ]);
      let resumeSignal;
      if (waitResult.kind === "expired") {
        const expiry = await expireApprovalStep({
          productRunId,
          attemptId,
          approvalRequestId: review.approvalRequestId,
          expectedExpiresAt: review.approvalExpiresAt,
        });
        if (expiry === "expired") {
          return { outcome: "failed", productRunId, errorCode: "approval.expired" };
        }
        // 决定已先提交但Resume Outbox仍在路上：继续等待同一个耐久Hook。
        resumeSignal = await decisionHook;
      } else {
        resumeSignal = waitResult.resumeSignal;
      }
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

      // 阶段C（approve）：从已批准Plan编译不可变Execution Contract，再按依赖顺序逐步执行。
      // Executor输出仍是候选，只有后续持久化、验证和Product Commit完成才算产品成功。
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

      const stepCandidates: DurableExecutorStepCandidate[] = [];
      let executionFailed: { code: string; summary: string } | undefined;
      for (const planStep of contract.steps) {
        let currentExecutionAttemptId: string | undefined;
        try {
          const dependencyResults = planStep.dependsOn.map((dependencyStepId) => {
            const dependency = stepCandidates.find(
              (candidate) => candidate.stepId === dependencyStepId,
            );
            if (dependency === undefined) {
              throw new PiStepFailure(
                "execution.dependency_missing",
                `执行依赖缺失:${dependencyStepId}`,
              );
            }
            return {
              stepId: dependency.stepId,
              executionAttemptId: dependency.executionAttemptId,
              sha256: dependency.sha256,
              output: dependency.output,
              sections: dependency.sections,
            };
          });
          const begun = await beginExecutionAttemptStep({
            productRunId,
            attemptId,
            executionContractId: contract.executionContractId,
            stepId: planStep.stepId,
            dependencyRefs: dependencyResults.map((dependency) => ({
              stepId: dependency.stepId,
              executionAttemptId: dependency.executionAttemptId,
              sha256: dependency.sha256,
            })),
            promptTemplateVersion: EXECUTOR_PROMPT_TEMPLATE_VERSION,
            modelConfigVersion: MODEL_CONFIG_VERSION,
          });
          currentExecutionAttemptId = begun.attemptId;
          const candidate = await runPiExecutorStep({
            contract,
            stepId: planStep.stepId,
            executionAttemptId: begun.attemptId,
            inputManifestSha256: begun.inputManifestSha256,
            contextItems: begun.contextItems,
            ...(begun.promptAssemblyRef === undefined
              ? {}
              : { promptAssemblyRef: begun.promptAssemblyRef }),
            dependencyResults,
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
          if (currentExecutionAttemptId !== undefined) {
            await completeRunAttemptStep({
              productRunId,
              attemptId,
              targetAttemptId: currentExecutionAttemptId,
              outcome: "failure",
              errorCode: failure.code,
            });
          }
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
      let postExecutionFailure: { code: string; summary: string } | undefined;
      try {
        const persisted = await persistExecutionCandidateStep({
          productRunId,
          attemptId,
          executionContractId: contract.executionContractId,
          candidate: assembled,
        });

        const validation = await validateExecutionStep({
          contract,
          executionCandidateId: persisted.executionCandidateId,
          workflowAttemptId: attemptId,
        });
        if (validation.outcome === "fail") {
          postExecutionFailure = {
            code: "execution.validation_failed",
            summary: "执行结果未通过服务端验证，未提交为正式结果",
          };
        } else {
          await commitExecutionResultStep({
            productRunId,
            attemptId,
            executionContractId: contract.executionContractId,
            executionCandidateId: persisted.executionCandidateId,
            validationResultId: validation.validationResultId,
            planSha256: contract.approvedPlanSha256,
          });
          return { outcome: "product_committed", productRunId };
        }
      } catch (error) {
        postExecutionFailure = failureSummary(error);
      }

      // Executor结果已由Workflow Step耐久保存；这里只提交失败终态，绝不重新调用模型。
      await commitRunFailureStep({
        productRunId,
        attemptId,
        errorCode: postExecutionFailure.code,
        summary: postExecutionFailure.summary,
      });
      return { outcome: "failed", productRunId, errorCode: postExecutionFailure.code };
    }

    // 达到规划修订上限：第6次不再调用模型，进入明确失败
    await commitRunFailureStep({
      productRunId,
      attemptId,
      errorCode: "plan_revision_limit_reached",
      summary: "规划修订已达上限，请调整目标后重新开始",
    });
    return { outcome: "failed", productRunId, errorCode: "plan_revision_limit_reached" };
  } catch (error) {
    const failure = failureSummary(error);
    // 收敛失败必须让Workflow本身失败，不能正常返回后留下仍活跃的产品事实。
    // commitRunFailure是幂等命令；Runtime重放会再次尝试同一收敛步骤。
    await commitRunFailureStep({
      productRunId,
      attemptId,
      errorCode: failure.code,
      summary: failure.summary,
    });
    return { outcome: "failed", productRunId, errorCode: failure.code };
  }
}
