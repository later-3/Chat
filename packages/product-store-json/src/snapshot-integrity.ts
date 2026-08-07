import type { ProductSnapshot } from "@chat/contracts";
import { computePlanSha256, StoreCorruptedError } from "@chat/application";
import { assertSingleOpenApproval, assertSinglePlanUnderReview } from "@chat/domain";

/**
 * 快照跨对象完整性校验（任务书§8.5）。
 *
 * 启动遇到悬空引用、Hash不一致或非法状态时失败关闭并保留原文件；
 * transact后同样校验，防止一次跨对象提交产生半提交状态。
 * 这里只做结构性校验；领域规则（单一活动审核等）复用@chat/domain的唯一实现。
 */
export function assertSnapshotIntegrity(snapshot: ProductSnapshot): void {
  const { entities } = snapshot;
  const fail = (detail: string): never => {
    throw new StoreCorruptedError(`快照完整性校验失败:${detail}`);
  };

  for (const message of Object.values(entities.messages)) {
    if (entities.sessions[message.sessionId] === undefined)
      fail(`message ${message.messageId} 悬空sessionId`);
    if (message.sourceRunId !== undefined && entities.runs[message.sourceRunId] === undefined) {
      fail(`message ${message.messageId} 悬空sourceRunId`);
    }
  }

  for (const run of Object.values(entities.runs)) {
    if (entities.sessions[run.sessionId] === undefined)
      fail(`run ${run.productRunId} 悬空sessionId`);
    if (entities.messages[run.sourceMessageId] === undefined)
      fail(`run ${run.productRunId} 悬空sourceMessageId`);
    if (
      run.currentApprovalRequestId !== undefined &&
      entities.approvalRequests[run.currentApprovalRequestId] === undefined
    ) {
      fail(`run ${run.productRunId} 悬空currentApprovalRequestId`);
    }
    if (run.finalMessageId !== undefined && entities.messages[run.finalMessageId] === undefined) {
      fail(`run ${run.productRunId} 悬空finalMessageId`);
    }
    if (run.currentPlanId !== undefined) {
      const current = Object.values(entities.plans).find(
        (plan) =>
          plan.planId === run.currentPlanId && plan.planRevision === run.currentPlanRevision,
      );
      if (current === undefined) fail(`run ${run.productRunId} 悬空currentPlan引用`);
    }
  }

  for (const plan of Object.values(entities.plans)) {
    if (entities.runs[plan.productRunId] === undefined)
      fail(`plan ${plan.planRevisionId} 悬空productRunId`);
    const recomputed = computePlanSha256({
      planId: plan.planId,
      productRunId: plan.productRunId,
      planRevision: plan.planRevision,
      content: plan.content,
    });
    if (recomputed !== plan.sha256) fail(`plan ${plan.planRevisionId} Hash不一致`);
  }

  for (const revisionInput of Object.values(entities.revisionInputs)) {
    if (entities.runs[revisionInput.productRunId] === undefined) {
      fail(`revisionInput ${revisionInput.revisionInputId} 悬空productRunId`);
    }
  }

  for (const approval of Object.values(entities.approvalRequests)) {
    if (entities.runs[approval.productRunId] === undefined)
      fail(`approval ${approval.approvalRequestId} 悬空productRunId`);
    const plan = Object.values(entities.plans).find(
      (candidate) =>
        candidate.planId === approval.planId && candidate.planRevision === approval.planRevision,
    );
    if (plan === undefined) fail(`approval ${approval.approvalRequestId} 悬空plan引用`);
    else if (plan.sha256 !== approval.planSha256)
      fail(`approval ${approval.approvalRequestId} Plan Hash不一致`);
    if (
      approval.decidedByDecisionId !== undefined &&
      entities.decisions[approval.decidedByDecisionId] === undefined
    ) {
      fail(`approval ${approval.approvalRequestId} 悬空decidedByDecisionId`);
    }
  }

  for (const decision of Object.values(entities.decisions)) {
    const approval = entities.approvalRequests[decision.approvalRequestId];
    if (approval === undefined) fail(`decision ${decision.decisionId} 悬空approvalRequestId`);
    else if (approval.planSha256 !== decision.planSha256)
      fail(`decision ${decision.decisionId} Plan Hash不一致`);
    if (
      decision.revisionInputId !== undefined &&
      entities.revisionInputs[decision.revisionInputId] === undefined
    ) {
      fail(`decision ${decision.decisionId} 悬空revisionInputId`);
    }
  }

  for (const contract of Object.values(entities.executionContracts)) {
    if (entities.runs[contract.productRunId] === undefined)
      fail(`contract ${contract.executionContractId} 悬空productRunId`);
    if (entities.decisions[contract.approvalDecisionId] === undefined) {
      fail(`contract ${contract.executionContractId} 悬空approvalDecisionId`);
    }
  }

  for (const candidate of Object.values(entities.executionCandidates)) {
    if (entities.executionContracts[candidate.executionContractId] === undefined) {
      fail(`candidate ${candidate.executionCandidateId} 悬空executionContractId`);
    }
  }

  for (const validation of Object.values(entities.validationResults)) {
    if (entities.executionContracts[validation.executionContractId] === undefined) {
      fail(`validation ${validation.validationResultId} 悬空executionContractId`);
    }
    if (entities.executionCandidates[validation.executionCandidateId] === undefined) {
      fail(`validation ${validation.validationResultId} 悬空executionCandidateId`);
    }
  }

  for (const artifact of Object.values(entities.artifacts)) {
    if (entities.runs[artifact.productRunId] === undefined)
      fail(`artifact ${artifact.artifactId} 悬空productRunId`);
  }

  for (const entry of Object.values(snapshot.outbox)) {
    if (entities.runs[entry.productRunId] === undefined)
      fail(`outbox ${entry.outboxId} 悬空productRunId`);
    if (
      entry.approvalRequestId !== undefined &&
      entities.approvalRequests[entry.approvalRequestId] === undefined
    ) {
      fail(`outbox ${entry.outboxId} 悬空approvalRequestId`);
    }
    if (entry.decisionId !== undefined && entities.decisions[entry.decisionId] === undefined) {
      fail(`outbox ${entry.outboxId} 悬空decisionId`);
    }
  }

  // 领域不变量：一个Run最多一个under_review Plan和一个open Approval
  const runIds = new Set(Object.keys(entities.runs));
  for (const runId of runIds) {
    try {
      assertSinglePlanUnderReview(
        Object.values(entities.plans).filter((plan) => plan.productRunId === runId),
      );
      assertSingleOpenApproval(
        Object.values(entities.approvalRequests).filter(
          (approval) => approval.productRunId === runId,
        ),
      );
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}
