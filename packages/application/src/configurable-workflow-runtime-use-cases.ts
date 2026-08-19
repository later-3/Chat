import {
  nodeRunTransitionSchema,
  workflowNodeRunSchema,
  type NodeProductRef,
  type ProductRunId,
  type WorkflowRunSpecId,
  type WorkflowRunSpec,
  type WorkflowNodeRunStatus,
} from "@chat/contracts";
import {
  computePromptReviewDecisionSha256,
  computePromptReviewSha256,
  createWorkflowNodeRun,
  hashCanonical,
  transitionWorkflowNodeRun,
  workflowNodeRunIdentityKey,
} from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { ApplicationError, notFound } from "./errors.js";
import { validateWorkflowRunSpecIntegrity } from "./workflow-run-spec-compiler.js";
import { DEFAULT_NODE_CATALOG } from "./workflow-node-catalog.js";
import { emitWorkflowMemoryNodeTrace } from "./workflow-memory-trace.js";

export async function getWorkflowRunSpecForRuntime(
  deps: ApplicationDeps,
  input: { readonly productRunId: ProductRunId; readonly workflowRunSpecId: WorkflowRunSpecId },
): Promise<{ readonly runSpec: WorkflowRunSpec }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const run = snapshot.entities.runs[input.productRunId];
  const runSpec = snapshot.entities.workflowRunSpecs[input.workflowRunSpecId];
  if (run === undefined || run.workflowRunSpecId !== input.workflowRunSpecId) {
    throw notFound("Workflow RunSpec绑定不存在");
  }
  if (runSpec === undefined) throw notFound("Workflow RunSpec不存在");
  const validation = validateWorkflowRunSpecIntegrity(runSpec);
  if (!validation.success || runSpec.productRunId !== input.productRunId) {
    throw new ApplicationError({
      code: "store_corrupted",
      httpStatus: 500,
      message: "Workflow RunSpec损坏",
      recoveryAction: "contact_support",
    });
  }
  return { runSpec: validation.runSpec };
}

export interface TransitionConfigurablePlanningNodeInput {
  readonly commandId: Parameters<ApplicationDeps["store"]["transact"]>[0]["commandId"];
  readonly productRunId: ProductRunId;
  readonly workflowRunSpecId: WorkflowRunSpecId;
  readonly definitionNodeId: string;
  readonly executionPath: readonly {
    readonly containerNodeId: string;
    readonly iteration: number;
  }[];
  readonly attemptNumber: number;
  readonly toStatus: Exclude<WorkflowNodeRunStatus, "queued">;
  readonly outcomeCode?: string | undefined;
  readonly publicSummary?: string | undefined;
}

export async function transitionConfigurablePlanningNode(
  deps: ApplicationDeps,
  input: TransitionConfigurablePlanningNodeInput,
): Promise<{ readonly workflowNodeRunId: string; readonly revision: number }> {
  const now = deps.now();
  const requestSha256 = hashCanonical("command.transition-configurable-planning-node.v1", input);
  let didTransition = false;
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "TransitionConfigurablePlanningNode",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const run = draft.entities.runs[input.productRunId];
      const runSpec =
        input.workflowRunSpecId === undefined
          ? undefined
          : draft.entities.workflowRunSpecs[input.workflowRunSpecId];
      if (
        run === undefined ||
        run.workflowRunSpecId !== input.workflowRunSpecId ||
        runSpec === undefined ||
        runSpec.productRunId !== input.productRunId
      ) {
        throw notFound("Workflow RunSpec绑定不存在");
      }
      const node = runSpec.nodeResolutions.find(
        (candidate) => candidate.definitionNodeId === input.definitionNodeId,
      );
      if (node === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 422,
          message: "Workflow节点不存在",
        });
      }
      assertRuntimeNodeCommand(runSpec, node, input);
      if (
        node.nodeType === "human.plan_review" &&
        !["waiting_human", "succeeded", "failed"].includes(input.toStatus)
      ) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 422,
          message: "人工审核节点状态不允许通过该命令转换",
        });
      }
      if (
        node.nodeType === "human.note_review" &&
        !["waiting_human", "succeeded", "failed", "cancelled"].includes(input.toStatus)
      ) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 422,
          message: "人工审核节点状态不允许通过该命令转换",
        });
      }
      if (
        node.nodeType === "human.prompt_review" &&
        !["waiting_human", "succeeded", "cancelled", "failed"].includes(input.toStatus)
      ) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 422,
          message: "Prompt Review节点状态不允许通过该命令转换",
        });
      }
      const workflowNodeRunId = derivedWorkflowNodeRunId(input);
      const existing = draft.entities.workflowNodeRuns[workflowNodeRunId];
      if (existing?.status === input.toStatus) {
        assertEquivalentRepeatedTransition(existing, input);
        return { resultRefs: { workflowNodeRunId } };
      }
      const closesRejectedPromptReview =
        run.status === "cancelled" &&
        (node.nodeType === "human.prompt_review" || node.nodeType === "agent.direct") &&
        existing?.status === "waiting_human" &&
        input.toStatus === "cancelled" &&
        input.outcomeCode === "rejected";
      const closesFailedPromptReview =
        (node.nodeType === "human.prompt_review" || node.nodeType === "agent.direct") &&
        existing?.status === "waiting_human" &&
        input.toStatus === "failed";
      const closesUnknownDirectAgent =
        run.status === "outcome_unknown" &&
        node.nodeType === "agent.direct" &&
        existing?.status === "running" &&
        input.toStatus === "outcome_unknown";
      if (
        ["succeeded", "failed", "cancelled", "outcome_unknown"].includes(run.status) &&
        !closesRejectedPromptReview &&
        !closesFailedPromptReview &&
        !closesUnknownDirectAgent
      ) {
        throw new ApplicationError({
          code: "revision_conflict",
          httpStatus: 409,
          message: "Product Run已结束，不能创建或推进Node Run",
          recoveryAction: "rehydrate_and_retry",
        });
      }
      const created =
        existing ??
        workflowNodeRunSchema.parse(
          createWorkflowNodeRun({
            nodeRun: {
              workflowNodeRunId,
              productRunId: input.productRunId,
              workflowViewDefinitionId: run.workflowViewDefinitionId,
              definitionNodeId: input.definitionNodeId,
              nodeType: node.nodeType,
              nodeSchemaVersion: String(node.schemaVersion),
              executionPath: input.executionPath.map((segment) => ({ ...segment })),
              attemptNumber: input.attemptNumber,
            },
            transitionId: derivedTransitionId(workflowNodeRunId, 1),
            at: now,
            projectionSource: "runtime",
          }).nodeRun,
        );
      if (existing === undefined) {
        const initial = createWorkflowNodeRun({
          nodeRun: {
            workflowNodeRunId,
            productRunId: input.productRunId,
            workflowViewDefinitionId: run.workflowViewDefinitionId,
            definitionNodeId: input.definitionNodeId,
            nodeType: node.nodeType,
            nodeSchemaVersion: String(node.schemaVersion),
            executionPath: input.executionPath.map((segment) => ({ ...segment })),
            attemptNumber: input.attemptNumber,
          },
          transitionId: derivedTransitionId(workflowNodeRunId, 1),
          at: now,
          projectionSource: "runtime",
        });
        draft.entities.workflowNodeRuns[workflowNodeRunId] = workflowNodeRunSchema.parse(
          initial.nodeRun,
        );
        draft.entities.nodeRunTransitions[initial.transition.nodeRunTransitionId] =
          nodeRunTransitionSchema.parse(initial.transition);
      }
      let current = draft.entities.workflowNodeRuns[workflowNodeRunId] ?? created;
      if (
        existing === undefined &&
        (node.nodeType === "human.prompt_review" || node.nodeType === "agent.direct") &&
        input.toStatus === "waiting_human"
      ) {
        // Domain保持通用queued→running→waiting_human状态机；Prompt Review首轮在同一
        // Product事务内补齐内部started证据，外部只能观察到带PRR Hash的waiting_human。
        const started = transitionWorkflowNodeRun(current, {
          transitionId: derivedTransitionId(workflowNodeRunId, 2),
          nodeSequence: 2,
          toStatus: "running",
          reasonKind: "started",
          at: now,
        });
        draft.entities.workflowNodeRuns[workflowNodeRunId] = workflowNodeRunSchema.parse(
          started.nodeRun,
        );
        draft.entities.nodeRunTransitions[started.transition.nodeRunTransitionId] =
          nodeRunTransitionSchema.parse(started.transition);
        current = draft.entities.workflowNodeRuns[workflowNodeRunId] ?? started.nodeRun;
      }
      // Plan/Decision用例会在同一权威事务中先同步S1投影；随后到达的Workflow命令
      // 仍需留下幂等Receipt，但不得为同一目标状态制造重复Transition。
      const nodeSequence =
        Object.values(draft.entities.nodeRunTransitions).filter(
          (transition) => transition.workflowNodeRunId === workflowNodeRunId,
        ).length + 1;
      const relatedProductRef = transitionEvidenceRef(draft, input, current.status, node.nodeType);
      const transitioned = transitionWorkflowNodeRun(current, {
        transitionId: derivedTransitionId(workflowNodeRunId, nodeSequence),
        nodeSequence,
        toStatus: input.toStatus,
        reasonKind: reasonForStatus(input.toStatus, current.status),
        at: now,
        ...(input.outcomeCode !== undefined ? { outcomeCode: input.outcomeCode } : {}),
        ...(input.publicSummary !== undefined ? { publicSummary: input.publicSummary } : {}),
        ...(input.toStatus === "failed" || input.toStatus === "outcome_unknown"
          ? {
              error: {
                code: input.outcomeCode ?? input.toStatus,
                summary: input.publicSummary ?? input.toStatus,
              },
            }
          : {}),
        ...(relatedProductRef !== undefined ? { relatedProductRef } : {}),
      });
      draft.entities.workflowNodeRuns[workflowNodeRunId] = workflowNodeRunSchema.parse(
        transitioned.nodeRun,
      );
      draft.entities.nodeRunTransitions[transitioned.transition.nodeRunTransitionId] =
        nodeRunTransitionSchema.parse(transitioned.transition);
      didTransition = true;
      return { resultRefs: { workflowNodeRunId } };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const node = snapshot.entities.workflowNodeRuns[result.resultRefs["workflowNodeRunId"] ?? ""];
  if (node === undefined) throw notFound("Workflow Node不存在");
  // 同command receipt重放，或新command重复声明相同状态，都没有产生新Transition；
  // 此时重复发射会在DSH轨迹中制造第二条同ID的Memory call/result。
  if (didTransition) emitWorkflowMemoryNodeTrace(deps, snapshot, node);
  return { workflowNodeRunId: node.workflowNodeRunId, revision: node.revision };
}

/**
 * 相同状态不是一张空白幂等支票。Store的commandId只约束同一命令重放；另一个
 * runtime命令若携带不同outcome/summary，必须失败而不能被“已经到达该状态”吞掉。
 */
function assertEquivalentRepeatedTransition(
  existing: {
    readonly outcomeCode?: string | undefined;
    readonly publicSummary?: string | undefined;
    readonly error?: { readonly code: string; readonly summary: string } | undefined;
  },
  input: TransitionConfigurablePlanningNodeInput,
): void {
  const expectedError =
    input.toStatus === "failed" || input.toStatus === "outcome_unknown"
      ? {
          code: input.outcomeCode ?? input.toStatus,
          summary: input.publicSummary ?? input.toStatus,
        }
      : undefined;
  if (
    existing.outcomeCode !== input.outcomeCode ||
    existing.publicSummary !== input.publicSummary ||
    existing.error?.code !== expectedError?.code ||
    existing.error?.summary !== expectedError?.summary
  ) {
    throw new ApplicationError({
      code: "revision_conflict",
      httpStatus: 409,
      message: "Workflow Node已到达同名状态，但终态证据与本次命令不一致",
      recoveryAction: "rehydrate_and_retry",
    });
  }
}

function assertRuntimeNodeCommand(
  runSpec: WorkflowRunSpec,
  node: WorkflowRunSpec["nodeResolutions"][number],
  input: TransitionConfigurablePlanningNodeInput,
): void {
  assertWorkflowNodeExecutionIdentity(runSpec, input);
  if (
    input.toStatus === "waiting_human" &&
    node.nodeType !== "human.plan_review" &&
    node.nodeType !== "human.note_review" &&
    node.nodeType !== "human.prompt_review" &&
    node.nodeType !== "agent.direct"
  ) {
    throw invalidRuntimeTransition("非人工节点不能进入waiting_human");
  }
  if (
    (node.nodeType === "human.plan_review" ||
      node.nodeType === "human.note_review" ||
      node.nodeType === "human.prompt_review") &&
    input.toStatus === "running"
  ) {
    throw invalidRuntimeTransition("人工审核由产品Hook事实直接进入waiting_human");
  }
  if (input.toStatus === "skipped") {
    const expectedSkip = expectedRuntimeSkipOutcome(runSpec, node);
    if (expectedSkip === undefined || input.outcomeCode !== expectedSkip) {
      throw invalidRuntimeTransition("Workflow节点不允许以该outcome跳过");
    }
    return;
  }
  if (node.activation === "skipped") {
    throw invalidRuntimeTransition("冻结为skipped的节点不能执行");
  }
  if (input.toStatus === "succeeded") {
    const outcomes = DEFAULT_NODE_CATALOG.get(node.nodeType, node.schemaVersion)?.outcomes ?? [];
    if (input.outcomeCode === undefined || !outcomes.includes(input.outcomeCode)) {
      throw invalidRuntimeTransition("Workflow节点完成outcome不在冻结Catalog中");
    }
  }
  if (
    node.nodeType === "human.prompt_review" &&
    ((input.toStatus === "succeeded" && input.outcomeCode !== "approved") ||
      (input.toStatus === "cancelled" && input.outcomeCode !== "rejected"))
  ) {
    throw invalidRuntimeTransition("Prompt Review终态与决定outcome不匹配");
  }
  if (
    (input.toStatus === "running" || input.toStatus === "waiting_human") &&
    input.outcomeCode !== undefined
  ) {
    throw invalidRuntimeTransition("非终态Workflow节点不得预写outcome");
  }
}

/**
 * 所有会原子提交业务事实与Node事实的Application命令共享同一执行身份校验。
 * 不能只验证definitionNodeId，否则Loop中的不同iteration会折叠到同一个NodeRun。
 */
export function assertWorkflowNodeExecutionIdentity(
  runSpec: WorkflowRunSpec,
  input: Pick<
    TransitionConfigurablePlanningNodeInput,
    "definitionNodeId" | "executionPath" | "attemptNumber"
  >,
): void {
  if (input.attemptNumber !== 1) {
    throw invalidRuntimeTransition("显式Retry尚未创建，attemptNumber只能为1");
  }
  const pathSpec = findNodeExecutionPathSpec(runSpec, input.definitionNodeId);
  if (pathSpec === undefined || pathSpec.length !== input.executionPath.length) {
    throw invalidRuntimeTransition("Workflow节点executionPath与RunSpec不一致");
  }
  for (let index = 0; index < pathSpec.length; index += 1) {
    const expected = pathSpec[index];
    const actual = input.executionPath[index];
    if (
      expected === undefined ||
      actual === undefined ||
      actual.containerNodeId !== expected.containerNodeId ||
      actual.iteration < 1 ||
      actual.iteration > expected.maxIterations
    ) {
      throw invalidRuntimeTransition("Workflow节点executionPath与RunSpec不一致");
    }
  }
}

interface LoopPathSpec {
  readonly containerNodeId: string;
  readonly maxIterations: number;
}

function findNodeExecutionPathSpec(
  runSpec: WorkflowRunSpec,
  definitionNodeId: string,
): readonly LoopPathSpec[] | undefined {
  const stack: {
    readonly sequence: WorkflowRunSpec["semanticRoot"];
    readonly path: readonly LoopPathSpec[];
  }[] = [{ sequence: runSpec.semanticRoot, path: [] }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    for (let index = frame.sequence.elements.length - 1; index >= 0; index -= 1) {
      const element = frame.sequence.elements[index];
      if (element === undefined) continue;
      if (element.kind === "task" || element.kind === "composite") {
        if (element.definitionNodeId === definitionNodeId) return frame.path;
      } else if (element.kind === "sequence") {
        stack.push({ sequence: element, path: frame.path });
      } else if (element.kind === "choice") {
        for (let branchIndex = element.branches.length - 1; branchIndex >= 0; branchIndex -= 1) {
          const branch = element.branches[branchIndex];
          if (branch !== undefined) stack.push({ sequence: branch.body, path: frame.path });
        }
      } else {
        stack.push({
          sequence: element.body,
          path: [
            ...frame.path,
            {
              containerNodeId: `${element.outcomeFromDefinitionNodeId}.loop`,
              maxIterations: element.maxIterations,
            },
          ],
        });
      }
    }
  }
  return undefined;
}

function expectedRuntimeSkipOutcome(
  runSpec: WorkflowRunSpec,
  node: WorkflowRunSpec["nodeResolutions"][number],
): string | undefined {
  if (node.activation === "skipped") return node.skipOutcome;
  if (node.nodeType === "agent.research") return "no_evidence";
  const resourceKind =
    node.nodeType === "context.memory"
      ? "memory"
      : node.nodeType === "context.project"
        ? "project"
        : node.nodeType === "policy.rules"
          ? "rule"
          : node.nodeType === "capability.skills"
            ? "skill"
            : undefined;
  if (resourceKind === undefined) return undefined;
  const resources = runSpec.resourceResolutions.filter(
    (resource) =>
      resource.definitionNodeId === node.definitionNodeId && resource.resourceKind === resourceKind,
  );
  return resources.length > 0 &&
    resources.every(
      (resource) =>
        resource.resolution === "excluded" && resource.exclusionReason === "not_selected",
    )
    ? "optional_unavailable"
    : undefined;
}

function invalidRuntimeTransition(message: string): ApplicationError {
  return new ApplicationError({ code: "validation_failed", httpStatus: 422, message });
}

function derivedWorkflowNodeRunId(input: {
  readonly productRunId: ProductRunId;
  readonly definitionNodeId: string;
  readonly executionPath: readonly {
    readonly containerNodeId: string;
    readonly iteration: number;
  }[];
  readonly attemptNumber: number;
}): string {
  return `wnr_${workflowNodeRunIdentityKey(input).slice(0, 32)}`;
}

function derivedTransitionId(workflowNodeRunId: string, sequence: number): string {
  return `wnt_${hashCanonical("id.node-transition.v1", { workflowNodeRunId, sequence }).slice(0, 32)}`;
}

function reasonForStatus(
  status: TransitionConfigurablePlanningNodeInput["toStatus"],
  currentStatus: WorkflowNodeRunStatus,
) {
  if (status === "running") return currentStatus === "waiting_human" ? "resumed" : "started";
  if (status === "waiting_human") return "waiting_human" as const;
  if (status === "succeeded") return "completed" as const;
  if (status === "skipped") return "skipped" as const;
  if (status === "failed") return "failed" as const;
  if (status === "cancelled") return "cancelled" as const;
  return "outcome_unknown" as const;
}

function transitionEvidenceRef(
  draft: Parameters<Parameters<ApplicationDeps["store"]["transact"]>[0]["mutate"]>[0],
  input: TransitionConfigurablePlanningNodeInput,
  currentStatus: WorkflowNodeRunStatus,
  nodeType: WorkflowRunSpec["nodeResolutions"][number]["nodeType"],
): NodeProductRef | undefined {
  if (input.toStatus === "waiting_human") {
    if (nodeType === "human.prompt_review" || nodeType === "agent.direct") {
      const run = draft.entities.runs[input.productRunId];
      const review =
        run?.runKind === "direct_agent" && run.currentPromptReviewRequestId !== undefined
          ? draft.entities.promptReviewRequests[run.currentPromptReviewRequestId]
          : undefined;
      if (
        review === undefined ||
        review.productRunId !== input.productRunId ||
        review.status !== "open"
      ) {
        throw invalidRuntimeTransition("Prompt Review等待节点缺少当前open Request");
      }
      const recomputedReviewSha256 = computePromptReviewSha256({
        promptReviewRequestId: review.promptReviewRequestId,
        productRunId: review.productRunId,
        directAgentAttemptId: review.directAgentAttemptId,
        requestIndex: review.requestIndex,
        requestKind: review.requestKind,
        providerId: review.providerId,
        modelId: review.modelId,
        endpointHost: review.endpointHost,
        requestRevision: review.requestRevision,
        payloadSha256: review.payloadSha256,
        rendererVersion: review.rendererVersion,
      });
      if (recomputedReviewSha256 !== review.reviewSha256) {
        throw invalidRuntimeTransition("Prompt Review Request Hash已漂移");
      }
      return {
        kind: "prompt_review_request",
        id: review.promptReviewRequestId,
        revision: review.requestRevision,
        sha256: review.reviewSha256,
        label: `提示词审核 #${String(review.requestIndex)}`,
      };
    }
    const approval = Object.values(draft.entities.approvalRequests)
      .filter((candidate) => candidate.productRunId === input.productRunId)
      .sort((left, right) => right.planRevision - left.planRevision)[0];
    if (approval === undefined || approval.status !== "open") return undefined;
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
  if (
    (nodeType === "human.prompt_review" || nodeType === "agent.direct") &&
    currentStatus === "waiting_human" &&
    (input.toStatus === "running" ||
      input.toStatus === "succeeded" ||
      input.toStatus === "cancelled")
  ) {
    const review = Object.values(draft.entities.promptReviewRequests)
      .filter((candidate) => candidate.productRunId === input.productRunId)
      .sort((left, right) => right.requestIndex - left.requestIndex)[0];
    const decision =
      review?.decidedByPromptReviewDecisionId === undefined
        ? undefined
        : draft.entities.promptReviewDecisions[review.decidedByPromptReviewDecisionId];
    const expectedKind = input.toStatus === "cancelled" ? "reject" : "approve";
    const expectedReviewStatus = expectedKind === "approve" ? "approved" : "rejected";
    if (
      review === undefined ||
      decision === undefined ||
      review.status !== expectedReviewStatus ||
      decision.kind !== expectedKind ||
      decision.productRunId !== input.productRunId ||
      decision.promptReviewRequestId !== review.promptReviewRequestId ||
      decision.requestRevision !== review.requestRevision ||
      decision.reviewSha256 !== review.reviewSha256 ||
      decision.payloadSha256 !== review.payloadSha256
    ) {
      throw invalidRuntimeTransition("Prompt Review Decision绑定或Hash已漂移");
    }
    return {
      kind: "prompt_review_decision",
      id: decision.promptReviewDecisionId,
      revision: decision.revision,
      sha256: computePromptReviewDecisionSha256({
        promptReviewDecisionId: decision.promptReviewDecisionId,
        promptReviewRequestId: decision.promptReviewRequestId,
        productRunId: decision.productRunId,
        requestRevision: decision.requestRevision,
        reviewSha256: decision.reviewSha256,
        payloadSha256: decision.payloadSha256,
        kind: decision.kind,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        principalId: decision.principalId,
        commandId: decision.commandId,
      }),
      label: decision.kind === "approve" ? "提示词已批准" : "提示词已拒绝",
    };
  }
  if (currentStatus !== "waiting_human" || input.toStatus !== "succeeded") {
    return undefined;
  }
  const decision = Object.values(draft.entities.decisions)
    .filter((candidate) => candidate.productRunId === input.productRunId)
    .sort((left, right) => right.planRevision - left.planRevision)[0];
  if (decision === undefined) return undefined;
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
