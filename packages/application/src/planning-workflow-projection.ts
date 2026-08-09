import {
  definitionNodeIdSchema,
  nodeRunTransitionSchema,
  nodeRunTransitionIdSchema,
  nodeValueManifestSchema,
  nodeValueManifestIdSchema,
  workflowNodeRunIdSchema,
  workflowNodeRunSchema,
  workflowNodeTypeSchema,
  workflowViewDefinitionIdSchema,
  workflowViewDefinitionSchema,
  type DefinitionNodeId,
  type NodeProductRef,
  type NodeRunTransition,
  type NodeValueManifestSlot,
  type ProductRunId,
  type ProductSnapshot,
  type WorkflowNodeRun,
  type WorkflowNodeRunStatus,
} from "@chat/contracts";
import {
  LEGACY_PLANNING_VIEW_ID,
  computeNodeValueManifestSha256,
  createLegacyPlanningWorkflowView,
  createNodeValueManifest,
  createWorkflowNodeRun,
  hashCanonical,
  transitionWorkflowNodeRun,
} from "@chat/domain";

const LEGACY_PLANNING_VIEW_DEFINITION_ID =
  workflowViewDefinitionIdSchema.parse(LEGACY_PLANNING_VIEW_ID);

interface DesiredNodeProjection {
  readonly definitionNodeId: DefinitionNodeId;
  readonly nodeType: WorkflowNodeRun["nodeType"];
  readonly executionPath: WorkflowNodeRun["executionPath"];
  readonly attemptNumber: number;
  readonly parentNodeRunId?: WorkflowNodeRun["parentNodeRunId"];
  readonly status: WorkflowNodeRunStatus;
  readonly outcomeCode?: string;
  readonly publicSummary?: string;
  readonly error?: WorkflowNodeRun["error"];
  readonly inputs: readonly NodeValueManifestSlot[];
  readonly outputs: readonly NodeValueManifestSlot[];
  readonly occurredAt: string;
}

const nodeId = (value: string) => definitionNodeIdSchema.parse(value);
const nodeType = (value: string) => workflowNodeTypeSchema.parse(value);

const identityHash = (runId: ProductRunId, desired: DesiredNodeProjection): string =>
  hashCanonical("workflow-node-run-identity.v1", {
    productRunId: runId,
    definitionNodeId: desired.definitionNodeId,
    executionPath: desired.executionPath,
    attemptNumber: desired.attemptNumber,
  });

const derivedNodeRunId = (runId: ProductRunId, desired: DesiredNodeProjection) =>
  workflowNodeRunIdSchema.parse(`wnr_${identityHash(runId, desired).slice(0, 32)}`);

const derivedTransitionId = (nodeRunId: string, sequence: number) =>
  nodeRunTransitionIdSchema.parse(
    `wnt_${hashCanonical("node-run-transition-id.v1", { nodeRunId, sequence }).slice(0, 32)}`,
  );

const derivedManifestId = (nodeRunId: string, direction: "input" | "output") =>
  nodeValueManifestIdSchema.parse(
    `wvm_${hashCanonical("node-value-manifest-id.v1", { nodeRunId, direction }).slice(0, 32)}`,
  );

const messageRef = (snapshot: ProductSnapshot, messageId: string): NodeProductRef | undefined => {
  const message = snapshot.entities.messages[messageId];
  if (message === undefined) return undefined;
  return {
    kind: "message",
    id: message.messageId,
    revision: message.revision,
    sha256: hashCanonical("message.v1", {
      messageId: message.messageId,
      sessionId: message.sessionId,
      sessionSequence: message.sessionSequence,
      role: message.role,
      content: message.content,
    }),
    label:
      message.role === "user"
        ? `用户消息 #${String(message.sessionSequence)}`
        : `回复 #${String(message.sessionSequence)}`,
  };
};

const contextPackageRef = (
  snapshot: ProductSnapshot,
  runId: ProductRunId,
): NodeProductRef | undefined => {
  const value = Object.values(snapshot.entities.contextPackages).find(
    (item) => item.productRunId === runId,
  );
  return value === undefined
    ? undefined
    : {
        kind: "context_package",
        id: value.contextPackageId,
        revision: value.revision,
        sha256: value.sha256,
        label: "本轮上下文",
      };
};

const planRef = (plan: ProductSnapshot["entities"]["plans"][string]): NodeProductRef => ({
  kind: "plan_revision",
  id: plan.planRevisionId,
  // Plan实体revision还包含审核状态CAS；Manifest引用的是不可变Plan内容版本。
  revision: plan.planRevision,
  sha256: plan.sha256,
  label: `计划 v${String(plan.planRevision)}`,
});

const approvalRef = (
  approval: ProductSnapshot["entities"]["approvalRequests"][string],
): NodeProductRef => ({
  kind: "approval_request",
  id: approval.approvalRequestId,
  // Approval状态会从open推进到decided/expired；绑定内容本身只有一个不可变版本。
  revision: 1,
  sha256: hashCanonical("approval-request.v1", {
    productRunId: approval.productRunId,
    planId: approval.planId,
    planRevision: approval.planRevision,
    planSha256: approval.planSha256,
    expiresAt: approval.expiresAt,
  }),
  label: `计划 v${String(approval.planRevision)} 审核`,
});

const decisionRef = (
  decision: ProductSnapshot["entities"]["decisions"][string],
): NodeProductRef => ({
  kind: "decision",
  id: decision.decisionId,
  revision: decision.revision,
  sha256: hashCanonical("decision.v1", {
    approvalRequestId: decision.approvalRequestId,
    productRunId: decision.productRunId,
    planId: decision.planId,
    planRevision: decision.planRevision,
    planSha256: decision.planSha256,
    kind: decision.kind,
    principalId: decision.principalId,
    commandId: decision.commandId,
  }),
  label:
    decision.kind === "approve" ? "已批准" : decision.kind === "reject" ? "已拒绝" : "要求修订",
});

const validationRef = (
  validation: ProductSnapshot["entities"]["validationResults"][string],
): NodeProductRef => ({
  kind: "validation_result",
  id: validation.validationResultId,
  revision: validation.revision,
  sha256: hashCanonical("validation-result.v1", {
    productRunId: validation.productRunId,
    executionContractId: validation.executionContractId,
    executionCandidateId: validation.executionCandidateId,
    outcome: validation.outcome,
    failures: validation.failures,
  }),
  label: validation.outcome === "pass" ? "验证通过" : "验证未通过",
});

const slots = (name: string, refs: Array<NodeProductRef | undefined>): NodeValueManifestSlot[] => {
  const present = refs.filter((ref): ref is NodeProductRef => ref !== undefined);
  return present.length === 0 ? [] : [{ name, refs: present }];
};

const phaseRank = {
  queued: 0,
  planning: 1,
  plan_review: 2,
  executing: 3,
  validating: 4,
  completed: 5,
  rejected: 5,
} as const;

function desiredPlanningNodes(
  snapshot: ProductSnapshot,
  runId: ProductRunId,
  source: "runtime" | "legacy_product_facts",
): DesiredNodeProjection[] {
  const run = snapshot.entities.runs[runId];
  if (run === undefined) return [];
  if ("runKind" in run && run.runKind !== "planning") return [];
  const message = messageRef(snapshot, run.sourceMessageId);
  const context = contextPackageRef(snapshot, runId);
  const plans = Object.values(snapshot.entities.plans)
    .filter((plan) => plan.productRunId === runId)
    .sort((left, right) => left.planRevision - right.planRevision);
  const approvals = Object.values(snapshot.entities.approvalRequests).filter(
    (approval) => approval.productRunId === runId,
  );
  const decisions = Object.values(snapshot.entities.decisions).filter(
    (decision) => decision.productRunId === runId,
  );
  const contract = Object.values(snapshot.entities.executionContracts).find(
    (item) => item.productRunId === runId,
  );
  const candidate = Object.values(snapshot.entities.executionCandidates).find(
    (item) => item.productRunId === runId,
  );
  const validation = Object.values(snapshot.entities.validationResults).find(
    (item) => item.productRunId === runId,
  );
  const artifact = Object.values(snapshot.entities.artifacts).find(
    (item) => item.productRunId === runId,
  );
  const rank = phaseRank[run.phase];
  const runFailure = run.failure === undefined ? undefined : { ...run.failure };
  const planningAttempt = Object.values(snapshot.entities.attempts).find(
    (attempt) => attempt.productRunId === runId && attempt.kind === "planning",
  );

  let contextStatus: WorkflowNodeRunStatus = "queued";
  if (context !== undefined || (source === "runtime" && planningAttempt !== undefined)) {
    contextStatus = "succeeded";
  } else if (run.status === "failed" && /^(memory|context)[._]/u.test(run.failure?.code ?? ""))
    contextStatus = "failed";
  else if (source === "runtime" && rank >= phaseRank.planning) contextStatus = "running";

  const desired: DesiredNodeProjection[] = [
    {
      definitionNodeId: nodeId("context"),
      nodeType: nodeType("context.compile"),
      executionPath: [],
      attemptNumber: 1,
      status: contextStatus,
      publicSummary:
        context !== undefined
          ? "已固定本轮上下文"
          : contextStatus === "running"
            ? "正在整理上下文"
            : "等待整理上下文",
      ...(contextStatus === "failed" && runFailure !== undefined ? { error: runFailure } : {}),
      inputs: slots("source", [message]),
      outputs: slots("context", [context]),
      occurredAt:
        context === undefined
          ? run.updatedAt
          : (Object.values(snapshot.entities.contextPackages).find(
              (item) => item.productRunId === runId,
            )?.updatedAt ?? run.updatedAt),
    },
  ];

  const planCycles = plans.map((plan) => plan.planRevision);
  if (run.phase === "planning" && run.status === "running") {
    const next = (plans.at(-1)?.planRevision ?? 0) + 1;
    if (!planCycles.includes(next)) planCycles.push(next);
  }
  if (planCycles.length === 0) planCycles.push(1);
  for (const cycle of planCycles) {
    const path = [{ containerNodeId: nodeId("review_loop"), iteration: cycle }];
    const plan = plans.find((item) => item.planRevision === cycle);
    const approval = approvals.find((item) => item.planRevision === cycle);
    const decision = approval?.decidedByDecisionId
      ? snapshot.entities.decisions[approval.decidedByDecisionId]
      : decisions.find((item) => item.planRevision === cycle);
    const isCurrentPlanning =
      plan === undefined && run.phase === "planning" && run.status === "running";
    const planStatus: WorkflowNodeRunStatus =
      plan !== undefined
        ? "succeeded"
        : isCurrentPlanning
          ? "running"
          : run.status === "failed" && run.phase === "planning"
            ? "failed"
            : "queued";
    desired.push({
      definitionNodeId: nodeId("plan"),
      nodeType: nodeType("agent.plan"),
      executionPath: path,
      attemptNumber: 1,
      status: planStatus,
      publicSummary:
        plan !== undefined
          ? `已生成计划 v${String(cycle)}`
          : planStatus === "running"
            ? `正在生成计划 v${String(cycle)}`
            : `等待生成计划 v${String(cycle)}`,
      ...(planStatus === "failed" && runFailure !== undefined ? { error: runFailure } : {}),
      inputs: slots("planning_context", [
        message,
        context,
        (() => {
          const priorPlan = plans.filter((item) => item.planRevision < cycle).at(-1);
          return priorPlan === undefined ? undefined : planRef(priorPlan);
        })(),
      ]),
      outputs: slots("plan", [plan === undefined ? undefined : planRef(plan)]),
      occurredAt: plan?.updatedAt ?? run.updatedAt,
    });
    const reviewStatus: WorkflowNodeRunStatus =
      decision !== undefined
        ? "succeeded"
        : approval?.status === "open"
          ? "waiting_human"
          : approval?.status === "expired"
            ? "failed"
            : "queued";
    desired.push({
      definitionNodeId: nodeId("review"),
      nodeType: nodeType("human.plan_review"),
      executionPath: path,
      attemptNumber: 1,
      status: reviewStatus,
      ...(decision !== undefined ? { outcomeCode: decision.kind } : {}),
      publicSummary:
        decision !== undefined
          ? decision.kind === "approve"
            ? "计划已批准"
            : decision.kind === "reject"
              ? "计划已拒绝"
              : "已要求修订"
          : reviewStatus === "waiting_human"
            ? "等待你的决定"
            : "等待计划进入审核",
      ...(reviewStatus === "failed"
        ? { error: { code: "approval.expired", summary: "审核窗口已过期" } }
        : {}),
      inputs: slots("review", [
        plan === undefined ? undefined : planRef(plan),
        approval === undefined ? undefined : approvalRef(approval),
      ]),
      outputs: slots("decision", [decision === undefined ? undefined : decisionRef(decision)]),
      occurredAt: decision?.updatedAt ?? approval?.updatedAt ?? plan?.updatedAt ?? run.updatedAt,
    });
  }

  let executeStatus: WorkflowNodeRunStatus = "queued";
  if (candidate !== undefined) executeStatus = "succeeded";
  else if (run.phase === "executing" && run.status === "running") executeStatus = "running";
  else if (run.phase === "executing" && run.status === "outcome_unknown")
    executeStatus = "outcome_unknown";
  else if (run.phase === "executing" && run.status === "failed") executeStatus = "failed";
  const executeDesired: DesiredNodeProjection = {
    definitionNodeId: nodeId("execute"),
    nodeType: nodeType("execute.plan"),
    executionPath: [],
    attemptNumber: 1,
    status: executeStatus,
    publicSummary:
      candidate !== undefined
        ? "计划执行完成"
        : executeStatus === "running"
          ? "正在执行计划"
          : "等待执行",
    ...(executeStatus === "failed" || executeStatus === "outcome_unknown"
      ? runFailure === undefined
        ? {}
        : { error: runFailure }
      : {}),
    inputs: slots("execution", [
      contract === undefined
        ? undefined
        : {
            kind: "execution_contract",
            id: contract.executionContractId,
            revision: contract.revision,
            sha256: contract.sha256,
            label: "执行合同",
          },
    ]),
    outputs: slots("candidate", [
      candidate === undefined
        ? undefined
        : {
            kind: "execution_candidate",
            id: candidate.executionCandidateId,
            revision: candidate.revision,
            sha256: candidate.sha256,
            label: "执行候选结果",
          },
    ]),
    occurredAt: candidate?.updatedAt ?? contract?.updatedAt ?? run.updatedAt,
  };
  desired.push(executeDesired);
  const executeNodeRunId = derivedNodeRunId(runId, executeDesired);
  if (contract !== undefined) {
    for (const step of [...contract.steps].sort((left, right) =>
      left.stepId.localeCompare(right.stepId),
    )) {
      const stepResult = candidate?.stepResults.find((item) => item.stepId === step.stepId);
      const executionAttempt = Object.values(snapshot.entities.attempts)
        .filter(
          (attempt) =>
            attempt.productRunId === runId &&
            attempt.kind === "execution" &&
            attempt.stepId === step.stepId,
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      const childStatus: WorkflowNodeRunStatus =
        stepResult !== undefined || executionAttempt?.outcome === "success"
          ? "succeeded"
          : executionAttempt?.outcome === "failure"
            ? "failed"
            : executionAttempt?.outcome === "running"
              ? "running"
              : "queued";
      desired.push({
        definitionNodeId: nodeId(
          `execute.step_${hashCanonical("execution-step-node.v1", step.stepId).slice(0, 12)}`,
        ),
        nodeType: nodeType("execute.plan_step"),
        executionPath: [],
        attemptNumber: 1,
        parentNodeRunId: executeNodeRunId,
        status: childStatus,
        publicSummary: stepResult === undefined ? step.title : `${step.title}：已完成`,
        ...(childStatus === "failed" && executionAttempt?.errorCode !== undefined
          ? {
              error: {
                code: executionAttempt.errorCode,
                summary: `执行步骤「${step.title}」失败`,
              },
            }
          : {}),
        inputs: slots("contract", [
          {
            kind: "execution_contract",
            id: contract.executionContractId,
            revision: contract.revision,
            sha256: contract.sha256,
            label: step.title,
          },
        ]),
        outputs: slots("candidate", [
          stepResult === undefined || candidate === undefined
            ? undefined
            : {
                kind: "execution_candidate",
                id: candidate.executionCandidateId,
                revision: candidate.revision,
                sha256: candidate.sha256,
                label: `${step.title}结果`,
              },
        ]),
        occurredAt:
          stepResult === undefined
            ? (executionAttempt?.updatedAt ?? contract.updatedAt)
            : (candidate?.updatedAt ?? contract.updatedAt),
      });
    }
  }

  const validationStatus: WorkflowNodeRunStatus =
    validation?.outcome === "pass"
      ? "succeeded"
      : validation?.outcome === "fail"
        ? "failed"
        : run.phase === "validating" && run.status === "running"
          ? "running"
          : "queued";
  desired.push({
    definitionNodeId: nodeId("validate"),
    nodeType: nodeType("result.validate"),
    executionPath: [],
    attemptNumber: 1,
    status: validationStatus,
    publicSummary:
      validation === undefined
        ? validationStatus === "running"
          ? "正在验证结果"
          : "等待验证"
        : validation.outcome === "pass"
          ? "验证通过"
          : "验证未通过",
    ...(validation?.outcome === "fail"
      ? { error: { code: "validation.failed", summary: "候选结果未通过确定性验证" } }
      : {}),
    inputs: slots("candidate", [
      candidate === undefined
        ? undefined
        : {
            kind: "execution_candidate",
            id: candidate.executionCandidateId,
            revision: candidate.revision,
            sha256: candidate.sha256,
            label: "待验证候选",
          },
    ]),
    outputs: slots("validation", [
      validation === undefined ? undefined : validationRef(validation),
    ]),
    occurredAt: validation?.updatedAt ?? run.updatedAt,
  });

  const finalMessage = run.finalMessageId ? messageRef(snapshot, run.finalMessageId) : undefined;
  const hasCommittedResult =
    artifact !== undefined || (run.status === "succeeded" && finalMessage !== undefined);
  const commitStatus: WorkflowNodeRunStatus = hasCommittedResult
    ? "succeeded"
    : source === "runtime" && run.phase === "completed" && run.status === "running"
      ? "running"
      : "queued";
  desired.push({
    definitionNodeId: nodeId("commit"),
    nodeType: nodeType("product.commit"),
    executionPath: [],
    attemptNumber: 1,
    status: commitStatus,
    publicSummary: commitStatus === "succeeded" ? "正式结果已提交" : "等待提交正式结果",
    inputs: slots("validated", [validation === undefined ? undefined : validationRef(validation)]),
    outputs: slots("result", [
      artifact === undefined
        ? undefined
        : {
            kind: "artifact",
            id: artifact.artifactId,
            revision: artifact.revision,
            sha256: artifact.sha256,
            label: artifact.title,
          },
      finalMessage,
    ]),
    occurredAt: artifact?.updatedAt ?? run.updatedAt,
  });
  return desired;
}

function transitionReason(
  currentStatus: WorkflowNodeRunStatus,
  status: WorkflowNodeRunStatus,
): NodeRunTransition["reasonKind"] {
  if (status === "running") return currentStatus === "waiting_human" ? "resumed" : "started";
  if (status === "waiting_human") return "waiting_human";
  if (status === "succeeded") return "completed";
  if (status === "skipped") return "skipped";
  if (status === "cancelled") return "cancelled";
  if (status === "outcome_unknown") return "outcome_unknown";
  if (status === "failed") return "failed";
  return "queued";
}

function transitionCount(snapshot: ProductSnapshot, nodeRunId: string): number {
  return Object.values(snapshot.entities.nodeRunTransitions).filter(
    (transition) => transition.workflowNodeRunId === nodeRunId,
  ).length;
}

function upsertManifest(
  snapshot: ProductSnapshot,
  nodeRun: WorkflowNodeRun,
  direction: "input" | "output",
  slotsValue: readonly NodeValueManifestSlot[],
  at: string,
): string | undefined {
  if (slotsValue.length === 0) return undefined;
  const id = derivedManifestId(nodeRun.workflowNodeRunId, direction);
  const slots = slotsValue.map((slot) => ({ ...slot, refs: slot.refs.map((ref) => ({ ...ref })) }));
  const existing = snapshot.entities.nodeValueManifests[id];
  if (existing === undefined) {
    snapshot.entities.nodeValueManifests[id] = nodeValueManifestSchema.parse(
      createNodeValueManifest({
        nodeValueManifestId: id,
        workflowNodeRunId: nodeRun.workflowNodeRunId,
        direction,
        slots,
        at,
      }),
    );
  } else {
    const sha256 = computeNodeValueManifestSha256({
      workflowNodeRunId: nodeRun.workflowNodeRunId,
      direction,
      slots,
    });
    if (existing.sha256 !== sha256) {
      throw new Error("Workflow Node Manifest已冻结且内容不同");
    }
  }
  return id;
}

function createLegacyProjectedNode(
  snapshot: ProductSnapshot,
  runId: ProductRunId,
  desired: DesiredNodeProjection,
): WorkflowNodeRun {
  const workflowNodeRunId = derivedNodeRunId(runId, desired);
  const terminal = ["succeeded", "failed", "skipped", "cancelled", "outcome_unknown"].includes(
    desired.status,
  );
  const nodeRun = workflowNodeRunSchema.parse({
    schemaVersion: "workflow-node-run.v1",
    workflowNodeRunId,
    productRunId: runId,
    workflowViewDefinitionId: LEGACY_PLANNING_VIEW_DEFINITION_ID,
    definitionNodeId: desired.definitionNodeId,
    nodeType: desired.nodeType,
    nodeSchemaVersion: "1",
    executionPath: desired.executionPath,
    attemptNumber: desired.attemptNumber,
    ...(desired.parentNodeRunId !== undefined ? { parentNodeRunId: desired.parentNodeRunId } : {}),
    status: desired.status,
    ...(desired.outcomeCode !== undefined ? { outcomeCode: desired.outcomeCode } : {}),
    ...(desired.publicSummary !== undefined ? { publicSummary: desired.publicSummary } : {}),
    ...(desired.error !== undefined ? { error: desired.error } : {}),
    projectionSource: "legacy_product_facts",
    ...(terminal ? { finishedAt: desired.occurredAt } : {}),
    revision: 1,
    createdAt: desired.occurredAt,
    updatedAt: desired.occurredAt,
  });
  // queued只表示身份已排队，尚未实际消费输入。等节点真正开始或形成终态时才冻结
  // Manifest，避免上游Context随后完成时“补全”并原地改写历史证据。
  const inputManifestId =
    nodeRun.status === "queued"
      ? undefined
      : upsertManifest(snapshot, nodeRun, "input", desired.inputs, desired.occurredAt);
  const outputManifestId =
    nodeRun.status === "queued"
      ? undefined
      : upsertManifest(snapshot, nodeRun, "output", desired.outputs, desired.occurredAt);
  const withManifests = workflowNodeRunSchema.parse({
    ...nodeRun,
    ...(inputManifestId !== undefined ? { inputManifestId } : {}),
    ...(outputManifestId !== undefined ? { outputManifestId } : {}),
  });
  const transitionId = derivedTransitionId(workflowNodeRunId, 1);
  snapshot.entities.nodeRunTransitions[transitionId] = {
    schemaVersion: "node-run-transition.v1",
    nodeRunTransitionId: transitionId,
    workflowNodeRunId,
    nodeSequence: 1,
    toStatus: desired.status,
    reasonKind: "projected",
    projectionSource: "legacy_product_facts",
    occurredAt: desired.occurredAt,
    revision: 1,
    createdAt: desired.occurredAt,
    updatedAt: desired.occurredAt,
  };
  return withManifests;
}

function advanceRuntimeNode(
  snapshot: ProductSnapshot,
  current: WorkflowNodeRun,
  desired: DesiredNodeProjection,
): WorkflowNodeRun {
  let nodeRun = current;
  const apply = (status: WorkflowNodeRunStatus) => {
    const sequence = transitionCount(snapshot, nodeRun.workflowNodeRunId) + 1;
    const relatedProductRef =
      status === "waiting_human"
        ? desired.inputs.flatMap((slot) => slot.refs).find((ref) => ref.kind === "approval_request")
        : nodeRun.status === "waiting_human" && (status === "running" || status === "succeeded")
          ? desired.outputs.flatMap((slot) => slot.refs).find((ref) => ref.kind === "decision")
          : status === desired.status
            ? desired.outputs[0]?.refs[0]
            : undefined;
    const result = transitionWorkflowNodeRun(nodeRun, {
      transitionId: derivedTransitionId(nodeRun.workflowNodeRunId, sequence),
      nodeSequence: sequence,
      toStatus: status,
      reasonKind: transitionReason(nodeRun.status, status),
      at: desired.occurredAt,
      ...(status === desired.status && desired.outcomeCode !== undefined
        ? { outcomeCode: desired.outcomeCode }
        : {}),
      ...(status === desired.status && desired.publicSummary !== undefined
        ? { publicSummary: desired.publicSummary }
        : {}),
      ...(status === desired.status && desired.error !== undefined ? { error: desired.error } : {}),
      ...(relatedProductRef !== undefined ? { relatedProductRef } : {}),
    });
    const transition = nodeRunTransitionSchema.parse(result.transition);
    snapshot.entities.nodeRunTransitions[transition.nodeRunTransitionId] = transition;
    nodeRun = workflowNodeRunSchema.parse(result.nodeRun);
  };
  if (nodeRun.status !== desired.status) {
    if (
      nodeRun.status === "queued" &&
      !["running", "skipped", "cancelled", "failed"].includes(desired.status)
    ) {
      apply("running");
    }
    // 人工恢复是独立证据：waiting_human不能直接跳成业务终态，必须先记录resumed。
    if (
      nodeRun.status === "waiting_human" &&
      !["waiting_human", "cancelled", "failed"].includes(desired.status)
    ) {
      apply("running");
    }
    if (nodeRun.status !== desired.status) apply(desired.status);
  }
  // queued节点还未消费输入；只在真正开始/结束后冻结Manifest。
  const inputManifestId =
    nodeRun.status === "queued"
      ? undefined
      : upsertManifest(snapshot, nodeRun, "input", desired.inputs, desired.occurredAt);
  const outputManifestId =
    nodeRun.status === "queued"
      ? undefined
      : upsertManifest(snapshot, nodeRun, "output", desired.outputs, desired.occurredAt);
  const changed =
    nodeRun.inputManifestId !== inputManifestId ||
    nodeRun.outputManifestId !== outputManifestId ||
    nodeRun.publicSummary !== desired.publicSummary ||
    nodeRun.outcomeCode !== desired.outcomeCode;
  return changed
    ? workflowNodeRunSchema.parse({
        ...nodeRun,
        ...(inputManifestId !== undefined ? { inputManifestId } : {}),
        ...(outputManifestId !== undefined ? { outputManifestId } : {}),
        ...(desired.publicSummary !== undefined ? { publicSummary: desired.publicSummary } : {}),
        ...(desired.outcomeCode !== undefined ? { outcomeCode: desired.outcomeCode } : {}),
        revision: nodeRun.revision + 1,
        updatedAt: desired.occurredAt,
      })
    : nodeRun;
}

interface ConfigurableNodeIdentity {
  readonly definitionNodeId: DefinitionNodeId;
  readonly nodeType: WorkflowNodeRun["nodeType"];
  readonly executionPath: WorkflowNodeRun["executionPath"];
}

/**
 * RunSpec是configurable Node身份的唯一来源。这里仅展开确定会执行的Sequence/Loop首轮；
 * Choice未选分支和Loop后续轮由Runner真正进入时创建，不能预先伪造Node Run。
 */
function configurableInitialNodeIdentities(
  snapshot: ProductSnapshot,
  runId: ProductRunId,
): readonly ConfigurableNodeIdentity[] {
  const run = snapshot.entities.runs[runId];
  const runSpec =
    run?.workflowRunSpecId === undefined
      ? undefined
      : snapshot.entities.workflowRunSpecs[run.workflowRunSpecId];
  if (runSpec === undefined) return [];
  const identities: ConfigurableNodeIdentity[] = [];
  const stack: {
    readonly sequence: (typeof runSpec)["semanticRoot"];
    readonly executionPath: WorkflowNodeRun["executionPath"];
  }[] = [{ sequence: runSpec.semanticRoot, executionPath: [] }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    for (let index = frame.sequence.elements.length - 1; index >= 0; index -= 1) {
      const element = frame.sequence.elements[index];
      if (element === undefined) continue;
      if (element.kind === "sequence") {
        stack.push({ sequence: element, executionPath: frame.executionPath });
      } else if (element.kind === "bounded_loop") {
        stack.push({
          sequence: element.body,
          executionPath: [
            ...frame.executionPath,
            {
              containerNodeId: nodeId(`${element.outcomeFromDefinitionNodeId}.loop`),
              iteration: 1,
            },
          ],
        });
      } else if (element.kind === "choice") {
        // outcome尚未成为产品事实，不能猜测会进入哪个分支。
      } else {
        identities.push({
          definitionNodeId: nodeId(element.definitionNodeId),
          nodeType: nodeType(element.nodeType),
          executionPath: frame.executionPath,
        });
      }
    }
  }
  return identities.reverse();
}

function configurableFactDesiredNodes(
  snapshot: ProductSnapshot,
  runId: ProductRunId,
  source: "runtime" | "legacy_product_facts",
): readonly DesiredNodeProjection[] {
  const run = snapshot.entities.runs[runId];
  const runSpec =
    run?.workflowRunSpecId === undefined
      ? undefined
      : snapshot.entities.workflowRunSpecs[run.workflowRunSpecId];
  if (runSpec === undefined) return [];
  const byType = new Map<string, (typeof runSpec.nodeResolutions)[number]>(
    runSpec.nodeResolutions.map((resolution) => [resolution.nodeType, resolution] as const),
  );
  const reviewDefinitionNodeId = byType.get("human.plan_review")?.definitionNodeId;
  const supportedTypes: ReadonlySet<string> = new Set([
    "agent.plan",
    "human.plan_review",
    "execute.plan",
    "result.validate",
    "product.commit",
  ]);
  return desiredPlanningNodes(snapshot, runId, source).flatMap((desired) => {
    if (!supportedTypes.has(desired.nodeType)) return [];
    const resolution = byType.get(desired.nodeType);
    if (resolution === undefined) return [];
    const iteration = desired.executionPath.at(-1)?.iteration;
    const executionPath =
      iteration === undefined || reviewDefinitionNodeId === undefined
        ? []
        : [
            {
              containerNodeId: nodeId(`${reviewDefinitionNodeId}.loop`),
              iteration,
            },
          ];
    return [
      {
        ...desired,
        definitionNodeId: nodeId(resolution.definitionNodeId),
        nodeType: nodeType(resolution.nodeType),
        executionPath,
      },
    ];
  });
}

function upsertConfigurableRuntimeNode(
  snapshot: ProductSnapshot,
  runId: ProductRunId,
  desired: DesiredNodeProjection,
): void {
  const run = snapshot.entities.runs[runId];
  if (run === undefined) return;
  const workflowNodeRunId = derivedNodeRunId(runId, desired);
  const existing = snapshot.entities.workflowNodeRuns[workflowNodeRunId];
  if (existing !== undefined) {
    if (existing.projectionSource !== "runtime") return;
    snapshot.entities.workflowNodeRuns[workflowNodeRunId] = advanceRuntimeNode(
      snapshot,
      existing,
      desired,
    );
    return;
  }
  const created = createWorkflowNodeRun({
    nodeRun: {
      workflowNodeRunId,
      productRunId: runId,
      workflowViewDefinitionId: run.workflowViewDefinitionId,
      definitionNodeId: desired.definitionNodeId,
      nodeType: desired.nodeType,
      nodeSchemaVersion: "1",
      executionPath: desired.executionPath,
      attemptNumber: desired.attemptNumber,
      ...(desired.parentNodeRunId !== undefined
        ? { parentNodeRunId: desired.parentNodeRunId }
        : {}),
    },
    transitionId: derivedTransitionId(workflowNodeRunId, 1),
    at: run.createdAt,
    projectionSource: "runtime",
  });
  const createdTransition = nodeRunTransitionSchema.parse(created.transition);
  const createdNodeRun = workflowNodeRunSchema.parse(created.nodeRun);
  snapshot.entities.nodeRunTransitions[createdTransition.nodeRunTransitionId] = createdTransition;
  snapshot.entities.workflowNodeRuns[workflowNodeRunId] = advanceRuntimeNode(
    snapshot,
    createdNodeRun,
    desired,
  );
}

function synchronizeConfigurablePlanningProjection(
  draft: ProductSnapshot,
  runId: ProductRunId,
  at: string,
  source: "runtime" | "legacy_product_facts",
): void {
  const run = draft.entities.runs[runId];
  const runSpec =
    run?.workflowRunSpecId === undefined
      ? undefined
      : draft.entities.workflowRunSpecs[run.workflowRunSpecId];
  if (run === undefined || runSpec === undefined) return;
  const resolutions = new Map(
    runSpec.nodeResolutions.map((resolution) => [resolution.definitionNodeId, resolution] as const),
  );
  for (const identity of configurableInitialNodeIdentities(draft, runId)) {
    const resolution = resolutions.get(identity.definitionNodeId);
    if (resolution === undefined) continue;
    const skipped = resolution.activation === "skipped";
    const initialDesired: DesiredNodeProjection = {
      ...identity,
      attemptNumber: 1,
      status: skipped ? "skipped" : "queued",
      ...(skipped && resolution.skipOutcome !== undefined
        ? { outcomeCode: resolution.skipOutcome, publicSummary: "已按冻结运行配置跳过" }
        : {}),
      inputs: [],
      outputs: [],
      occurredAt: at,
    };
    // 初始化投影只补缺失身份；后续事务不得用queued把Runner已推进的节点倒退。
    if (draft.entities.workflowNodeRuns[derivedNodeRunId(runId, initialDesired)] === undefined) {
      upsertConfigurableRuntimeNode(draft, runId, initialDesired);
    }
  }
  for (const desired of configurableFactDesiredNodes(draft, runId, source)) {
    upsertConfigurableRuntimeNode(draft, runId, desired);
  }
}

/**
 * 把当前Planning产品事实原子投影为Node Run。调用方必须在同一个Product Store事务的
 * mutate末尾调用；它不读取Trace、不调用Runtime，也不会在事务提交后best-effort补写。
 */
export function synchronizePlanningWorkflowProjection(
  draft: ProductSnapshot,
  runId: ProductRunId,
  at: string,
  source: "runtime" | "legacy_product_facts" = "runtime",
): void {
  const run = draft.entities.runs[runId];
  if (run === undefined) return;
  if ("runKind" in run && run.runKind !== "planning") return;
  // configurable只按冻结RunSpec投影真实节点身份，绝不回写legacy View或伪造可选节点成功。
  if (run.runnerFamily === "configurable-planning.v1") {
    synchronizeConfigurablePlanningProjection(draft, runId, at, source);
    return;
  }
  if (draft.entities.workflowViewDefinitions[LEGACY_PLANNING_VIEW_DEFINITION_ID] === undefined) {
    draft.entities.workflowViewDefinitions[LEGACY_PLANNING_VIEW_DEFINITION_ID] =
      workflowViewDefinitionSchema.parse(createLegacyPlanningWorkflowView(run.createdAt));
  }
  for (const desired of desiredPlanningNodes(draft, runId, source)) {
    const workflowNodeRunId = derivedNodeRunId(runId, desired);
    const existing = draft.entities.workflowNodeRuns[workflowNodeRunId];
    if (existing === undefined) {
      if (source === "legacy_product_facts") {
        draft.entities.workflowNodeRuns[workflowNodeRunId] = createLegacyProjectedNode(
          draft,
          runId,
          desired,
        );
        continue;
      }
      const created = createWorkflowNodeRun({
        nodeRun: {
          workflowNodeRunId,
          productRunId: runId,
          workflowViewDefinitionId: LEGACY_PLANNING_VIEW_DEFINITION_ID,
          definitionNodeId: desired.definitionNodeId,
          nodeType: desired.nodeType,
          nodeSchemaVersion: "1",
          executionPath: desired.executionPath,
          attemptNumber: desired.attemptNumber,
          ...(desired.parentNodeRunId !== undefined
            ? { parentNodeRunId: desired.parentNodeRunId }
            : {}),
        },
        transitionId: derivedTransitionId(workflowNodeRunId, 1),
        at: run.createdAt,
        projectionSource: "runtime",
      });
      const createdTransition = nodeRunTransitionSchema.parse(created.transition);
      const createdNodeRun = workflowNodeRunSchema.parse(created.nodeRun);
      draft.entities.nodeRunTransitions[createdTransition.nodeRunTransitionId] = createdTransition;
      draft.entities.workflowNodeRuns[workflowNodeRunId] = advanceRuntimeNode(
        draft,
        createdNodeRun,
        desired,
      );
      continue;
    }
    if (existing.projectionSource === "legacy_product_facts" || source === "legacy_product_facts") {
      continue;
    }
    draft.entities.workflowNodeRuns[workflowNodeRunId] = advanceRuntimeNode(
      draft,
      existing,
      desired,
    );
  }
  if (run.workflowViewDefinitionId !== LEGACY_PLANNING_VIEW_DEFINITION_ID) {
    draft.entities.runs[runId] = {
      ...run,
      workflowViewDefinitionId: LEGACY_PLANNING_VIEW_DEFINITION_ID,
    };
  }
}
