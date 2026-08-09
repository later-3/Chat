import { DomainInvariantError, hashCanonical, nextPlanRevision } from "@chat/domain";
import {
  B2_PLANNER_TOKEN_BUDGET,
  MODEL_CONFIG_VERSION,
  PLANNER_PROMPT_TEMPLATE_VERSION,
  type CommandId,
  type LoadCommittedDecisionResponse,
  type PlanningInputDto,
  type ProductRunId,
  type CompilePlanningInputRequest,
} from "@chat/contracts";
import { type ApplicationDeps } from "./deps.js";
import { notFound, revisionConflict } from "./errors.js";
import { emitRunEvent } from "./trace-helpers.js";
import { synchronizePlanningWorkflowProjection } from "./planning-workflow-projection.js";

/**
 * Workflow私有Application Command：compilePlanningInput / loadCommittedDecision。
 *
 * 边界：Workflow Step只携带产品引用与稳定commandId；本用例负责读取已提交
 * 产品事实并编译本轮规划输入。模型只看到编译结果，不直接读Product Store。
 */

export const PLANNER_LIMITS = {
  maxTurns: 1,
  timeoutMs: 120_000,
  tokenBudget: B2_PLANNER_TOKEN_BUDGET,
} as const;

export interface CompilePlanningInputCommand {
  readonly commandId: CommandId;
  readonly productRunId: ProductRunId;
  readonly planRevision: number;
  readonly contextPackageRef?: CompilePlanningInputRequest["contextPackageRef"] | undefined;
}

function messageSha256(message: {
  messageId: string;
  sessionId: string;
  sessionSequence: number;
  role: string;
  content: { format: "markdown"; text: string };
}): string {
  return hashCanonical("message.v1", {
    messageId: message.messageId,
    sessionId: message.sessionId,
    sessionSequence: message.sessionSequence,
    role: message.role,
    content: message.content,
  });
}

export async function compilePlanningInput(
  deps: ApplicationDeps,
  input: CompilePlanningInputCommand,
): Promise<PlanningInputDto> {
  const now = deps.now();
  const attemptId = deps.ids.attempt();
  const requestSha256 = hashCanonical("command.compile-planning-input.v1", {
    productRunId: input.productRunId,
    planRevision: input.planRevision,
    ...(input.contextPackageRef !== undefined
      ? { contextPackageRef: input.contextPackageRef }
      : {}),
  });

  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CompilePlanningInput",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const run = draft.entities.runs[input.productRunId];
      if (run === undefined) throw notFound("Product Run不存在");
      const message = draft.entities.messages[run.sourceMessageId];
      if (message === undefined) throw notFound("源消息不存在");
      const contextRequest = Object.values(draft.entities.contextRequests).find(
        (candidate) => candidate.productRunId === input.productRunId,
      );
      const contextPackage =
        input.contextPackageRef === undefined
          ? undefined
          : draft.entities.contextPackages[input.contextPackageRef.contextPackageId];
      if (contextRequest?.memory !== undefined) {
        if (
          contextPackage === undefined ||
          contextPackage.productRunId !== input.productRunId ||
          contextPackage.contextRequestId !== contextRequest.contextRequestId ||
          contextPackage.revision !== input.contextPackageRef?.revision ||
          contextPackage.sha256 !== input.contextPackageRef?.sha256
        ) {
          throw revisionConflict("Memory选择缺少已冻结的ContextPackage");
        }
      } else if (contextPackage !== undefined) {
        throw revisionConflict("本轮没有Memory选择，不允许附加ContextPackage");
      }

      const existingPlans = Object.values(draft.entities.plans)
        .filter((plan) => plan.productRunId === input.productRunId)
        .sort((a, b) => a.planRevision - b.planRevision);
      let expectedNext: number;
      try {
        expectedNext = nextPlanRevision(
          existingPlans.map((plan) => plan.planRevision),
          run.maxPlanRevisions,
        );
      } catch (error) {
        if (error instanceof DomainInvariantError && error.code === "plan_revision_limit_reached") {
          throw revisionConflict(error.message);
        }
        throw error;
      }
      if (expectedNext !== input.planRevision) {
        throw revisionConflict(
          `请求编译的planRevision ${String(input.planRevision)}与产品事实期望的${String(expectedNext)}不一致`,
        );
      }
      const priorPlan = existingPlans[existingPlans.length - 1];
      if (priorPlan !== undefined && priorPlan.status === "under_review") {
        throw revisionConflict("存在仍在审核中的Plan，不能编译下一轮规划输入");
      }
      const revisionInput =
        priorPlan === undefined
          ? undefined
          : Object.values(draft.entities.revisionInputs)
              .filter(
                (candidate) =>
                  candidate.planId === priorPlan.planId &&
                  candidate.planRevision === priorPlan.planRevision &&
                  candidate.productRunId === input.productRunId,
              )
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (input.planRevision > 1 && revisionInput === undefined) {
        throw revisionConflict("修订规划缺少已提交Revision Input");
      }
      if (priorPlan !== undefined) {
        const priorAttempt = draft.entities.attempts[priorPlan.planningAttemptId];
        if (
          priorAttempt?.contextPackageId !== input.contextPackageRef?.contextPackageId ||
          priorAttempt?.contextPackageSha256 !== input.contextPackageRef?.sha256
        ) {
          throw revisionConflict("M1规划修订必须复用上一版ContextPackage");
        }
      }

      const sourceMessageSha256 = messageSha256(message);
      const inputManifestSha256 = hashCanonical(
        contextPackage === undefined ? "planning-input-manifest.v1" : "planning-input-manifest.v2",
        {
          productRunId: input.productRunId,
          planRevision: input.planRevision,
          sourceMessageRef: { messageId: message.messageId, sha256: sourceMessageSha256 },
          ...(priorPlan !== undefined
            ? {
                priorPlanRef: {
                  planRevisionId: priorPlan.planRevisionId,
                  planId: priorPlan.planId,
                  planRevision: priorPlan.planRevision,
                  sha256: priorPlan.sha256,
                },
              }
            : {}),
          ...(revisionInput !== undefined
            ? { revisionInputRef: { revisionInputId: revisionInput.revisionInputId } }
            : {}),
          ...(contextPackage !== undefined
            ? {
                contextPackageRef: {
                  contextPackageId: contextPackage.contextPackageId,
                  revision: contextPackage.revision,
                  sha256: contextPackage.sha256,
                },
              }
            : {}),
          promptTemplateVersion: PLANNER_PROMPT_TEMPLATE_VERSION,
          modelConfigVersion: MODEL_CONFIG_VERSION,
        },
      );

      // 生命周期：首次规划从pending/queued进入running/planning；修改循环保持在running/planning
      if (run.status === "pending" && run.phase === "queued") {
        draft.entities.runs[input.productRunId] = {
          ...run,
          status: "running",
          phase: "planning",
          revision: run.revision + 1,
          updatedAt: now,
        };
      } else if (run.status !== "running" || run.phase !== "planning") {
        throw revisionConflict(`Run状态${run.status}/${run.phase}不允许编译规划输入`);
      }

      const inputRunRevision = run.status === "pending" ? run.revision + 1 : run.revision;

      draft.entities.attempts[attemptId] = {
        schemaVersion: "run-attempt.v1",
        attemptId,
        productRunId: input.productRunId,
        kind: "planning",
        planRevision: input.planRevision,
        inputRunRevision,
        sourceMessageSha256,
        ...(priorPlan !== undefined ? { priorPlanRevisionId: priorPlan.planRevisionId } : {}),
        ...(revisionInput !== undefined ? { revisionInputId: revisionInput.revisionInputId } : {}),
        inputManifestSha256,
        promptTemplateVersion: PLANNER_PROMPT_TEMPLATE_VERSION,
        modelConfigVersion: MODEL_CONFIG_VERSION,
        ...(contextPackage !== undefined
          ? {
              contextPackageId: contextPackage.contextPackageId,
              contextPackageSha256: contextPackage.sha256,
            }
          : {}),
        outcome: "running",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      synchronizePlanningWorkflowProjection(draft, input.productRunId, now);
      return { resultRefs: { attemptId, productRunId: input.productRunId } };
    },
  });

  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const run = snapshot.entities.runs[input.productRunId];
  if (run === undefined) throw notFound("Product Run不存在");
  const committedAttemptId = result.resultRefs["attemptId"] ?? "";
  const attempt = snapshot.entities.attempts[committedAttemptId];
  if (attempt === undefined) throw notFound("Run Attempt不存在");

  const message = snapshot.entities.messages[run.sourceMessageId];
  if (message === undefined) throw notFound("源消息不存在");
  const priorPlan =
    attempt.priorPlanRevisionId === undefined
      ? undefined
      : snapshot.entities.plans[attempt.priorPlanRevisionId];
  const revisionInput =
    attempt.revisionInputId === undefined
      ? undefined
      : snapshot.entities.revisionInputs[attempt.revisionInputId];
  const contextPackage =
    attempt.contextPackageId === undefined
      ? undefined
      : snapshot.entities.contextPackages[attempt.contextPackageId];
  if (
    attempt.inputRunRevision === undefined ||
    attempt.sourceMessageSha256 === undefined ||
    attempt.inputManifestSha256 === undefined ||
    attempt.promptTemplateVersion === undefined ||
    attempt.modelConfigVersion === undefined
  ) {
    throw revisionConflict("Planning Attempt缺少冻结输入证据");
  }
  if (attempt.priorPlanRevisionId !== undefined && priorPlan === undefined) {
    throw revisionConflict("Planning Attempt引用的上一版Plan不存在");
  }
  if (attempt.revisionInputId !== undefined && revisionInput === undefined) {
    throw revisionConflict("Planning Attempt引用的Revision Input不存在");
  }
  if (
    attempt.contextPackageId !== undefined &&
    (contextPackage === undefined || contextPackage.sha256 !== attempt.contextPackageSha256)
  ) {
    throw revisionConflict("Planning Attempt引用的ContextPackage不存在或Hash不一致");
  }

  if (
    !result.replayed &&
    run.status === "running" &&
    run.phase === "planning" &&
    input.planRevision === 1
  ) {
    emitRunEvent(deps, input.productRunId, {
      level: "info",
      eventName: "product_run.transitioned",
      outcome: "success",
      productRunId: input.productRunId,
      fromStatus: "pending",
      toStatus: "running",
      fromPhase: "queued",
      toPhase: "planning",
      revision: run.revision,
    });
  }

  return {
    schemaVersion: "chat-internal-runtime.v1",
    productRunId: input.productRunId,
    attemptId: attempt.attemptId,
    inputRunRevision: attempt.inputRunRevision,
    inputManifestSha256: attempt.inputManifestSha256,
    sourceMessageRef: {
      messageId: message.messageId,
      sha256: attempt.sourceMessageSha256,
    },
    sourceMessageText: message.content.text,
    ...(priorPlan !== undefined
      ? {
          priorPlan: {
            planId: priorPlan.planId,
            planRevision: priorPlan.planRevision,
            sha256: priorPlan.sha256,
            content: priorPlan.content,
          },
        }
      : {}),
    ...(revisionInput !== undefined ? { revisionInstruction: revisionInput.instruction } : {}),
    ...(contextPackage !== undefined
      ? {
          contextPackage: {
            ref: {
              contextPackageId: contextPackage.contextPackageId,
              revision: contextPackage.revision,
              sha256: contextPackage.sha256,
            },
            memory: {
              backendId:
                snapshot.entities.memoryQueries[contextPackage.memoryQueryId]?.backendId ?? "",
              items: contextPackage.items.map((item) => {
                const memorySnapshot =
                  snapshot.entities.memoryResultSnapshots[item.memoryResultSnapshotId];
                if (memorySnapshot === undefined) {
                  throw revisionConflict("ContextPackage引用的Memory Snapshot不存在");
                }
                return {
                  refId: memorySnapshot.memoryResultSnapshotId,
                  revision: memorySnapshot.revision,
                  sha256: memorySnapshot.sha256,
                  title: memorySnapshot.title,
                  kind: memorySnapshot.kind,
                  memoryLayer: memorySnapshot.memoryLayer,
                  content: memorySnapshot.content,
                  tags: memorySnapshot.tags,
                };
              }),
              exclusions: contextPackage.exclusions.map((exclusion) => ({
                backendId: exclusion.backendId,
                reasonCode: exclusion.reasonCode,
              })),
            },
          },
        }
      : {}),
    planRevision: input.planRevision,
    limits: { ...PLANNER_LIMITS },
    promptTemplateVersion: attempt.promptTemplateVersion,
    modelConfigVersion: attempt.modelConfigVersion,
  };
}

export interface LoadCommittedDecisionCommand {
  readonly productRunId: ProductRunId;
  readonly decisionId: LoadCommittedDecisionResponse["decisionId"];
  readonly expectedPlanId: string;
  readonly expectedPlanRevision: number;
  readonly expectedPlanSha256: string;
}

/**
 * Workflow恢复后重新读取产品Decision并复核绑定关系；
 * Hook Payload只是信号，产品事实才是决定依据。
 */
export async function loadCommittedDecision(
  deps: ApplicationDeps,
  input: LoadCommittedDecisionCommand,
): Promise<LoadCommittedDecisionResponse> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const run = snapshot.entities.runs[input.productRunId];
  if (run === undefined) throw notFound("Product Run不存在");
  const decision = snapshot.entities.decisions[input.decisionId];
  if (decision === undefined || decision.productRunId !== input.productRunId) {
    throw notFound("Decision不存在");
  }
  if (
    decision.planId !== input.expectedPlanId ||
    decision.planRevision !== input.expectedPlanRevision
  ) {
    throw revisionConflict("Decision绑定的Plan revision与Workflow期望不一致");
  }
  if (decision.planSha256 !== input.expectedPlanSha256) {
    throw revisionConflict("Decision绑定的Plan Hash与Workflow期望不一致");
  }
  const approval = snapshot.entities.approvalRequests[decision.approvalRequestId];
  if (approval === undefined || approval.decidedByDecisionId !== decision.decisionId) {
    throw revisionConflict("Decision与Approval Request的绑定关系不完整");
  }
  const revisionInput =
    decision.revisionInputId !== undefined
      ? snapshot.entities.revisionInputs[decision.revisionInputId]
      : undefined;
  return {
    schemaVersion: "chat-internal-runtime.v1",
    decisionId: decision.decisionId,
    kind: decision.kind,
    ...(decision.revisionInputId !== undefined
      ? { revisionInputId: decision.revisionInputId }
      : {}),
    ...(revisionInput !== undefined ? { revisionInstruction: revisionInput.instruction } : {}),
    principalId: decision.principalId,
  };
}
