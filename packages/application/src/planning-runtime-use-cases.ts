import {
  DomainInvariantError,
  computePlanningInputManifestSha256,
  hashCanonical,
  nextPlanRevision,
} from "@chat/domain";
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
import { requirePlanningRun } from "./product-run-kind.js";
import { workflowNodePromptFor } from "./prompt-assembly-use-cases.js";

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
  readonly planningMemorySelectionRef?:
    CompilePlanningInputRequest["planningMemorySelectionRef"] | undefined;
  readonly workflowMemoryContextRef?: CompilePlanningInputRequest["workflowMemoryContextRef"];
  readonly planningProjectContextRef?:
    CompilePlanningInputRequest["planningProjectContextRef"] | undefined;
  readonly ruleSelectionRef?: CompilePlanningInputRequest["ruleSelectionRef"] | undefined;
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
    ...(input.planningMemorySelectionRef !== undefined
      ? { planningMemorySelectionRef: input.planningMemorySelectionRef }
      : {}),
    ...(input.workflowMemoryContextRef !== undefined
      ? { workflowMemoryContextRef: input.workflowMemoryContextRef }
      : {}),
    ...(input.planningProjectContextRef !== undefined
      ? { planningProjectContextRef: input.planningProjectContextRef }
      : {}),
    ...(input.ruleSelectionRef !== undefined ? { ruleSelectionRef: input.ruleSelectionRef } : {}),
  });

  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CompilePlanningInput",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const run = draft.entities.runs[input.productRunId];
      if (run === undefined) throw notFound("Product Run不存在");
      const planningRun = requirePlanningRun(run);
      const message = draft.entities.messages[planningRun.sourceMessageId];
      if (message === undefined) throw notFound("源消息不存在");
      const contextRequest = Object.values(draft.entities.contextRequests).find(
        (candidate) => candidate.productRunId === input.productRunId,
      );
      const contextPackage =
        input.contextPackageRef === undefined
          ? undefined
          : draft.entities.contextPackages[input.contextPackageRef.contextPackageId];
      if (input.contextPackageRef !== undefined && input.planningMemorySelectionRef !== undefined) {
        throw revisionConflict("查询Memory与显式Memory Selection不能同时编译");
      }
      const memorySelectionsForRun = Object.values(draft.entities.planningMemorySelections).filter(
        (candidate) => candidate.productRunId === input.productRunId,
      );
      if (memorySelectionsForRun.length > 1) {
        throw revisionConflict("同一Planning Run存在多个Memory Selection");
      }
      const memorySelection =
        input.planningMemorySelectionRef === undefined
          ? undefined
          : draft.entities.planningMemorySelections[
              input.planningMemorySelectionRef.planningMemorySelectionId
            ];
      if (input.planningMemorySelectionRef === undefined) {
        if (memorySelectionsForRun.length > 0) {
          throw revisionConflict("Planning Input遗漏已冻结的Memory Selection");
        }
      } else {
        const runSpec =
          planningRun.workflowRunSpecId === undefined
            ? undefined
            : draft.entities.workflowRunSpecs[planningRun.workflowRunSpecId];
        if (
          memorySelection === undefined ||
          memorySelection.productRunId !== input.productRunId ||
          memorySelection.revision !== input.planningMemorySelectionRef.revision ||
          memorySelection.sha256 !== input.planningMemorySelectionRef.sha256 ||
          memorySelectionsForRun[0]?.planningMemorySelectionId !==
            memorySelection.planningMemorySelectionId ||
          runSpec === undefined ||
          memorySelection.workflowRunSpecId !== runSpec.workflowRunSpecId ||
          memorySelection.workflowRunSpecSha256 !== runSpec.sha256
        ) {
          throw revisionConflict("Planning Memory Selection引用不存在或Hash不一致");
        }
        for (const selected of memorySelection.selected) {
          const memory = draft.entities.memoryResultSnapshots[selected.memoryResultSnapshotId];
          if (
            memory === undefined ||
            memory.revision !== selected.revision ||
            memory.sha256 !== selected.sha256
          ) {
            throw revisionConflict("Planning Memory Selection引用的Snapshot已损坏");
          }
        }
      }
      if (memorySelection !== undefined && contextPackage !== undefined) {
        throw revisionConflict("显式Memory Selection不能附加查询ContextPackage");
      }

      const workflowMemoryContextsForRun = Object.values(
        draft.entities.workflowMemoryContexts,
      ).filter((candidate) => candidate.productRunId === input.productRunId);
      if (workflowMemoryContextsForRun.length > 1) {
        throw revisionConflict("同一Planning Run存在多个Workflow Memory Context");
      }
      const workflowMemoryContext =
        input.workflowMemoryContextRef === undefined
          ? undefined
          : draft.entities.workflowMemoryContexts[
              input.workflowMemoryContextRef.workflowMemoryContextId
            ];
      if (input.workflowMemoryContextRef === undefined) {
        if (workflowMemoryContextsForRun.length > 0) {
          throw revisionConflict("Planning Input遗漏已冻结的Workflow Memory Context");
        }
      } else if (
        workflowMemoryContext === undefined ||
        workflowMemoryContext.productRunId !== input.productRunId ||
        workflowMemoryContext.revision !== input.workflowMemoryContextRef.revision ||
        workflowMemoryContext.sha256 !== input.workflowMemoryContextRef.sha256 ||
        workflowMemoryContextsForRun[0]?.workflowMemoryContextId !==
          workflowMemoryContext.workflowMemoryContextId ||
        workflowMemoryContext.workflowRunSpecId !== planningRun.workflowRunSpecId
      ) {
        throw revisionConflict("Workflow Memory Context引用不存在或Hash不一致");
      }
      if (memorySelection === undefined && contextRequest?.memory !== undefined) {
        if (
          contextPackage === undefined ||
          contextPackage.productRunId !== input.productRunId ||
          contextPackage.contextRequestId !== contextRequest.contextRequestId ||
          contextPackage.revision !== input.contextPackageRef?.revision ||
          contextPackage.sha256 !== input.contextPackageRef?.sha256
        ) {
          throw revisionConflict("Memory选择缺少已冻结的ContextPackage");
        }
      } else if (memorySelection === undefined && contextPackage !== undefined) {
        throw revisionConflict("本轮没有Memory选择，不允许附加ContextPackage");
      }

      const projectContextsForRun = Object.values(draft.entities.planningProjectContexts).filter(
        (candidate) => candidate.productRunId === input.productRunId,
      );
      if (projectContextsForRun.length > 1) {
        throw revisionConflict("同一Planning Run存在多个Project Context");
      }
      const projectContext =
        input.planningProjectContextRef === undefined
          ? undefined
          : draft.entities.planningProjectContexts[
              input.planningProjectContextRef.planningProjectContextId
            ];
      if (input.planningProjectContextRef === undefined) {
        if (projectContextsForRun.length > 0) {
          throw revisionConflict("Planning Input遗漏已冻结的Project Context");
        }
      } else if (
        projectContext === undefined ||
        projectContext.productRunId !== input.productRunId ||
        projectContext.revision !== input.planningProjectContextRef.revision ||
        projectContext.sha256 !== input.planningProjectContextRef.sha256 ||
        projectContextsForRun[0]?.planningProjectContextId !==
          projectContext.planningProjectContextId
      ) {
        throw revisionConflict("Planning Project Context引用不存在或Hash不一致");
      }

      const ruleSelectionsForRun = Object.values(draft.entities.ruleSelections).filter(
        (candidate) => candidate.productRunId === input.productRunId,
      );
      if (ruleSelectionsForRun.length > 1) {
        throw revisionConflict("同一Planning Run存在多个Rule Selection");
      }
      const ruleSelection =
        input.ruleSelectionRef === undefined
          ? undefined
          : draft.entities.ruleSelections[input.ruleSelectionRef.ruleSelectionId];
      if (input.ruleSelectionRef === undefined) {
        if (ruleSelectionsForRun.length > 0) {
          throw revisionConflict("Planning Input遗漏已冻结的Rule Selection");
        }
      } else if (
        ruleSelection === undefined ||
        ruleSelection.productRunId !== input.productRunId ||
        input.ruleSelectionRef.revision !== 1 ||
        ruleSelection.sha256 !== input.ruleSelectionRef.sha256 ||
        ruleSelection.status !== "ready" ||
        ruleSelectionsForRun[0]?.ruleSelectionId !== ruleSelection.ruleSelectionId
      ) {
        throw revisionConflict("Rule Selection引用不存在、未就绪或Hash不一致");
      }

      const existingPlans = Object.values(draft.entities.plans)
        .filter((plan) => plan.productRunId === input.productRunId)
        .sort((a, b) => a.planRevision - b.planRevision);
      let expectedNext: number;
      try {
        expectedNext = nextPlanRevision(
          existingPlans.map((plan) => plan.planRevision),
          planningRun.maxPlanRevisions,
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
          priorAttempt?.contextPackageSha256 !== input.contextPackageRef?.sha256 ||
          priorAttempt?.planningMemorySelectionId !==
            input.planningMemorySelectionRef?.planningMemorySelectionId ||
          priorAttempt?.planningMemorySelectionSha256 !==
            input.planningMemorySelectionRef?.sha256 ||
          priorAttempt?.workflowMemoryContextId !==
            input.workflowMemoryContextRef?.workflowMemoryContextId ||
          priorAttempt?.workflowMemoryContextSha256 !== input.workflowMemoryContextRef?.sha256 ||
          priorAttempt?.planningProjectContextId !==
            input.planningProjectContextRef?.planningProjectContextId ||
          priorAttempt?.planningProjectContextSha256 !== input.planningProjectContextRef?.sha256 ||
          priorAttempt?.ruleSelectionId !== input.ruleSelectionRef?.ruleSelectionId ||
          priorAttempt?.ruleSelectionSha256 !== input.ruleSelectionRef?.sha256
        ) {
          throw revisionConflict("规划修订必须复用上一版全部冻结Context");
        }
      }

      const sourceMessageSha256 = messageSha256(message);
      const nodePrompt = workflowNodePromptFor(draft, input.productRunId, "agent.plan");
      const inputManifestSha256 = computePlanningInputManifestSha256({
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
        ...(contextRequest?.schemaVersion === "run-context-request.v2"
          ? {
              workspaceInstructionsRef: {
                contextRequestId: contextRequest.contextRequestId,
                revision: 1 as const,
                sha256: contextRequest.workspaceInstructions.sha256,
              },
            }
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
        ...(memorySelection !== undefined
          ? {
              planningMemorySelectionRef: {
                planningMemorySelectionId: memorySelection.planningMemorySelectionId,
                revision: memorySelection.revision,
                sha256: memorySelection.sha256,
              },
            }
          : {}),
        ...(workflowMemoryContext !== undefined
          ? {
              workflowMemoryContextRef: {
                workflowMemoryContextId: workflowMemoryContext.workflowMemoryContextId,
                revision: workflowMemoryContext.revision,
                sha256: workflowMemoryContext.sha256,
              },
            }
          : {}),
        ...(projectContext !== undefined
          ? {
              planningProjectContextRef: {
                planningProjectContextId: projectContext.planningProjectContextId,
                revision: projectContext.revision,
                sha256: projectContext.sha256,
              },
            }
          : {}),
        ...(ruleSelection !== undefined
          ? {
              ruleSelectionRef: {
                ruleSelectionId: ruleSelection.ruleSelectionId,
                revision: 1,
                sha256: ruleSelection.sha256,
              },
            }
          : {}),
        ...(nodePrompt === undefined
          ? {}
          : {
              promptAssemblyRef: {
                promptAssemblyId: nodePrompt.promptAssemblyId,
                sha256: nodePrompt.promptAssemblySha256,
                definitionNodeId: nodePrompt.definitionNodeId,
                nodeAssemblySha256: nodePrompt.nodeAssemblySha256,
              },
            }),
        promptTemplateVersion: PLANNER_PROMPT_TEMPLATE_VERSION,
        modelConfigVersion: MODEL_CONFIG_VERSION,
      });

      // 生命周期：首次规划从pending/queued进入running/planning；修改循环保持在running/planning
      if (planningRun.status === "pending" && planningRun.phase === "queued") {
        draft.entities.runs[input.productRunId] = {
          ...planningRun,
          status: "running",
          phase: "planning",
          revision: planningRun.revision + 1,
          updatedAt: now,
        };
      } else if (planningRun.status !== "running" || planningRun.phase !== "planning") {
        throw revisionConflict(
          `Run状态${planningRun.status}/${planningRun.phase}不允许编译规划输入`,
        );
      }

      const inputRunRevision =
        planningRun.status === "pending" ? planningRun.revision + 1 : planningRun.revision;

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
        ...(memorySelection !== undefined
          ? {
              planningMemorySelectionId: memorySelection.planningMemorySelectionId,
              planningMemorySelectionSha256: memorySelection.sha256,
            }
          : {}),
        ...(workflowMemoryContext !== undefined
          ? {
              workflowMemoryContextId: workflowMemoryContext.workflowMemoryContextId,
              workflowMemoryContextSha256: workflowMemoryContext.sha256,
            }
          : {}),
        ...(projectContext !== undefined
          ? {
              planningProjectContextId: projectContext.planningProjectContextId,
              planningProjectContextSha256: projectContext.sha256,
            }
          : {}),
        ...(ruleSelection !== undefined
          ? {
              ruleSelectionId: ruleSelection.ruleSelectionId,
              ruleSelectionSha256: ruleSelection.sha256,
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
  const nodePrompt = workflowNodePromptFor(snapshot, input.productRunId, "agent.plan");
  const contextRequest = Object.values(snapshot.entities.contextRequests).find(
    (candidate) => candidate.productRunId === input.productRunId,
  );
  if (contextRequest === undefined) throw notFound("Context Request不存在");
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
  const memorySelection =
    attempt.planningMemorySelectionId === undefined
      ? undefined
      : snapshot.entities.planningMemorySelections[attempt.planningMemorySelectionId];
  const workflowMemoryContext =
    attempt.workflowMemoryContextId === undefined
      ? undefined
      : snapshot.entities.workflowMemoryContexts[attempt.workflowMemoryContextId];
  const projectContext =
    attempt.planningProjectContextId === undefined
      ? undefined
      : snapshot.entities.planningProjectContexts[attempt.planningProjectContextId];
  const ruleSelection =
    attempt.ruleSelectionId === undefined
      ? undefined
      : snapshot.entities.ruleSelections[attempt.ruleSelectionId];
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
    attempt.planningMemorySelectionId !== undefined &&
    (memorySelection === undefined ||
      memorySelection.productRunId !== input.productRunId ||
      memorySelection.sha256 !== attempt.planningMemorySelectionSha256)
  ) {
    throw revisionConflict("Planning Attempt引用的Memory Selection不存在或Hash不一致");
  }
  if (
    attempt.workflowMemoryContextId !== undefined &&
    (workflowMemoryContext === undefined ||
      workflowMemoryContext.productRunId !== input.productRunId ||
      workflowMemoryContext.sha256 !== attempt.workflowMemoryContextSha256)
  ) {
    throw revisionConflict("Planning Attempt引用的Workflow Memory Context不存在或Hash不一致");
  }
  if (
    attempt.planningProjectContextId !== undefined &&
    (projectContext === undefined ||
      projectContext.productRunId !== input.productRunId ||
      projectContext.sha256 !== attempt.planningProjectContextSha256)
  ) {
    throw revisionConflict("Planning Attempt引用的Project Context不存在或Hash不一致");
  }
  if (
    attempt.ruleSelectionId !== undefined &&
    (ruleSelection === undefined ||
      ruleSelection.productRunId !== input.productRunId ||
      ruleSelection.sha256 !== attempt.ruleSelectionSha256 ||
      ruleSelection.status !== "ready")
  ) {
    throw revisionConflict("Planning Attempt引用的Rule Selection不存在、未就绪或Hash不一致");
  }
  const selectedRuleContents =
    ruleSelection === undefined
      ? []
      : ruleSelection.selected.map((selected) => {
          const revision = snapshot.entities.ruleRevisions[selected.ruleRevisionId];
          if (
            revision === undefined ||
            revision.ruleId !== selected.ruleId ||
            revision.sha256 !== selected.ruleRevisionSha256 ||
            revision.body.length !== selected.contentCharacters
          ) {
            throw revisionConflict("Rule Selection引用的Rule Revision不存在或内容证据不一致");
          }
          return {
            ruleId: selected.ruleId,
            ruleRevisionId: revision.ruleRevisionId,
            revision: revision.revision,
            sha256: revision.sha256,
            body: revision.body,
            source: selected.source,
            priority: selected.priority,
          };
        });
  if (
    ruleSelection !== undefined &&
    selectedRuleContents.reduce((total, item) => total + item.body.length, 0) !==
      ruleSelection.selectedContentCharacters
  ) {
    throw revisionConflict("Rule Selection正文预算证据不一致");
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
    ...(nodePrompt === undefined ? {} : { nodePrompt }),
    ...(contextRequest.schemaVersion === "run-context-request.v2"
      ? {
          workspaceInstructions: {
            ref: {
              contextRequestId: contextRequest.contextRequestId,
              revision: 1 as const,
              sha256: contextRequest.workspaceInstructions.sha256,
            },
            snapshot: contextRequest.workspaceInstructions,
          },
        }
      : {}),
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
    ...(memorySelection !== undefined
      ? {
          memorySelection: {
            ref: {
              planningMemorySelectionId: memorySelection.planningMemorySelectionId,
              revision: memorySelection.revision,
              sha256: memorySelection.sha256,
            },
            items: memorySelection.selected.map((item) => {
              const memorySnapshot =
                snapshot.entities.memoryResultSnapshots[item.memoryResultSnapshotId];
              if (
                memorySnapshot === undefined ||
                memorySnapshot.revision !== item.revision ||
                memorySnapshot.sha256 !== item.sha256
              ) {
                throw revisionConflict("Memory Selection引用的Snapshot不存在或Hash不一致");
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
          },
        }
      : {}),
    ...(workflowMemoryContext !== undefined
      ? {
          workflowMemory: {
            ref: {
              workflowMemoryContextId: workflowMemoryContext.workflowMemoryContextId,
              revision: workflowMemoryContext.revision,
              sha256: workflowMemoryContext.sha256,
            },
            items: workflowMemoryContext.items.map((item) => {
              const memorySnapshot =
                snapshot.entities.workflowMemorySnapshots[item.workflowMemorySnapshotId];
              if (
                memorySnapshot === undefined ||
                memorySnapshot.revision !== item.revision ||
                memorySnapshot.sha256 !== item.sha256
              ) {
                throw revisionConflict("Workflow Memory Context引用的Snapshot不存在或已损坏");
              }
              return {
                refId: memorySnapshot.workflowMemorySnapshotId,
                revision: memorySnapshot.revision,
                sha256: memorySnapshot.sha256,
                providerId: memorySnapshot.providerId,
                title: memorySnapshot.title,
                category: memorySnapshot.category,
                content: memorySnapshot.content,
                labels: memorySnapshot.labels,
              };
            }),
            optionalFailures: workflowMemoryContext.queries.flatMap((query) =>
              query.outcome === "optional_failed" && query.errorCode !== undefined
                ? [{ providerId: query.providerId, errorCode: query.errorCode }]
                : [],
            ),
            totalContentCharacters: workflowMemoryContext.totalContentCharacters,
          },
        }
      : {}),
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
    ...(projectContext !== undefined
      ? {
          projectContext: {
            ref: {
              planningProjectContextId: projectContext.planningProjectContextId,
              revision: projectContext.revision,
              sha256: projectContext.sha256,
            },
            projectId: projectContext.projectId,
            projectRevision: projectContext.projectRevision,
            projectSha256: projectContext.projectSha256,
            snapshot: projectContext.snapshot,
          },
        }
      : {}),
    ...(ruleSelection !== undefined
      ? {
          rulesContext: {
            ref: {
              ruleSelectionId: ruleSelection.ruleSelectionId,
              revision: 1 as const,
              sha256: ruleSelection.sha256,
            },
            rules: selectedRuleContents,
            totalContentCharacters: ruleSelection.selectedContentCharacters,
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
