import { type ProductSnapshot } from "@chat/contracts";
import { computePlanSha256 } from "@chat/application";
import {
  assertPromptReviewRequestIndexes,
  computePromptReviewPayloadSha256,
  computePromptReviewSha256,
  computeDirectAgentCandidateSha256,
} from "@chat/domain";
import type { Fail } from "./shared.js";

export function assertRuns(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const planningLegal = new Set([
    "pending/queued",
    "running/planning",
    "running/executing",
    "running/validating",
    "waiting_human/plan_review",
    "succeeded/completed",
    "failed/queued",
    "failed/planning",
    "failed/plan_review",
    "failed/executing",
    "failed/validating",
    "cancelled/queued",
    "cancelled/planning",
    "cancelled/executing",
    "cancelled/validating",
    "cancelled/rejected",
    "outcome_unknown/queued",
    "outcome_unknown/planning",
    "outcome_unknown/plan_review",
    "outcome_unknown/executing",
    "outcome_unknown/validating",
  ]);
  const noteCaptureLegal = new Set([
    "pending/queued",
    "running/extracting",
    "running/classifying",
    "waiting_human/note_review",
    "running/committing",
    "succeeded/completed",
    "failed/queued",
    "failed/extracting",
    "failed/classifying",
    "failed/note_review",
    "failed/committing",
    "cancelled/queued",
    "cancelled/extracting",
    "cancelled/classifying",
    "cancelled/note_review",
    "cancelled/committing",
    "cancelled/rejected",
    "outcome_unknown/queued",
    "outcome_unknown/extracting",
    "outcome_unknown/classifying",
    "outcome_unknown/note_review",
    "outcome_unknown/committing",
  ]);
  const directAgentLegal = new Set([
    "pending/queued",
    "running/executing",
    "waiting_human/prompt_review",
    "succeeded/completed",
    "failed/queued",
    "failed/executing",
    "failed/prompt_review",
    "cancelled/queued",
    "cancelled/executing",
    "cancelled/rejected",
    "outcome_unknown/queued",
    "outcome_unknown/executing",
    "outcome_unknown/prompt_review",
  ]);
  for (const run of Object.values(entities.runs)) {
    const legal =
      run.runKind === "note_capture"
        ? noteCaptureLegal
        : run.runKind === "direct_agent"
          ? directAgentLegal
          : planningLegal;
    if (!legal.has(`${run.status}/${run.phase}`)) fail(`run ${run.productRunId} 生命周期组合非法`);
    const session = entities.sessions[run.sessionId];
    const source = entities.messages[run.sourceMessageId];
    if (session === undefined) fail(`run ${run.productRunId} 悬空sessionId`);
    if (source === undefined) fail(`run ${run.productRunId} 悬空sourceMessageId`);
    if (source.sessionId !== run.sessionId || source.role !== "user") {
      fail(`run ${run.productRunId} 源消息必须是同Session的User Message`);
    }
    if (entities.workflowViewDefinitions[run.workflowViewDefinitionId] === undefined) {
      fail(`run ${run.productRunId} 悬空workflowViewDefinitionId`);
    }
    const view = entities.workflowViewDefinitions[run.workflowViewDefinitionId];
    if (run.runKind === "direct_agent") {
      const runSpec = entities.workflowRunSpecs[run.workflowRunSpecId];
      if (
        run.runnerFamily !== "direct-agent.v1" ||
        runSpec?.productRunId !== run.productRunId ||
        runSpec.definitionRef.blueprintKey !== "direct" ||
        runSpec.businessInput?.kind !== "direct_agent_message" ||
        view?.source.kind !== "published_definition"
      ) {
        fail(`run ${run.productRunId} direct_agent runner/RunSpec/View绑定不一致`);
      }
      const currentReview =
        run.currentPromptReviewRequestId === undefined
          ? undefined
          : entities.promptReviewRequests[run.currentPromptReviewRequestId];
      if (run.status === "waiting_human") {
        if (
          run.phase !== "prompt_review" ||
          currentReview === undefined ||
          currentReview.productRunId !== run.productRunId ||
          currentReview.status !== "open"
        ) {
          fail(`run ${run.productRunId} waiting_human缺少open Prompt Review`);
        }
      } else if (run.currentPromptReviewRequestId !== undefined) {
        fail(`run ${run.productRunId} 非waiting_human仍保留活动Prompt Review引用`);
      }

      const candidates = Object.values(entities.directAgentCandidates).filter(
        (candidate) => candidate.productRunId === run.productRunId,
      );
      if (candidates.length > 1) {
        fail(`run ${run.productRunId} P1不允许多个Direct Agent Candidate`);
      }
      const currentCandidate =
        run.currentDirectAgentCandidateId === undefined
          ? undefined
          : entities.directAgentCandidates[run.currentDirectAgentCandidateId];
      const finalCandidate =
        run.finalDirectAgentCandidateId === undefined
          ? undefined
          : entities.directAgentCandidates[run.finalDirectAgentCandidateId];
      if (
        (run.currentDirectAgentCandidateId !== undefined &&
          currentCandidate?.productRunId !== run.productRunId) ||
        (run.finalDirectAgentCandidateId !== undefined &&
          finalCandidate?.productRunId !== run.productRunId)
      ) {
        fail(`run ${run.productRunId} Direct Agent Candidate引用悬空或跨Run`);
      }
      const finalMessage =
        run.finalMessageId === undefined ? undefined : entities.messages[run.finalMessageId];
      if (run.status === "succeeded") {
        if (
          currentCandidate === undefined ||
          finalCandidate === undefined ||
          currentCandidate.directAgentCandidateId !== finalCandidate.directAgentCandidateId ||
          finalMessage === undefined ||
          finalMessage.role !== "assistant" ||
          finalMessage.sourceRunId !== run.productRunId ||
          finalMessage.content.text !== finalCandidate.output.text
        ) {
          fail(`run ${run.productRunId} succeeded缺少候选到正式Message的确定性提交`);
        }
      } else if (
        run.finalDirectAgentCandidateId !== undefined ||
        run.finalMessageId !== undefined
      ) {
        fail(`run ${run.productRunId} 非succeeded不允许最终Candidate或Message引用`);
      }
      if (run.status === "failed" || run.status === "outcome_unknown") {
        if (run.failure === undefined) fail(`run ${run.productRunId} 失败终态缺少failure`);
      } else if (run.failure !== undefined) {
        fail(`run ${run.productRunId} 非失败终态不允许failure`);
      }
      const promptReviews = Object.values(entities.promptReviewRequests).filter(
        (request) => request.productRunId === run.productRunId,
      );
      if (
        ["succeeded", "failed", "cancelled", "outcome_unknown"].includes(run.status) &&
        promptReviews.some((request) =>
          ["open", "approved", "dispatching"].includes(request.status),
        )
      ) {
        fail(`run ${run.productRunId} 终态遗留未闭合Prompt Review`);
      }
      const workflowAttempts = Object.values(entities.attempts).filter(
        (attempt) => attempt.productRunId === run.productRunId && attempt.kind === "workflow",
      );
      if (workflowAttempts.length !== 1) {
        fail(`run ${run.productRunId} 必须恰有一个workflow Attempt`);
      }
      const directAttempts = Object.values(entities.attempts).filter(
        (attempt) => attempt.productRunId === run.productRunId && attempt.kind === "direct_agent",
      );
      // Direct Attempt与pending/queued -> running/executing在同一事务创建。若Workflow在
      // prepare阶段失败，Run会直接收敛为failed/queued，此时不存在Direct Attempt才是真实
      // 事实；不能为了满足数量约束伪造一次从未开始的Pi执行。
      const expectsNoDirectAttempt = run.phase === "queued";
      if (expectsNoDirectAttempt ? directAttempts.length !== 0 : directAttempts.length !== 1) {
        fail(`run ${run.productRunId} Direct Agent Attempt数量无效`);
      }
      if (run.status === "succeeded" && directAttempts[0]?.outcome !== "success") {
        fail(`run ${run.productRunId} succeeded必须绑定成功Direct Agent Attempt`);
      }
      continue;
    }
    if (run.runKind === "note_capture") {
      if (
        run.runnerFamily !== "note-capture.v1" ||
        run.workflowRunSpecId === undefined ||
        entities.workflowRunSpecs[run.workflowRunSpecId]?.productRunId !== run.productRunId ||
        view?.source.kind !== "published_definition"
      ) {
        fail(`run ${run.productRunId} note_capture runner/RunSpec/View绑定不一致`);
      }
      if (run.status === "succeeded") {
        const final =
          run.finalMessageId === undefined ? undefined : entities.messages[run.finalMessageId];
        if (
          final === undefined ||
          final.role !== "assistant" ||
          final.sourceRunId !== run.productRunId
        ) {
          fail(`run ${run.productRunId} note_capture succeeded缺少绑定的Assistant Message`);
        }
      }
      continue;
    }
    if (run.runnerFamily === "legacy-planning.v1") {
      if (run.workflowRunSpecId !== undefined || view?.source.kind !== "legacy_code") {
        fail(`run ${run.productRunId} legacy runner不得绑定RunSpec且必须使用legacy View`);
      }
    } else if (run.runnerFamily === "configurable-planning.v1") {
      if (
        run.workflowRunSpecId === undefined ||
        entities.workflowRunSpecs[run.workflowRunSpecId]?.productRunId !== run.productRunId ||
        view?.source.kind !== "published_definition"
      ) {
        fail(`run ${run.productRunId} configurable runner缺少RunSpec或Published View`);
      }
    } else {
      fail(`run ${run.productRunId} 使用非正式Runner family`);
    }
    const currentFields = [run.currentPlanId, run.currentPlanRevision];
    if (currentFields.filter((value) => value !== undefined).length === 1) {
      fail(`run ${run.productRunId} currentPlan引用不完整`);
    }
    const currentPlan = Object.values(entities.plans).find(
      (plan) =>
        plan.planId === run.currentPlanId &&
        plan.planRevision === run.currentPlanRevision &&
        plan.productRunId === run.productRunId,
    );
    if (run.currentPlanId !== undefined && currentPlan === undefined) {
      fail(`run ${run.productRunId} 悬空currentPlan引用`);
    }
    const currentApproval =
      run.currentApprovalRequestId === undefined
        ? undefined
        : entities.approvalRequests[run.currentApprovalRequestId];
    if (run.currentApprovalRequestId !== undefined && currentApproval === undefined) {
      fail(`run ${run.productRunId} 悬空currentApprovalRequestId`);
    }
    if (run.status === "waiting_human") {
      if (currentPlan?.status !== "under_review" || currentApproval?.status !== "open") {
        fail(`run ${run.productRunId} waiting_human缺少当前Plan/Approval`);
      }
      if (
        currentApproval.planId !== currentPlan.planId ||
        currentApproval.planRevision !== currentPlan.planRevision ||
        currentApproval.planSha256 !== currentPlan.sha256
      ) {
        fail(`run ${run.productRunId} 当前Approval与Plan不一致`);
      }
    } else if (run.currentApprovalRequestId !== undefined) {
      fail(`run ${run.productRunId} 非waiting_human仍保留活动Approval引用`);
    }
    if (
      (run.phase === "executing" || run.phase === "validating" || run.status === "succeeded") &&
      currentPlan?.status !== "approved"
    ) {
      fail(`run ${run.productRunId} 执行/验证/成功阶段缺少Approved Plan`);
    }
    const final =
      run.finalMessageId === undefined ? undefined : entities.messages[run.finalMessageId];
    if (run.status === "succeeded") {
      if (
        final === undefined ||
        final.role !== "assistant" ||
        final.sourceRunId !== run.productRunId
      ) {
        fail(`run ${run.productRunId} succeeded缺少绑定的Assistant Message`);
      }
      const contracts = Object.values(entities.executionContracts).filter(
        (contract) => contract.productRunId === run.productRunId,
      );
      const candidates = Object.values(entities.executionCandidates).filter(
        (candidate) => candidate.productRunId === run.productRunId,
      );
      if (contracts.length !== 1 || candidates.length !== 1) {
        fail(`run ${run.productRunId} succeeded必须恰有一个Contract与Candidate`);
      }
      const contract = contracts[0];
      const candidate = candidates[0];
      const passValidations = Object.values(entities.validationResults).filter(
        (validation) =>
          validation.productRunId === run.productRunId &&
          validation.executionContractId === contract?.executionContractId &&
          validation.executionCandidateId === candidate?.executionCandidateId &&
          validation.outcome === "pass",
      );
      if (passValidations.length !== 1) {
        fail(`run ${run.productRunId} succeeded缺少唯一pass Validation`);
      }
      const expectedMarkdown = candidate?.finalOutput.sections
        .map((section) => `## ${section.heading}\n\n${section.body}`)
        .join("\n\n");
      if (final.content.text !== expectedMarkdown) {
        fail(`run ${run.productRunId} Assistant Message不是已验证Candidate的确定性渲染`);
      }
    } else if (run.finalMessageId !== undefined) {
      fail(`run ${run.productRunId} 非succeeded不允许finalMessageId`);
    }
    if (run.status === "failed" || run.status === "outcome_unknown") {
      if (run.failure === undefined) fail(`run ${run.productRunId} 失败终态缺少failure`);
    } else if (run.failure !== undefined) {
      fail(`run ${run.productRunId} 非失败终态不允许failure`);
    }
    const workflowAttempts = Object.values(entities.attempts).filter(
      (attempt) => attempt.productRunId === run.productRunId && attempt.kind === "workflow",
    );
    if (workflowAttempts.length !== 1) fail(`run ${run.productRunId} 必须恰有一个workflow Attempt`);
  }
}

export function assertPlansAndReviews(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const grouped = new Map<string, (typeof entities.plans)[string][]>();
  for (const plan of Object.values(entities.plans)) {
    const run = entities.runs[plan.productRunId];
    if (run === undefined) fail(`plan ${plan.planRevisionId} 悬空productRunId`);
    const attempt = entities.attempts[plan.planningAttemptId];
    if (
      attempt === undefined ||
      attempt.productRunId !== plan.productRunId ||
      attempt.kind !== "planning" ||
      attempt.planRevision !== plan.planRevision ||
      attempt.outcome !== "success"
    ) {
      fail(`plan ${plan.planRevisionId} 与planning Attempt不一致`);
    }
    const recomputed = computePlanSha256({
      planId: plan.planId,
      productRunId: plan.productRunId,
      planRevision: plan.planRevision,
      content: plan.content,
    });
    if (recomputed !== plan.sha256) fail(`plan ${plan.planRevisionId} Hash不一致`);
    const plans = grouped.get(plan.productRunId) ?? [];
    plans.push(plan);
    grouped.set(plan.productRunId, plans);
  }
  for (const [runId, plans] of grouped) {
    plans.sort((a, b) => a.planRevision - b.planRevision);
    const planIds = new Set(plans.map((plan) => plan.planId));
    if (planIds.size !== 1) fail(`run ${runId} 的Plan revision使用了多个planId`);
    for (let index = 0; index < plans.length; index += 1) {
      if (plans[index]?.planRevision !== index + 1) fail(`run ${runId} 的Plan revision不连续`);
    }
  }

  for (const revisionInput of Object.values(entities.revisionInputs)) {
    const plan = Object.values(entities.plans).find(
      (candidate) =>
        candidate.planId === revisionInput.planId &&
        candidate.planRevision === revisionInput.planRevision,
    );
    if (plan === undefined || plan.productRunId !== revisionInput.productRunId) {
      fail(`revisionInput ${revisionInput.revisionInputId} 与Plan/Run不一致`);
    }
  }

  for (const approval of Object.values(entities.approvalRequests)) {
    const plan = Object.values(entities.plans).find(
      (candidate) =>
        candidate.planId === approval.planId && candidate.planRevision === approval.planRevision,
    );
    if (
      plan === undefined ||
      plan.productRunId !== approval.productRunId ||
      plan.sha256 !== approval.planSha256
    ) {
      fail(`approval ${approval.approvalRequestId} 与Plan/Run/Hash不一致`);
    }
    if (Date.parse(approval.expiresAt) <= Date.parse(approval.createdAt)) {
      fail(`approval ${approval.approvalRequestId} expiresAt无效`);
    }
    if (approval.status === "open") {
      if (approval.decidedByDecisionId !== undefined || approval.expiredAt !== undefined) {
        fail(`approval ${approval.approvalRequestId} open状态字段冲突`);
      }
    } else if (approval.status === "decided") {
      if (approval.decidedByDecisionId === undefined || approval.expiredAt !== undefined) {
        fail(`approval ${approval.approvalRequestId} decided状态字段不完整`);
      }
    } else if (approval.expiredAt === undefined || approval.decidedByDecisionId !== undefined) {
      fail(`approval ${approval.approvalRequestId} expired状态字段不完整`);
    }
  }

  for (const decision of Object.values(entities.decisions)) {
    const approval = entities.approvalRequests[decision.approvalRequestId];
    if (
      approval === undefined ||
      approval.productRunId !== decision.productRunId ||
      approval.planId !== decision.planId ||
      approval.planRevision !== decision.planRevision ||
      approval.planSha256 !== decision.planSha256 ||
      approval.status !== "decided" ||
      approval.decidedByDecisionId !== decision.decisionId
    ) {
      fail(`decision ${decision.decisionId} 与Approval绑定不完整`);
    }
    if (decision.kind === "request_revision") {
      const revisionInput =
        decision.revisionInputId === undefined
          ? undefined
          : entities.revisionInputs[decision.revisionInputId];
      if (
        revisionInput === undefined ||
        revisionInput.productRunId !== decision.productRunId ||
        revisionInput.planId !== decision.planId ||
        revisionInput.planRevision !== decision.planRevision ||
        decision.reason !== undefined
      ) {
        fail(`decision ${decision.decisionId} request_revision字段不一致`);
      }
    } else if (decision.revisionInputId !== undefined) {
      fail(`decision ${decision.decisionId} 非request_revision不允许revisionInputId`);
    }
    if (decision.kind !== "reject" && decision.reason !== undefined) {
      fail(`decision ${decision.decisionId} 非reject不允许reason`);
    }
  }
}

export function assertPromptReviews(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const byAttempt = new Map<string, (typeof entities.promptReviewRequests)[string][]>();

  for (const request of Object.values(entities.promptReviewRequests)) {
    const run = entities.runs[request.productRunId];
    const attempt = entities.attempts[request.directAgentAttemptId];
    if (
      run?.runKind !== "direct_agent" ||
      attempt === undefined ||
      attempt.kind !== "direct_agent" ||
      attempt.productRunId !== request.productRunId
    ) {
      fail(`promptReviewRequest ${request.promptReviewRequestId} Run/Attempt绑定不一致`);
    }
    let payloadSha256: string;
    try {
      payloadSha256 = computePromptReviewPayloadSha256(request.canonicalPayloadJson);
    } catch (error) {
      fail(
        `promptReviewRequest ${request.promptReviewRequestId} ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (payloadSha256 !== request.payloadSha256) {
      fail(`promptReviewRequest ${request.promptReviewRequestId} Payload Hash不一致`);
    }
    const reviewSha256 = computePromptReviewSha256({
      promptReviewRequestId: request.promptReviewRequestId,
      productRunId: request.productRunId,
      directAgentAttemptId: request.directAgentAttemptId,
      requestIndex: request.requestIndex,
      requestKind: request.requestKind,
      providerId: request.providerId,
      modelId: request.modelId,
      endpointHost: request.endpointHost,
      requestRevision: request.requestRevision,
      payloadSha256: request.payloadSha256,
      rendererVersion: request.rendererVersion,
    });
    if (reviewSha256 !== request.reviewSha256) {
      fail(`promptReviewRequest ${request.promptReviewRequestId} Review Hash不一致`);
    }

    const decision =
      request.decidedByPromptReviewDecisionId === undefined
        ? undefined
        : entities.promptReviewDecisions[request.decidedByPromptReviewDecisionId];
    if (request.status === "open") {
      if (decision !== undefined || request.decidedByPromptReviewDecisionId !== undefined) {
        fail(`promptReviewRequest ${request.promptReviewRequestId} open不得绑定Decision`);
      }
    } else if (request.status === "cancelled") {
      if (
        (request.decidedByPromptReviewDecisionId === undefined) !== (decision === undefined) ||
        (decision !== undefined &&
          (decision.kind !== "approve" ||
            decision.promptReviewRequestId !== request.promptReviewRequestId ||
            decision.productRunId !== request.productRunId ||
            decision.requestRevision !== request.requestRevision ||
            decision.reviewSha256 !== request.reviewSha256 ||
            decision.payloadSha256 !== request.payloadSha256))
      ) {
        fail(`promptReviewRequest ${request.promptReviewRequestId} cancelled Decision绑定不完整`);
      }
    } else {
      if (
        decision === undefined ||
        decision.promptReviewRequestId !== request.promptReviewRequestId ||
        decision.productRunId !== request.productRunId ||
        decision.requestRevision !== request.requestRevision ||
        decision.reviewSha256 !== request.reviewSha256 ||
        decision.payloadSha256 !== request.payloadSha256
      ) {
        fail(`promptReviewRequest ${request.promptReviewRequestId} Decision绑定不完整`);
      }
      if (
        (request.status === "rejected" && decision.kind !== "reject") ||
        (request.status !== "rejected" && decision.kind !== "approve")
      ) {
        fail(`promptReviewRequest ${request.promptReviewRequestId} 状态与Decision不一致`);
      }
    }

    const requests = byAttempt.get(request.directAgentAttemptId) ?? [];
    requests.push(request);
    byAttempt.set(request.directAgentAttemptId, requests);
  }

  for (const [attemptId, requests] of byAttempt) {
    try {
      assertPromptReviewRequestIndexes(requests);
    } catch (error) {
      fail(
        `directAgentAttempt ${attemptId} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const decision of Object.values(entities.promptReviewDecisions)) {
    const request = entities.promptReviewRequests[decision.promptReviewRequestId];
    const session =
      request === undefined
        ? undefined
        : entities.sessions[entities.runs[request.productRunId]?.sessionId ?? ""];
    if (
      request === undefined ||
      request.decidedByPromptReviewDecisionId !== decision.promptReviewDecisionId ||
      request.status === "open" ||
      decision.productRunId !== request.productRunId ||
      decision.requestRevision !== request.requestRevision ||
      decision.reviewSha256 !== request.reviewSha256 ||
      decision.payloadSha256 !== request.payloadSha256 ||
      session?.ownerPrincipalId !== decision.principalId
    ) {
      fail(`promptReviewDecision ${decision.promptReviewDecisionId} Request/Principal绑定不完整`);
    }
  }
}

export function assertDirectAgentCandidates(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  for (const candidate of Object.values(entities.directAgentCandidates)) {
    const run = entities.runs[candidate.productRunId];
    const attempt = entities.attempts[candidate.directAgentAttemptId];
    if (
      run?.runKind !== "direct_agent" ||
      attempt === undefined ||
      attempt.kind !== "direct_agent" ||
      attempt.productRunId !== candidate.productRunId ||
      attempt.outcome !== "success"
    ) {
      fail(`directAgentCandidate ${candidate.directAgentCandidateId} Run/Attempt绑定不一致`);
    }
    const sha256 = computeDirectAgentCandidateSha256({
      directAgentCandidateId: candidate.directAgentCandidateId,
      productRunId: candidate.productRunId,
      directAgentAttemptId: candidate.directAgentAttemptId,
      output: candidate.output,
    });
    if (sha256 !== candidate.sha256) {
      fail(`directAgentCandidate ${candidate.directAgentCandidateId} Hash不一致`);
    }
  }
}
