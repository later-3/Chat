import { hashCanonical, nextPlanRevision } from "@chat/domain";
import {
  MODEL_CONFIG_VERSION,
  PLANNER_PROMPT_TEMPLATE_VERSION,
  type CommandId,
  type LoadCommittedDecisionResponse,
  type PlanningInputDto,
  type ProductRunId,
} from "@chat/contracts";
import { type ApplicationDeps } from "./deps.js";
import { notFound, revisionConflict } from "./errors.js";
import { emitRunEvent } from "./trace-helpers.js";

/**
 * Workflow私有Application Command：compilePlanningInput / loadCommittedDecision。
 *
 * 边界：Workflow Step只携带产品引用与稳定commandId；本用例负责读取已提交
 * 产品事实并编译本轮规划输入。模型只看到编译结果，不直接读Product Store。
 */

export const PLANNER_LIMITS = { maxTurns: 6, timeoutMs: 120_000 } as const;

export interface CompilePlanningInputCommand {
  readonly commandId: CommandId;
  readonly productRunId: ProductRunId;
  readonly planRevision: number;
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
  });

  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CompilePlanningInput",
    requestSha256,
    mutate: (draft) => {
      const run = draft.entities.runs[input.productRunId];
      if (run === undefined) throw notFound("Product Run不存在");

      const existingPlans = Object.values(draft.entities.plans)
        .filter((plan) => plan.productRunId === input.productRunId)
        .sort((a, b) => a.planRevision - b.planRevision);
      const expectedNext = nextPlanRevision(
        existingPlans.map((plan) => plan.planRevision),
        run.maxPlanRevisions,
      );
      if (expectedNext !== input.planRevision) {
        throw revisionConflict(
          `请求编译的planRevision ${String(input.planRevision)}与产品事实期望的${String(expectedNext)}不一致`,
        );
      }
      const priorPlan = existingPlans[existingPlans.length - 1];
      if (priorPlan !== undefined && priorPlan.status === "under_review") {
        throw revisionConflict("存在仍在审核中的Plan，不能编译下一轮规划输入");
      }

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

      draft.entities.attempts[attemptId] = {
        schemaVersion: "run-attempt.v1",
        attemptId,
        productRunId: input.productRunId,
        kind: "planning",
        planRevision: input.planRevision,
        outcome: "running",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
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
  const plans = Object.values(snapshot.entities.plans)
    .filter((plan) => plan.productRunId === input.productRunId)
    .sort((a, b) => a.planRevision - b.planRevision);
  const priorPlan = plans[plans.length - 1];
  const revisionInput =
    priorPlan === undefined
      ? undefined
      : Object.values(snapshot.entities.revisionInputs)
          .filter(
            (candidate) =>
              candidate.planId === priorPlan.planId &&
              candidate.planRevision === priorPlan.planRevision,
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  if (run.status === "running" && run.phase === "planning" && input.planRevision === 1) {
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
    sourceMessageRef: {
      messageId: message.messageId,
      sha256: messageSha256(message),
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
    planRevision: input.planRevision,
    limits: { ...PLANNER_LIMITS },
    promptTemplateVersion: PLANNER_PROMPT_TEMPLATE_VERSION,
    modelConfigVersion: MODEL_CONFIG_VERSION,
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
