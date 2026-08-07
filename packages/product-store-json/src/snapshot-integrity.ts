import { EXECUTION_CAPABILITY_MARKDOWN_COMPOSE, type ProductSnapshot } from "@chat/contracts";
import { computePlanSha256, StoreCorruptedError } from "@chat/application";
import {
  assertSingleOpenApproval,
  assertSinglePlanUnderReview,
  computeExecutionInputManifestSha256,
  hashCanonical,
  validateExecutionCandidate,
} from "@chat/domain";

/**
 * 完整快照的关系与生命周期校验。
 *
 * Zod负责单对象形状；这里负责Map键、跨对象引用、Hash、状态组合及双向关系。
 * open与transact都调用同一入口，任何不一致都失败关闭，绝不猜测修复。
 * 本文件虽超过800行，但只有一个公开入口，并按七组对象关系顺序完成同一次全图校验；
 * 拆成可独立调用的公开Validator会制造“只校验一部分也算有效”的错误用法，因此保持内聚。
 */
export function assertSnapshotIntegrity(snapshot: ProductSnapshot): void {
  const { entities } = snapshot;
  const fail = (detail: string): never => {
    throw new StoreCorruptedError(`快照完整性校验失败:${detail}`);
  };

  assertMapKeys(snapshot, fail);
  assertSessionsAndMessages(snapshot, fail);
  assertAttempts(snapshot, fail);
  assertRuns(snapshot, fail);
  assertPlansAndReviews(snapshot, fail);
  assertExecution(snapshot, fail);
  assertReceiptsAndOutbox(snapshot, fail);

  for (const runId of Object.keys(entities.runs)) {
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

type Fail = (detail: string) => never;

function assertMapKeys(snapshot: ProductSnapshot, fail: Fail): void {
  const collections = [
    ["session", snapshot.entities.sessions, "sessionId"],
    ["message", snapshot.entities.messages, "messageId"],
    ["run", snapshot.entities.runs, "productRunId"],
    ["attempt", snapshot.entities.attempts, "attemptId"],
    ["plan", snapshot.entities.plans, "planRevisionId"],
    ["revisionInput", snapshot.entities.revisionInputs, "revisionInputId"],
    ["approval", snapshot.entities.approvalRequests, "approvalRequestId"],
    ["decision", snapshot.entities.decisions, "decisionId"],
    ["contract", snapshot.entities.executionContracts, "executionContractId"],
    ["candidate", snapshot.entities.executionCandidates, "executionCandidateId"],
    ["validation", snapshot.entities.validationResults, "validationResultId"],
    ["artifact", snapshot.entities.artifacts, "artifactId"],
    ["receipt", snapshot.commandReceipts, "commandId"],
    ["outbox", snapshot.outbox, "outboxId"],
  ] as const;
  for (const [label, collection, idField] of collections) {
    for (const [key, entity] of Object.entries(collection)) {
      if ((entity as unknown as Record<string, string>)[idField] !== key) {
        fail(`${label} Map键${key}与${idField}不一致`);
      }
    }
  }
}

function assertSessionsAndMessages(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  for (const session of Object.values(entities.sessions)) {
    const messages = Object.values(entities.messages)
      .filter((message) => message.sessionId === session.sessionId)
      .sort((a, b) => a.sessionSequence - b.sessionSequence);
    const sequences = new Set(messages.map((message) => message.sessionSequence));
    if (sequences.size !== messages.length) fail(`session ${session.sessionId} Message序号重复`);
    const maximum = messages.at(-1)?.sessionSequence ?? 0;
    if (maximum !== session.lastMessageSequence) {
      fail(`session ${session.sessionId} lastMessageSequence与消息不一致`);
    }
    for (let index = 0; index < messages.length; index += 1) {
      if (messages[index]?.sessionSequence !== index + 1) {
        fail(`session ${session.sessionId} Message序号不连续`);
      }
    }
  }

  for (const message of Object.values(entities.messages)) {
    if (entities.sessions[message.sessionId] === undefined) {
      fail(`message ${message.messageId} 悬空sessionId`);
    }
    if (message.role === "user" && message.sourceRunId !== undefined) {
      fail(`user message ${message.messageId} 不允许sourceRunId`);
    }
    if (message.role === "assistant" && message.sourceRunId === undefined) {
      fail(`assistant message ${message.messageId} 缺少sourceRunId`);
    }
    if (message.sourceRunId !== undefined) {
      const run = entities.runs[message.sourceRunId];
      if (run === undefined) fail(`message ${message.messageId} 悬空sourceRunId`);
      if (run.sessionId !== message.sessionId)
        fail(`message ${message.messageId} 与Run不属于同一Session`);
    }
  }
}

function assertAttempts(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  for (const attempt of Object.values(entities.attempts)) {
    const run = entities.runs[attempt.productRunId];
    if (run === undefined) fail(`attempt ${attempt.attemptId} 悬空productRunId`);
    if (attempt.outcome === "failure" && attempt.errorCode === undefined) {
      fail(`attempt ${attempt.attemptId} failure缺少errorCode`);
    }
    if (attempt.outcome !== "failure" && attempt.errorCode !== undefined) {
      fail(`attempt ${attempt.attemptId} 非failure不允许errorCode`);
    }

    const versionEvidence = [
      attempt.inputManifestSha256,
      attempt.promptTemplateVersion,
      attempt.modelConfigVersion,
    ];
    if (attempt.kind === "planning") {
      if (
        attempt.planRevision === undefined ||
        attempt.inputRunRevision === undefined ||
        attempt.sourceMessageSha256 === undefined ||
        versionEvidence.some((value) => value === undefined)
      ) {
        fail(`planning attempt ${attempt.attemptId} 缺少输入与版本证据`);
      }
      if (attempt.stepId !== undefined) fail(`planning attempt ${attempt.attemptId} 不允许stepId`);
      if (run.sourceMessageId === undefined)
        fail(`planning attempt ${attempt.attemptId} 缺少源消息`);
      const source = entities.messages[run.sourceMessageId];
      if (source === undefined) fail(`planning attempt ${attempt.attemptId} 源消息不存在`);
      const sourceHash = hashCanonical("message.v1", {
        messageId: source.messageId,
        sessionId: source.sessionId,
        sessionSequence: source.sessionSequence,
        role: source.role,
        content: source.content,
      });
      if (sourceHash !== attempt.sourceMessageSha256) {
        fail(`planning attempt ${attempt.attemptId} sourceMessageSha256不一致`);
      }
      const prior =
        attempt.priorPlanRevisionId === undefined
          ? undefined
          : entities.plans[attempt.priorPlanRevisionId];
      const revisionInput =
        attempt.revisionInputId === undefined
          ? undefined
          : entities.revisionInputs[attempt.revisionInputId];
      if (attempt.priorPlanRevisionId !== undefined && prior === undefined) {
        fail(`planning attempt ${attempt.attemptId} 悬空priorPlanRevisionId`);
      }
      if (attempt.revisionInputId !== undefined && revisionInput === undefined) {
        fail(`planning attempt ${attempt.attemptId} 悬空revisionInputId`);
      }
      if ((attempt.planRevision ?? 1) > 1 && (prior === undefined || revisionInput === undefined)) {
        fail(`planning attempt ${attempt.attemptId} 修订轮缺少上一版Plan或Revision Input`);
      }
      const manifest = hashCanonical("planning-input-manifest.v1", {
        productRunId: attempt.productRunId,
        planRevision: attempt.planRevision,
        sourceMessageRef: { messageId: source.messageId, sha256: sourceHash },
        ...(prior !== undefined
          ? {
              priorPlanRef: {
                planRevisionId: prior.planRevisionId,
                planId: prior.planId,
                planRevision: prior.planRevision,
                sha256: prior.sha256,
              },
            }
          : {}),
        ...(revisionInput !== undefined
          ? { revisionInputRef: { revisionInputId: revisionInput.revisionInputId } }
          : {}),
        promptTemplateVersion: attempt.promptTemplateVersion,
        modelConfigVersion: attempt.modelConfigVersion,
      });
      if (manifest !== attempt.inputManifestSha256) {
        fail(`planning attempt ${attempt.attemptId} inputManifestSha256不一致`);
      }
    } else if (attempt.kind === "execution") {
      if (attempt.stepId === undefined || versionEvidence.some((value) => value === undefined)) {
        fail(`execution attempt ${attempt.attemptId} 缺少stepId或输入版本证据`);
      }
      if (
        attempt.planRevision !== undefined ||
        attempt.inputRunRevision !== undefined ||
        attempt.sourceMessageSha256 !== undefined ||
        attempt.priorPlanRevisionId !== undefined ||
        attempt.revisionInputId !== undefined
      ) {
        fail(`execution attempt ${attempt.attemptId} 不允许planning输入证据`);
      }
    } else if (
      attempt.stepId !== undefined ||
      attempt.planRevision !== undefined ||
      attempt.inputRunRevision !== undefined ||
      attempt.sourceMessageSha256 !== undefined ||
      attempt.priorPlanRevisionId !== undefined ||
      attempt.revisionInputId !== undefined ||
      versionEvidence.some((value) => value !== undefined)
    ) {
      fail(`workflow attempt ${attempt.attemptId} 不允许节点输入证据`);
    }
  }
}

function assertRuns(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const legal = new Set([
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
    "cancelled/rejected",
    "outcome_unknown/queued",
    "outcome_unknown/planning",
    "outcome_unknown/executing",
    "outcome_unknown/validating",
  ]);
  for (const run of Object.values(entities.runs)) {
    if (!legal.has(`${run.status}/${run.phase}`)) fail(`run ${run.productRunId} 生命周期组合非法`);
    const session = entities.sessions[run.sessionId];
    const source = entities.messages[run.sourceMessageId];
    if (session === undefined) fail(`run ${run.productRunId} 悬空sessionId`);
    if (source === undefined) fail(`run ${run.productRunId} 悬空sourceMessageId`);
    if (source.sessionId !== run.sessionId || source.role !== "user") {
      fail(`run ${run.productRunId} 源消息必须是同Session的User Message`);
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

function assertPlansAndReviews(snapshot: ProductSnapshot, fail: Fail): void {
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

function assertExecution(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  for (const contract of Object.values(entities.executionContracts)) {
    const decision = entities.decisions[contract.approvalDecisionId];
    const plan = Object.values(entities.plans).find(
      (candidate) =>
        candidate.planId === contract.approvedPlanId &&
        candidate.planRevision === contract.approvedPlanRevision,
    );
    if (
      decision === undefined ||
      decision.kind !== "approve" ||
      decision.productRunId !== contract.productRunId ||
      plan === undefined ||
      plan.productRunId !== contract.productRunId ||
      plan.status !== "approved" ||
      plan.sha256 !== contract.approvedPlanSha256 ||
      decision.planSha256 !== contract.approvedPlanSha256
    ) {
      fail(`contract ${contract.executionContractId} 与Approved Plan/Decision不一致`);
    }
    const expectedSteps = plan.content.steps.map((step) => ({
      stepId: step.stepId,
      title: step.title,
      purpose: step.purpose,
      dependsOn: step.dependsOn,
      inputRefs: step.inputRefs,
      expectedOutput: step.expectedOutput,
      successCriteria: step.successCriteria,
      capabilityRefs: step.requestedCapabilities,
    }));
    if (JSON.stringify(contract.steps) !== JSON.stringify(expectedSteps)) {
      fail(`contract ${contract.executionContractId} steps与Approved Plan不一致`);
    }
    if (
      JSON.stringify(contract.completionCriteria) !==
      JSON.stringify(plan.content.completionCriteria)
    ) {
      fail(`contract ${contract.executionContractId} completionCriteria不一致`);
    }
    const expectedCapabilities = [
      ...new Set(plan.content.steps.flatMap((step) => step.requestedCapabilities)),
    ];
    if (
      JSON.stringify(contract.capabilityRefs) !== JSON.stringify(expectedCapabilities) ||
      contract.capabilityRefs.some(
        (capability) => capability !== EXECUTION_CAPABILITY_MARKDOWN_COMPOSE,
      )
    ) {
      fail(`contract ${contract.executionContractId} Capability扩大或不一致`);
    }
    const hash = hashCanonical("execution-contract.v1", {
      productRunId: contract.productRunId,
      approvedPlanId: contract.approvedPlanId,
      approvedPlanRevision: contract.approvedPlanRevision,
      approvedPlanSha256: contract.approvedPlanSha256,
      approvalDecisionId: contract.approvalDecisionId,
      steps: contract.steps,
      completionCriteria: contract.completionCriteria,
      capabilityRefs: contract.capabilityRefs,
      limits: contract.limits,
    });
    if (hash !== contract.sha256) fail(`contract ${contract.executionContractId} Hash不一致`);
  }

  for (const candidate of Object.values(entities.executionCandidates)) {
    const contract = entities.executionContracts[candidate.executionContractId];
    if (contract === undefined || contract.productRunId !== candidate.productRunId) {
      fail(`candidate ${candidate.executionCandidateId} 与Contract不一致`);
    }
    if (candidate.stepResults.length !== contract.steps.length) {
      fail(`candidate ${candidate.executionCandidateId} 步骤数与Contract不一致`);
    }
    const priorResults = new Map<string, (typeof candidate.stepResults)[number]>();
    for (let index = 0; index < candidate.stepResults.length; index += 1) {
      const stepResult = candidate.stepResults[index];
      const contractStep = contract.steps[index];
      if (
        stepResult === undefined ||
        contractStep === undefined ||
        stepResult.stepId !== contractStep.stepId
      ) {
        fail(`candidate ${candidate.executionCandidateId} 步骤顺序与Contract不一致`);
      }
      const attempt = entities.attempts[stepResult.executionAttemptId];
      if (
        attempt === undefined ||
        attempt.productRunId !== candidate.productRunId ||
        attempt.kind !== "execution" ||
        attempt.stepId !== stepResult.stepId ||
        attempt.outcome !== "success" ||
        attempt.inputManifestSha256 !== stepResult.inputManifestSha256 ||
        attempt.promptTemplateVersion === undefined ||
        attempt.modelConfigVersion === undefined
      ) {
        fail(`candidate ${candidate.executionCandidateId} 步骤Attempt血缘不一致`);
      }
      if (
        stepResult.dependencyRefs.length !== contractStep.dependsOn.length ||
        stepResult.dependencyRefs.some((ref, dependencyIndex) => {
          const prior = priorResults.get(ref.stepId);
          return (
            contractStep.dependsOn[dependencyIndex] !== ref.stepId ||
            prior === undefined ||
            prior.executionAttemptId !== ref.executionAttemptId ||
            prior.sha256 !== ref.sha256
          );
        })
      ) {
        fail(`candidate ${candidate.executionCandidateId} 步骤依赖血缘不一致`);
      }
      const inputManifestSha256 = computeExecutionInputManifestSha256({
        executionContractId: contract.executionContractId,
        approvedPlanSha256: contract.approvedPlanSha256,
        stepId: stepResult.stepId,
        dependencyRefs: stepResult.dependencyRefs,
        promptTemplateVersion: attempt.promptTemplateVersion,
        modelConfigVersion: attempt.modelConfigVersion,
      });
      if (inputManifestSha256 !== stepResult.inputManifestSha256) {
        fail(`candidate ${candidate.executionCandidateId} 步骤输入Manifest不一致`);
      }
      const stepHash = hashCanonical("execution-step-result.v1", {
        stepId: stepResult.stepId,
        executionAttemptId: stepResult.executionAttemptId,
        inputManifestSha256: stepResult.inputManifestSha256,
        dependencyRefs: stepResult.dependencyRefs,
        output: stepResult.output,
        sections: stepResult.sections,
        successCriteriaEvidence: stepResult.successCriteriaEvidence,
        criteriaEvidence: stepResult.criteriaEvidence,
        warnings: stepResult.warnings,
      });
      if (stepHash !== stepResult.sha256) {
        fail(`candidate ${candidate.executionCandidateId} 步骤结果Hash不一致`);
      }
      priorResults.set(stepResult.stepId, stepResult);
    }
    const hash = hashCanonical("execution-candidate.v1", {
      executionContractId: candidate.executionContractId,
      stepResults: candidate.stepResults,
      finalOutput: candidate.finalOutput,
      completionCriteriaEvidence: candidate.completionCriteriaEvidence,
      warnings: candidate.warnings,
    });
    if (hash !== candidate.sha256) fail(`candidate ${candidate.executionCandidateId} Hash不一致`);
    if (
      JSON.stringify(candidate.finalOutput.sections) !==
        JSON.stringify(candidate.stepResults.flatMap((step) => step.sections)) ||
      JSON.stringify(candidate.completionCriteriaEvidence) !==
        JSON.stringify(candidate.stepResults.flatMap((step) => step.criteriaEvidence)) ||
      JSON.stringify(candidate.warnings) !==
        JSON.stringify(candidate.stepResults.flatMap((step) => step.warnings))
    ) {
      fail(`candidate ${candidate.executionCandidateId} 汇总字段不是步骤结果的确定性投影`);
    }
  }

  for (const validation of Object.values(entities.validationResults)) {
    const contract = entities.executionContracts[validation.executionContractId];
    const candidate = entities.executionCandidates[validation.executionCandidateId];
    if (
      contract === undefined ||
      candidate === undefined ||
      contract.productRunId !== validation.productRunId ||
      candidate.productRunId !== validation.productRunId ||
      candidate.executionContractId !== validation.executionContractId
    ) {
      fail(`validation ${validation.validationResultId} 与Contract/Candidate/Run不一致`);
    }
    if ((validation.outcome === "pass") !== (validation.failures.length === 0)) {
      fail(`validation ${validation.validationResultId} outcome与failures不一致`);
    }
    const expectedFailures = validateExecutionCandidate(
      {
        executionContractId: contract.executionContractId,
        approvedPlanId: contract.approvedPlanId,
        approvedPlanRevision: contract.approvedPlanRevision,
        approvedPlanSha256: contract.approvedPlanSha256,
        steps: contract.steps,
        completionCriteria: contract.completionCriteria,
      },
      {
        executionContractId: candidate.executionContractId,
        stepResults: candidate.stepResults,
        finalOutputSections: candidate.finalOutput.sections,
        completionCriteriaEvidence: candidate.completionCriteriaEvidence,
      },
    );
    if (JSON.stringify(validation.failures) !== JSON.stringify(expectedFailures)) {
      fail(`validation ${validation.validationResultId} 不是服务端确定性验证结果`);
    }
  }

  for (const artifact of Object.values(entities.artifacts)) {
    if (entities.runs[artifact.productRunId] === undefined) {
      fail(`artifact ${artifact.artifactId} 悬空productRunId`);
    }
    const hash = hashCanonical("artifact.v1", {
      productRunId: artifact.productRunId,
      kind: artifact.kind,
      title: artifact.title,
      content: artifact.content,
    });
    if (hash !== artifact.sha256) fail(`artifact ${artifact.artifactId} Hash不一致`);
  }
}

function assertReceiptsAndOutbox(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const receipts = Object.values(snapshot.commandReceipts);
  if (receipts.length !== snapshot.storeRevision) {
    fail("Command Receipt数量与storeRevision不一致");
  }
  const committedRevisions = new Set(receipts.map((receipt) => receipt.committedStoreRevision));
  for (let revision = 1; revision <= snapshot.storeRevision; revision += 1) {
    if (!committedRevisions.has(revision)) fail(`缺少store revision ${String(revision)}的Receipt`);
  }
  const receiptShapes: Record<string, readonly string[]> = {
    CreateProductSession: ["sessionId"],
    SubmitUserMessage: ["messageId", "productRunId"],
    CompilePlanningInput: ["attemptId", "productRunId"],
    PublishPlanForReview: ["planRevisionId", "approvalRequestId", "productRunId"],
    BeginRunAttempt: ["attemptId"],
    CompleteRunAttempt: [],
    CompileExecutionContract: ["executionContractId"],
    PersistExecutionCandidate: ["executionCandidateId"],
    PersistValidationResult: ["validationResultId"],
    CommitExecutionResult: ["finalMessageId", "productRunId", "messageSha256"],
    CommitRejectedRun: ["productRunId"],
    ExpireApproval: ["status"],
    CommitRunFailure: ["productRunId"],
    UpdateOutboxStatus: [],
    FailOutboxAndRun: ["productRunId"],
    CommitRunOutcomeUnknown: ["productRunId"],
  };
  for (const receipt of receipts) {
    if (
      receipt.committedStoreRevision < 1 ||
      receipt.committedStoreRevision > snapshot.storeRevision
    ) {
      fail(`receipt ${receipt.commandId} committedStoreRevision越界`);
    }
    const expectedKeys =
      receipt.commandType === "SubmitPlanDecision"
        ? receipt.resultRefs["approvalExpired"] === "true"
          ? ["approvalExpired", "productRunId"]
          : ["decisionId", "productRunId"]
        : receiptShapes[receipt.commandType];
    if (expectedKeys === undefined) fail(`receipt ${receipt.commandId} commandType未知`);
    const actualKeys = Object.keys(receipt.resultRefs).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify([...expectedKeys].sort())) {
      fail(`receipt ${receipt.commandId} resultRefs与Command类型不一致`);
    }
    for (const [key, value] of Object.entries(receipt.resultRefs)) {
      const exists =
        key === "sessionId"
          ? entities.sessions[value] !== undefined
          : key === "messageId" || key === "finalMessageId"
            ? entities.messages[value] !== undefined
            : key === "productRunId"
              ? entities.runs[value] !== undefined
              : key === "attemptId"
                ? entities.attempts[value] !== undefined
                : key === "planRevisionId"
                  ? entities.plans[value] !== undefined
                  : key === "approvalRequestId"
                    ? entities.approvalRequests[value] !== undefined
                    : key === "decisionId"
                      ? entities.decisions[value] !== undefined
                      : key === "executionContractId"
                        ? entities.executionContracts[value] !== undefined
                        : key === "executionCandidateId"
                          ? entities.executionCandidates[value] !== undefined
                          : key === "validationResultId"
                            ? entities.validationResults[value] !== undefined
                            : key === "messageSha256"
                              ? /^[a-f0-9]{64}$/.test(value)
                              : key === "approvalExpired"
                                ? value === "true"
                                : key === "status"
                                  ? value === "expired" || value === "already_decided"
                                  : false;
      if (!exists) fail(`receipt ${receipt.commandId} 的${key}引用无效`);
    }
    if (receipt.commandType === "SubmitUserMessage") {
      const message = entities.messages[receipt.resultRefs["messageId"] ?? ""];
      const run = entities.runs[receipt.resultRefs["productRunId"] ?? ""];
      if (
        message === undefined ||
        run === undefined ||
        run.sourceMessageId !== message.messageId ||
        run.sessionId !== message.sessionId ||
        message.role !== "user"
      ) {
        fail(`receipt ${receipt.commandId} 的Message/Run绑定不一致`);
      }
    }
    if (receipt.commandType === "PublishPlanForReview") {
      const plan = entities.plans[receipt.resultRefs["planRevisionId"] ?? ""];
      const approval = entities.approvalRequests[receipt.resultRefs["approvalRequestId"] ?? ""];
      const run = entities.runs[receipt.resultRefs["productRunId"] ?? ""];
      if (
        plan === undefined ||
        approval === undefined ||
        run === undefined ||
        plan.productRunId !== run.productRunId ||
        approval.productRunId !== run.productRunId ||
        approval.planId !== plan.planId ||
        approval.planRevision !== plan.planRevision ||
        approval.planSha256 !== plan.sha256
      ) {
        fail(`receipt ${receipt.commandId} 的Plan/Approval/Run绑定不一致`);
      }
    }
    if (receipt.commandType === "SubmitPlanDecision") {
      const decision = entities.decisions[receipt.resultRefs["decisionId"] ?? ""];
      const run = entities.runs[receipt.resultRefs["productRunId"] ?? ""];
      if (
        receipt.resultRefs["approvalExpired"] !== "true" &&
        (decision === undefined || run === undefined || decision.productRunId !== run.productRunId)
      ) {
        fail(`receipt ${receipt.commandId} 的Decision/Run绑定不一致`);
      }
    }
    if (receipt.commandType === "CommitExecutionResult") {
      const message = entities.messages[receipt.resultRefs["finalMessageId"] ?? ""];
      const run = entities.runs[receipt.resultRefs["productRunId"] ?? ""];
      if (
        message === undefined ||
        run === undefined ||
        run.finalMessageId !== message.messageId ||
        message.sourceRunId !== run.productRunId
      ) {
        fail(`receipt ${receipt.commandId} 的正式Message/Run绑定不一致`);
      }
      const messageSha256 = hashCanonical("message.v1", {
        messageId: message.messageId,
        sessionId: message.sessionId,
        sessionSequence: message.sessionSequence,
        role: message.role,
        content: message.content,
      });
      if (receipt.resultRefs["messageSha256"] !== messageSha256) {
        fail(`receipt ${receipt.commandId} 的messageSha256不一致`);
      }
    }
  }
  for (const entry of Object.values(snapshot.outbox)) {
    if (entities.runs[entry.productRunId] === undefined) {
      fail(`outbox ${entry.outboxId} 悬空productRunId`);
    }
    if (entry.kind === "workflow_start") {
      if (entry.approvalRequestId !== undefined || entry.decisionId !== undefined) {
        fail(`outbox ${entry.outboxId} workflow_start不允许Decision字段`);
      }
    } else {
      const approval =
        entry.approvalRequestId === undefined
          ? undefined
          : entities.approvalRequests[entry.approvalRequestId];
      const decision =
        entry.decisionId === undefined ? undefined : entities.decisions[entry.decisionId];
      if (
        approval === undefined ||
        decision === undefined ||
        approval.productRunId !== entry.productRunId ||
        decision.productRunId !== entry.productRunId ||
        decision.approvalRequestId !== approval.approvalRequestId
      ) {
        fail(`outbox ${entry.outboxId} workflow_resume绑定不完整`);
      }
    }
  }
}
