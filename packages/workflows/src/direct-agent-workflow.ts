import { defineHook } from "workflow";
import { DIRECT_AGENT_MAX_PROVIDER_REQUESTS } from "@chat/contracts";
import type { PiDirectExecutorClientOutcome } from "@chat/pi-runtime";
import {
  promptReviewDecisionHookPayloadSchema,
  promptReviewHookToken,
  type DirectAgentWorkflowInput,
  type PromptReviewDecisionHookPayload,
} from "./direct-agent-workflow-input.js";
import {
  claimPromptReviewHookStep,
  commitDirectAgentResultStep,
  loadPromptReviewDecisionStep,
  prepareDirectAgentOperationStep,
  recordDirectAgentNodeStep,
  startDirectAgentOperationStep,
  submitPromptReviewDecisionStep,
} from "./direct-agent-workflow-steps.js";
import { commitRunFailureStep, commitRunOutcomeUnknownStep } from "./workflow-result-steps.js";

const promptReviewDecisionHook = defineHook({ schema: promptReviewDecisionHookPayloadSchema });
const STABLE_ERROR_CODE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/u;
type WaitingPromptReviewOutcome = Extract<
  PiDirectExecutorClientOutcome,
  { readonly kind: "waiting_prompt_review" }
>;

export interface DirectAgentWorkflowResult {
  readonly outcome: "product_committed" | "cancelled" | "failed" | "outcome_unknown";
  readonly productRunId: string;
  readonly errorCode?: string;
}

export interface DirectAgentCandidateReady {
  readonly outcome: "candidate_ready";
  readonly productRunId: string;
  readonly directAgentAttemptId: string;
  readonly directAgentCandidateId: string;
  readonly candidateSha256: string;
}

export type DirectAgentWorkflowCoreResult = DirectAgentWorkflowResult | DirectAgentCandidateReady;

function failureCode(error: unknown, fallback: string): string {
  return error instanceof Error && STABLE_ERROR_CODE.test(error.message) ? error.message : fallback;
}

function hookMatchesReview(
  signal: PromptReviewDecisionHookPayload,
  input: DirectAgentWorkflowInput,
  outcome: WaitingPromptReviewOutcome,
): boolean {
  return (
    signal.productRunId === input.productRunId &&
    signal.promptReviewRequestId === outcome.review.promptReviewRequestId &&
    signal.requestRevision === outcome.review.requestRevision &&
    signal.reviewSha256 === outcome.review.reviewSha256 &&
    signal.payloadSha256 === outcome.review.payloadSha256
  );
}

function isWaitingPromptReview(
  outcome: PiDirectExecutorClientOutcome,
): outcome is WaitingPromptReviewOutcome {
  return outcome.kind === "waiting_prompt_review";
}

async function commitFailure(
  input: DirectAgentWorkflowInput,
  errorCode: string,
): Promise<DirectAgentWorkflowResult> {
  await commitRunFailureStep({
    productRunId: input.productRunId,
    attemptId: input.workflowAttemptId,
    errorCode,
    summary: "直接Agent未完成，已安全停止",
  });
  return { outcome: "failed", productRunId: input.productRunId, errorCode };
}

async function commitOutcomeUnknown(
  input: DirectAgentWorkflowInput,
  errorCode: string,
): Promise<DirectAgentWorkflowResult> {
  await commitRunOutcomeUnknownStep({
    productRunId: input.productRunId,
    attemptId: input.workflowAttemptId,
    errorCode,
    summary: "直接Agent跨越Provider边界后的结果未知，已停止自动继续",
  });
  return { outcome: "outcome_unknown", productRunId: input.productRunId, errorCode };
}

/**
 * Reject Decision已经原子取消Product Run与Direct Attempt；这里复用结算Step只关闭仍在
 * running的Workflow Attempt。Application对已取消Run保持原终态，不把拒绝改写成失败。
 */
async function settleRejected(
  input: DirectAgentWorkflowInput,
  cleanupErrorCode?: string,
): Promise<DirectAgentWorkflowResult> {
  let errorCode = cleanupErrorCode;
  try {
    await commitRunFailureStep({
      productRunId: input.productRunId,
      attemptId: input.workflowAttemptId,
      errorCode: "direct_agent.prompt_rejected",
      summary: "用户已拒绝本次提示词，直接Agent已取消",
    });
  } catch {
    errorCode ??= "direct_agent.reject_settlement_unknown";
  }
  return {
    outcome: "cancelled",
    productRunId: input.productRunId,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

export async function directAgentWorkflow(
  input: DirectAgentWorkflowInput,
): Promise<DirectAgentWorkflowResult> {
  "use workflow";

  const result = await runDirectAgentWorkflowCore(input);
  if (result.outcome !== "candidate_ready") return result;
  return commitDirectAgentCandidate(input, result);
}

/**
 * Direct Agent核心循环：一个Direct Attempt、一个Pi Operation。它只生成已持久化候选，
 * 由外层Workflow决定是否先执行附加产品节点，再调用唯一Product Commit。
 */
export async function runDirectAgentWorkflowCore(
  input: DirectAgentWorkflowInput,
): Promise<DirectAgentWorkflowCoreResult> {
  let prepared;
  try {
    prepared = await prepareDirectAgentOperationStep({
      productRunId: input.productRunId,
      workflowAttemptId: input.workflowAttemptId,
      workflowRunSpecId: input.workflowRunSpecId,
    });
  } catch (error) {
    return commitFailure(input, failureCode(error, "direct_agent.prepare_failed"));
  }

  let current: PiDirectExecutorClientOutcome;
  try {
    await recordDirectAgentNodeStep({
      productRunId: input.productRunId,
      workflowAttemptId: input.workflowAttemptId,
      workflowRunSpecId: input.workflowRunSpecId,
      iteration: 1,
      toStatus: "running",
      publicSummary: "正在推进直接Agent，等待下一处Provider边界",
    });
  } catch (error) {
    return commitFailure(input, failureCode(error, "direct_agent.node_projection_failed"));
  }
  try {
    current = await startDirectAgentOperationStep({
      productRunId: input.productRunId,
      workflowAttemptId: input.workflowAttemptId,
      workflowRunSpecId: input.workflowRunSpecId,
      ...prepared,
    });
  } catch (error) {
    // manual会先停在Prompt Review；off仍先写Provider派发栅栏，错误按Executor事实收敛。
    const code = failureCode(error, "direct_agent.start_failed");
    try {
      await recordDirectAgentNodeStep({
        productRunId: input.productRunId,
        workflowAttemptId: input.workflowAttemptId,
        workflowRunSpecId: input.workflowRunSpecId,
        iteration: 1,
        toStatus: "failed",
        outcomeCode: code,
        publicSummary: "直接Agent未能抵达首次提示词审核边界",
      });
    } catch {
      // Product失败结算仍须继续；Node投影失败不能留下假成功。
    }
    return commitFailure(input, code);
  }
  const operationId = current.operationId;

  // 多跑一次纯终态检查，使第16次批准后的succeeded也能提交；实际Hook仍最多16个。
  for (
    let completedReviews = 0;
    completedReviews <= DIRECT_AGENT_MAX_PROVIDER_REQUESTS;
    completedReviews += 1
  ) {
    const agentIteration = completedReviews + 1;
    if (current.operationId !== operationId) {
      try {
        await recordDirectAgentNodeStep({
          productRunId: input.productRunId,
          workflowAttemptId: input.workflowAttemptId,
          workflowRunSpecId: input.workflowRunSpecId,
          iteration: agentIteration,
          toStatus: "failed",
          outcomeCode: "direct_agent.operation_identity_drift",
          publicSummary: "Direct Executor Operation身份发生漂移，已停止",
        });
      } catch {
        // 继续提交Product失败终态。
      }
      return commitFailure(input, "direct_agent.operation_identity_drift");
    }
    if (!isWaitingPromptReview(current)) {
      const terminal = current;
      if (terminal.kind === "succeeded") {
        try {
          await recordDirectAgentNodeStep({
            productRunId: input.productRunId,
            workflowAttemptId: input.workflowAttemptId,
            workflowRunSpecId: input.workflowRunSpecId,
            iteration: agentIteration,
            toStatus: "succeeded",
            outcomeCode: "completed",
            publicSummary: "直接Agent已生成候选，等待产品提交",
          });
        } catch (error) {
          return commitFailure(input, failureCode(error, "direct_agent.node_projection_failed"));
        }
        return {
          outcome: "candidate_ready",
          productRunId: input.productRunId,
          directAgentAttemptId: prepared.directAgentAttemptId,
          directAgentCandidateId: terminal.result.directAgentCandidateId,
          candidateSha256: terminal.result.sha256,
        };
      }
      if (terminal.kind === "outcome_unknown") {
        try {
          await recordDirectAgentNodeStep({
            productRunId: input.productRunId,
            workflowAttemptId: input.workflowAttemptId,
            workflowRunSpecId: input.workflowRunSpecId,
            iteration: agentIteration,
            toStatus: "outcome_unknown",
            outcomeCode: terminal.errorCode,
            publicSummary: "Provider调用结果未知，已停止自动继续",
          });
        } catch {
          // Product outcome_unknown仍是唯一安全终态。
        }
        return commitOutcomeUnknown(input, terminal.errorCode);
      }
      try {
        await recordDirectAgentNodeStep({
          productRunId: input.productRunId,
          workflowAttemptId: input.workflowAttemptId,
          workflowRunSpecId: input.workflowRunSpecId,
          iteration: agentIteration,
          toStatus: terminal.kind === "cancelled" ? "cancelled" : "failed",
          outcomeCode: terminal.errorCode,
          publicSummary: "直接Agent执行未完成，已安全停止",
        });
      } catch {
        // 继续提交Product失败终态。
      }
      return commitFailure(input, terminal.errorCode);
    }
    if (completedReviews === DIRECT_AGENT_MAX_PROVIDER_REQUESTS) {
      try {
        await recordDirectAgentNodeStep({
          productRunId: input.productRunId,
          workflowAttemptId: input.workflowAttemptId,
          workflowRunSpecId: input.workflowRunSpecId,
          iteration: agentIteration,
          toStatus: "failed",
          outcomeCode: "direct_agent.prompt_review_limit_reached",
          publicSummary: "已达到16次Provider审核预算，禁止创建第17次请求",
        });
      } catch {
        // 继续提交Product失败终态。
      }
      return commitFailure(input, "direct_agent.prompt_review_limit_reached");
    }
    // current是可变的跨Step checkpoint；复制出本轮waiting引用，避免后续await后类型/身份漂移。
    const waiting: WaitingPromptReviewOutcome = current;
    const requestIndex = completedReviews + 1;
    if (waiting.review.requestIndex !== requestIndex) {
      try {
        await recordDirectAgentNodeStep({
          productRunId: input.productRunId,
          workflowAttemptId: input.workflowAttemptId,
          workflowRunSpecId: input.workflowRunSpecId,
          iteration: agentIteration,
          toStatus: "failed",
          outcomeCode: "direct_agent.prompt_review_sequence_invalid",
          publicSummary: "提示词审核序号与冻结执行路径不一致",
        });
      } catch {
        // 继续提交Product失败终态。
      }
      return commitFailure(input, "direct_agent.prompt_review_sequence_invalid");
    }

    using reviewHook = promptReviewDecisionHook.create({
      token: promptReviewHookToken(waiting.review.promptReviewRequestId),
    });
    try {
      await recordDirectAgentNodeStep({
        productRunId: input.productRunId,
        workflowAttemptId: input.workflowAttemptId,
        workflowRunSpecId: input.workflowRunSpecId,
        iteration: agentIteration,
        toStatus: "waiting_human",
        publicSummary: `等待审核第${String(requestIndex)}次Provider完整提示词`,
      });
    } catch (error) {
      try {
        await recordDirectAgentNodeStep({
          productRunId: input.productRunId,
          workflowAttemptId: input.workflowAttemptId,
          workflowRunSpecId: input.workflowRunSpecId,
          iteration: agentIteration,
          toStatus: "failed",
          outcomeCode: "direct_agent.hook_claim_failed",
          publicSummary: "提示词审核耐久Hook绑定失败",
        });
      } catch {
        // 继续提交Product失败终态。
      }
      return commitFailure(input, failureCode(error, "direct_agent.hook_claim_failed"));
    }

    if ((await reviewHook.getConflict()) !== null) {
      try {
        await recordDirectAgentNodeStep({
          productRunId: input.productRunId,
          workflowAttemptId: input.workflowAttemptId,
          workflowRunSpecId: input.workflowRunSpecId,
          iteration: agentIteration,
          toStatus: "failed",
          outcomeCode: "direct_agent.hook_conflict",
          publicSummary: "提示词审核耐久Hook身份冲突",
        });
      } catch {
        // 继续提交Product失败终态。
      }
      return commitFailure(input, "workflow.hook_conflict");
    }

    try {
      await claimPromptReviewHookStep({
        productRunId: input.productRunId,
        workflowAttemptId: input.workflowAttemptId,
        review: waiting.review,
      });
    } catch (error) {
      try {
        await recordDirectAgentNodeStep({
          productRunId: input.productRunId,
          workflowAttemptId: input.workflowAttemptId,
          workflowRunSpecId: input.workflowRunSpecId,
          iteration: agentIteration,
          toStatus: "failed",
          outcomeCode: "direct_agent.hook_claim_failed",
          publicSummary: "提示词审核耐久Hook绑定失败",
        });
      } catch {
        // 继续提交Product失败终态。
      }
      return commitFailure(input, failureCode(error, "direct_agent.hook_claim_failed"));
    }

    let signal: PromptReviewDecisionHookPayload;
    try {
      signal = await reviewHook;
    } catch (error) {
      try {
        await recordDirectAgentNodeStep({
          productRunId: input.productRunId,
          workflowAttemptId: input.workflowAttemptId,
          workflowRunSpecId: input.workflowRunSpecId,
          iteration: agentIteration,
          toStatus: "failed",
          outcomeCode: "direct_agent.hook_wait_failed",
          publicSummary: "提示词审核耐久等待失败",
        });
      } catch {
        // 继续提交Product失败终态。
      }
      return commitFailure(input, failureCode(error, "direct_agent.hook_wait_failed"));
    }
    if (!hookMatchesReview(signal, input, waiting)) {
      try {
        await recordDirectAgentNodeStep({
          productRunId: input.productRunId,
          workflowAttemptId: input.workflowAttemptId,
          workflowRunSpecId: input.workflowRunSpecId,
          iteration: agentIteration,
          toStatus: "failed",
          outcomeCode: "direct_agent.prompt_review_hook_mismatch",
          publicSummary: "提示词审核恢复信号与冻结Hash不匹配",
        });
      } catch {
        // 继续提交Product失败终态。
      }
      return commitFailure(input, "direct_agent.prompt_review_hook_mismatch");
    }

    let decision;
    try {
      decision = await loadPromptReviewDecisionStep({
        productRunId: input.productRunId,
        workflowAttemptId: input.workflowAttemptId,
        review: waiting.review,
        promptReviewDecisionId: signal.promptReviewDecisionId,
      });
    } catch (error) {
      try {
        await recordDirectAgentNodeStep({
          productRunId: input.productRunId,
          workflowAttemptId: input.workflowAttemptId,
          workflowRunSpecId: input.workflowRunSpecId,
          iteration: agentIteration,
          toStatus: "failed",
          outcomeCode: "direct_agent.decision_load_failed",
          publicSummary: "无法加载已提交的提示词审核决定",
        });
      } catch {
        // 继续提交Product失败终态。
      }
      return commitFailure(input, failureCode(error, "direct_agent.decision_load_failed"));
    }
    if (
      decision.promptReviewRequestId !== waiting.review.promptReviewRequestId ||
      decision.promptReviewDecisionId !== signal.promptReviewDecisionId ||
      decision.requestRevision !== waiting.review.requestRevision ||
      decision.reviewSha256 !== waiting.review.reviewSha256 ||
      decision.payloadSha256 !== waiting.review.payloadSha256
    ) {
      try {
        await recordDirectAgentNodeStep({
          productRunId: input.productRunId,
          workflowAttemptId: input.workflowAttemptId,
          workflowRunSpecId: input.workflowRunSpecId,
          iteration: agentIteration,
          toStatus: "failed",
          outcomeCode: "direct_agent.prompt_review_decision_mismatch",
          publicSummary: "提示词审核决定与Request版本或Hash不匹配",
        });
      } catch {
        // 继续提交Product失败终态。
      }
      return commitFailure(input, "direct_agent.prompt_review_decision_mismatch");
    }

    if (decision.kind === "reject") {
      let projectionErrorCode: string | undefined;
      try {
        await recordDirectAgentNodeStep({
          productRunId: input.productRunId,
          workflowAttemptId: input.workflowAttemptId,
          workflowRunSpecId: input.workflowRunSpecId,
          iteration: agentIteration,
          toStatus: "cancelled",
          outcomeCode: "rejected",
          publicSummary: "用户已拒绝本次完整提示词",
        });
      } catch (error) {
        projectionErrorCode = failureCode(error, "direct_agent.prompt_review_projection_failed");
      }
      try {
        current = await submitPromptReviewDecisionStep({
          productRunId: input.productRunId,
          workflowAttemptId: input.workflowAttemptId,
          operationId,
          directAgentAttemptId: prepared.directAgentAttemptId,
          review: waiting.review,
          promptReviewDecisionId: decision.promptReviewDecisionId,
        });
      } catch (error) {
        return settleRejected(
          input,
          projectionErrorCode ?? failureCode(error, "direct_agent.reject_cleanup_unknown"),
        );
      }
      if (current.kind !== "cancelled") {
        return settleRejected(
          input,
          projectionErrorCode ?? "direct_agent.reject_cleanup_incomplete",
        );
      }
      return settleRejected(input, projectionErrorCode);
    }

    try {
      await recordDirectAgentNodeStep({
        productRunId: input.productRunId,
        workflowAttemptId: input.workflowAttemptId,
        workflowRunSpecId: input.workflowRunSpecId,
        iteration: agentIteration,
        toStatus: "running",
        publicSummary: "用户已批准本次完整提示词",
      });
    } catch (error) {
      return commitFailure(input, failureCode(error, "direct_agent.node_projection_failed"));
    }

    try {
      current = await submitPromptReviewDecisionStep({
        productRunId: input.productRunId,
        workflowAttemptId: input.workflowAttemptId,
        operationId,
        directAgentAttemptId: prepared.directAgentAttemptId,
        review: waiting.review,
        promptReviewDecisionId: decision.promptReviewDecisionId,
      });
    } catch (error) {
      const code = failureCode(error, "direct_agent.provider_outcome_unknown");
      try {
        await recordDirectAgentNodeStep({
          productRunId: input.productRunId,
          workflowAttemptId: input.workflowAttemptId,
          workflowRunSpecId: input.workflowRunSpecId,
          iteration: agentIteration + 1,
          toStatus: "outcome_unknown",
          outcomeCode: code,
          publicSummary: "已批准提示词的Provider调用结果未知",
        });
      } catch {
        // Product outcome_unknown仍是唯一安全终态。
      }
      return commitOutcomeUnknown(input, code);
    }
  }

  // 合法Executor不会发布第17个Request；若边界漂移，失败关闭且不再恢复Operation。
  return commitFailure(input, "direct_agent.prompt_review_limit_reached");
}

/** 候选已经由Executor持久化；只有这个幂等边界把它采用为正式Assistant Message。 */
export async function commitDirectAgentCandidate(
  input: DirectAgentWorkflowInput,
  candidate: DirectAgentCandidateReady,
): Promise<DirectAgentWorkflowResult> {
  try {
    await commitDirectAgentResultStep({
      productRunId: input.productRunId,
      workflowAttemptId: input.workflowAttemptId,
      directAgentAttemptId: candidate.directAgentAttemptId,
      directAgentCandidateId: candidate.directAgentCandidateId,
      candidateSha256: candidate.candidateSha256,
    });
    return { outcome: "product_committed", productRunId: input.productRunId };
  } catch (error) {
    // Product Commit使用稳定commandId可安全重放；重试耗尽后不猜测是否已经提交。
    const code = failureCode(error, "direct_agent.product_commit_unknown");
    try {
      return await commitOutcomeUnknown(input, code);
    } catch {
      return {
        outcome: "outcome_unknown",
        productRunId: input.productRunId,
        errorCode: code,
      };
    }
  }
}
