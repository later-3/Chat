import {
  definitionNodeIdSchema,
  nodeRunTransitionIdSchema,
  nodeValueManifestSchema,
  nodeValueManifestIdSchema,
  workflowNodeRunIdSchema,
  workflowNodeRunSchema,
  workflowNodeTypeSchema,
  workflowViewDefinitionIdSchema,
  type NodeProductRef,
  type NodeValueManifestSlot,
  type ProductRunId,
  type WorkflowNodeRun,
  type WorkflowNodeRunStatus,
} from "@chat/contracts";
import { LEGACY_PLANNING_VIEW_ID, createNodeValueManifest, hashCanonical } from "@chat/domain";
import type { ProductSnapshotV6 } from "./legacy-v6.js";

const LEGACY_VIEW_ID = workflowViewDefinitionIdSchema.parse(LEGACY_PLANNING_VIEW_ID);

interface DesiredNode {
  readonly definitionNodeId: WorkflowNodeRun["definitionNodeId"];
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

function derivedNodeRunId(productRunId: ProductRunId, desired: DesiredNode) {
  return workflowNodeRunIdSchema.parse(
    `wnr_${hashCanonical("workflow-node-run-identity.v1", {
      productRunId,
      definitionNodeId: desired.definitionNodeId,
      executionPath: desired.executionPath,
      attemptNumber: desired.attemptNumber,
    }).slice(0, 32)}`,
  );
}

const transitionId = (workflowNodeRunId: string) =>
  nodeRunTransitionIdSchema.parse(
    `wnt_${hashCanonical("node-run-transition-id.v1", {
      nodeRunId: workflowNodeRunId,
      sequence: 1,
    }).slice(0, 32)}`,
  );

const manifestId = (workflowNodeRunId: string, direction: "input" | "output") =>
  nodeValueManifestIdSchema.parse(
    `wvm_${hashCanonical("node-value-manifest-id.v1", {
      nodeRunId: workflowNodeRunId,
      direction,
    }).slice(0, 32)}`,
  );

function slots(
  name: string,
  refs: readonly (NodeProductRef | undefined)[],
): NodeValueManifestSlot[] {
  const present = refs.filter((ref): ref is NodeProductRef => ref !== undefined);
  return present.length === 0 ? [] : [{ name, refs: present }];
}

function messageRef(snapshot: ProductSnapshotV6, messageId: string): NodeProductRef | undefined {
  const message = snapshot.entities.messages[messageId];
  return message === undefined
    ? undefined
    : {
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
}

function contextRef(
  snapshot: ProductSnapshotV6,
  productRunId: ProductRunId,
): NodeProductRef | undefined {
  const context = Object.values(snapshot.entities.contextPackages).find(
    (item) => item.productRunId === productRunId,
  );
  return context === undefined
    ? undefined
    : {
        kind: "context_package",
        id: context.contextPackageId,
        revision: context.revision,
        sha256: context.sha256,
        label: "本轮上下文",
      };
}

function planRef(plan: ProductSnapshotV6["entities"]["plans"][string]): NodeProductRef {
  return {
    kind: "plan_revision",
    id: plan.planRevisionId,
    revision: plan.planRevision,
    sha256: plan.sha256,
    label: `计划 v${String(plan.planRevision)}`,
  };
}

function approvalRef(
  approval: ProductSnapshotV6["entities"]["approvalRequests"][string],
): NodeProductRef {
  return {
    kind: "approval_request",
    id: approval.approvalRequestId,
    revision: 1,
    sha256: hashCanonical("approval-request.v1", {
      productRunId: approval.productRunId,
      planId: approval.planId,
      planRevision: approval.planRevision,
      planSha256: approval.planSha256,
      expiresAt: approval.expiresAt,
    }),
    label: `计划 v${String(approval.planRevision)} 审核`,
  };
}

function decisionRef(decision: ProductSnapshotV6["entities"]["decisions"][string]): NodeProductRef {
  return {
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
  };
}

function validationRef(
  validation: ProductSnapshotV6["entities"]["validationResults"][string],
): NodeProductRef {
  return {
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
  };
}

function desiredNodes(snapshot: ProductSnapshotV6, productRunId: ProductRunId): DesiredNode[] {
  const run = snapshot.entities.runs[productRunId];
  if (run === undefined) return [];
  const message = messageRef(snapshot, run.sourceMessageId);
  const context = contextRef(snapshot, productRunId);
  const plans = Object.values(snapshot.entities.plans)
    .filter((plan) => plan.productRunId === productRunId)
    .sort((left, right) => left.planRevision - right.planRevision);
  const approvals = Object.values(snapshot.entities.approvalRequests).filter(
    (approval) => approval.productRunId === productRunId,
  );
  const decisions = Object.values(snapshot.entities.decisions).filter(
    (decision) => decision.productRunId === productRunId,
  );
  const contract = Object.values(snapshot.entities.executionContracts).find(
    (item) => item.productRunId === productRunId,
  );
  const candidate = Object.values(snapshot.entities.executionCandidates).find(
    (item) => item.productRunId === productRunId,
  );
  const validation = Object.values(snapshot.entities.validationResults).find(
    (item) => item.productRunId === productRunId,
  );
  const artifact = Object.values(snapshot.entities.artifacts).find(
    (item) => item.productRunId === productRunId,
  );
  const runFailure = run.failure === undefined ? undefined : { ...run.failure };
  let contextStatus: WorkflowNodeRunStatus = "queued";
  if (context !== undefined) contextStatus = "succeeded";
  else if (run.status === "failed" && /^(memory|context)[._]/u.test(run.failure?.code ?? "")) {
    contextStatus = "failed";
  }
  const desired: DesiredNode[] = [
    {
      definitionNodeId: nodeId("context"),
      nodeType: nodeType("context.compile"),
      executionPath: [],
      attemptNumber: 1,
      status: contextStatus,
      publicSummary: context === undefined ? "等待整理上下文" : "已固定本轮上下文",
      ...(contextStatus === "failed" && runFailure !== undefined ? { error: runFailure } : {}),
      inputs: slots("source", [message]),
      outputs: slots("context", [context]),
      occurredAt:
        Object.values(snapshot.entities.contextPackages).find(
          (item) => item.productRunId === productRunId,
        )?.updatedAt ?? run.updatedAt,
    },
  ];

  const cycles = plans.map((plan) => plan.planRevision);
  if (run.phase === "planning" && run.status === "running") {
    const next = (plans.at(-1)?.planRevision ?? 0) + 1;
    if (!cycles.includes(next)) cycles.push(next);
  }
  if (cycles.length === 0) cycles.push(1);
  for (const cycle of cycles) {
    const executionPath = [{ containerNodeId: nodeId("review_loop"), iteration: cycle }];
    const plan = plans.find((item) => item.planRevision === cycle);
    const approval = approvals.find((item) => item.planRevision === cycle);
    const decision = approval?.decidedByDecisionId
      ? snapshot.entities.decisions[approval.decidedByDecisionId]
      : decisions.find((item) => item.planRevision === cycle);
    const planStatus: WorkflowNodeRunStatus =
      plan !== undefined
        ? "succeeded"
        : run.phase === "planning" && run.status === "running"
          ? "running"
          : run.phase === "planning" && run.status === "failed"
            ? "failed"
            : "queued";
    const priorPlan = plans.filter((item) => item.planRevision < cycle).at(-1);
    desired.push({
      definitionNodeId: nodeId("plan"),
      nodeType: nodeType("agent.plan"),
      executionPath,
      attemptNumber: 1,
      status: planStatus,
      publicSummary:
        plan === undefined
          ? planStatus === "running"
            ? `正在生成计划 v${String(cycle)}`
            : `等待生成计划 v${String(cycle)}`
          : `已生成计划 v${String(cycle)}`,
      ...(planStatus === "failed" && runFailure !== undefined ? { error: runFailure } : {}),
      inputs: slots("planning_context", [
        message,
        context,
        priorPlan === undefined ? undefined : planRef(priorPlan),
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
      executionPath,
      attemptNumber: 1,
      status: reviewStatus,
      ...(decision === undefined ? {} : { outcomeCode: decision.kind }),
      publicSummary:
        decision === undefined
          ? reviewStatus === "waiting_human"
            ? "等待你的决定"
            : "等待计划进入审核"
          : decision.kind === "approve"
            ? "计划已批准"
            : decision.kind === "reject"
              ? "计划已拒绝"
              : "已要求修订",
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
  else if (run.phase === "executing" && run.status === "outcome_unknown") {
    executeStatus = "outcome_unknown";
  } else if (run.phase === "executing" && run.status === "failed") executeStatus = "failed";
  const execute: DesiredNode = {
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
    ...(["failed", "outcome_unknown"].includes(executeStatus) && runFailure !== undefined
      ? { error: runFailure }
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
  desired.push(execute);
  const executeNodeRunId = derivedNodeRunId(productRunId, execute);
  for (const step of contract?.steps ?? []) {
    if (contract === undefined) break;
    const stepResult = candidate?.stepResults.find((item) => item.stepId === step.stepId);
    const attempt = Object.values(snapshot.entities.attempts)
      .filter(
        (item) =>
          item.productRunId === productRunId &&
          item.kind === "execution" &&
          item.stepId === step.stepId,
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    const status: WorkflowNodeRunStatus =
      stepResult !== undefined || attempt?.outcome === "success"
        ? "succeeded"
        : attempt?.outcome === "failure"
          ? "failed"
          : attempt?.outcome === "running"
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
      status,
      publicSummary: stepResult === undefined ? step.title : `${step.title}：已完成`,
      ...(status === "failed" && attempt?.errorCode !== undefined
        ? { error: { code: attempt.errorCode, summary: `执行步骤「${step.title}」失败` } }
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
          ? (attempt?.updatedAt ?? contract.updatedAt)
          : (candidate?.updatedAt ?? contract.updatedAt),
    });
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

  const finalMessage =
    run.finalMessageId === undefined ? undefined : messageRef(snapshot, run.finalMessageId);
  const committed =
    artifact !== undefined || (run.status === "succeeded" && finalMessage !== undefined);
  desired.push({
    definitionNodeId: nodeId("commit"),
    nodeType: nodeType("product.commit"),
    executionPath: [],
    attemptNumber: 1,
    status: committed ? "succeeded" : "queued",
    publicSummary: committed ? "正式结果已提交" : "等待提交正式结果",
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

function persistManifest(
  snapshot: ProductSnapshotV6,
  workflowNodeRunId: WorkflowNodeRun["workflowNodeRunId"],
  direction: "input" | "output",
  slots: readonly NodeValueManifestSlot[],
  at: string,
) {
  if (slots.length === 0) return undefined;
  const id = manifestId(workflowNodeRunId, direction);
  snapshot.entities.nodeValueManifests[id] = nodeValueManifestSchema.parse(
    createNodeValueManifest({
      nodeValueManifestId: id,
      workflowNodeRunId,
      direction,
      slots,
      at,
    }),
  );
  return id;
}

/** v5→v6专用冻结投影；只读取迁移快照，不调用会继续演进的Application projector。 */
export function projectV6LegacyPlanningFacts(
  snapshot: ProductSnapshotV6,
  productRunId: ProductRunId,
): void {
  for (const desired of desiredNodes(snapshot, productRunId)) {
    const workflowNodeRunId = derivedNodeRunId(productRunId, desired);
    const inputManifestId = persistManifest(
      snapshot,
      workflowNodeRunId,
      "input",
      desired.inputs,
      desired.occurredAt,
    );
    const outputManifestId = persistManifest(
      snapshot,
      workflowNodeRunId,
      "output",
      desired.outputs,
      desired.occurredAt,
    );
    const terminal = ["succeeded", "failed", "skipped", "cancelled", "outcome_unknown"].includes(
      desired.status,
    );
    snapshot.entities.workflowNodeRuns[workflowNodeRunId] = workflowNodeRunSchema.parse({
      schemaVersion: "workflow-node-run.v1",
      workflowNodeRunId,
      productRunId,
      workflowViewDefinitionId: LEGACY_VIEW_ID,
      definitionNodeId: desired.definitionNodeId,
      nodeType: desired.nodeType,
      nodeSchemaVersion: "1",
      executionPath: desired.executionPath,
      attemptNumber: desired.attemptNumber,
      ...(desired.parentNodeRunId === undefined
        ? {}
        : { parentNodeRunId: desired.parentNodeRunId }),
      status: desired.status,
      ...(desired.outcomeCode === undefined ? {} : { outcomeCode: desired.outcomeCode }),
      ...(desired.publicSummary === undefined ? {} : { publicSummary: desired.publicSummary }),
      ...(desired.error === undefined ? {} : { error: desired.error }),
      ...(inputManifestId === undefined ? {} : { inputManifestId }),
      ...(outputManifestId === undefined ? {} : { outputManifestId }),
      projectionSource: "legacy_product_facts",
      ...(terminal ? { finishedAt: desired.occurredAt } : {}),
      revision: 1,
      createdAt: desired.occurredAt,
      updatedAt: desired.occurredAt,
    });
    const id = transitionId(workflowNodeRunId);
    snapshot.entities.nodeRunTransitions[id] = {
      schemaVersion: "node-run-transition.v1",
      nodeRunTransitionId: id,
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
  }
}
