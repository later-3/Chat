import { hashCanonical } from "@chat/domain";
import {
  EXECUTION_CAPABILITY_MARKDOWN_COMPOSE,
  type CommandId,
  type DecisionId,
  type ExecutionContract,
  type ProductRunId,
  type RunAttemptId,
} from "@chat/contracts";
import { type ApplicationDeps } from "./deps.js";
import { notFound, revisionConflict } from "./errors.js";

/**
 * Workflow私有Application Command：执行合同、候选、验证与Product Commit。
 *
 * 不变量（任务书§9.2）：
 * - Execution Contract只从Approved Plan与已提交Decision生成，创建后不可修改。
 * - Provider或pi成功只产生候选，不能直接产生正式Message或成功终态。
 * - Product Commit同时提交Assistant Message、Run终态和Receipt；失败三者都不提交。
 * - Product Commit重试只能重用已验证候选，不再次调用已成功的付费Executor。
 */

export const EXECUTOR_LIMITS = { maxTurnsPerStep: 6, timeoutMsPerStep: 120_000 } as const;

export interface BeginRunAttemptCommand {
  readonly commandId: CommandId;
  readonly productRunId: ProductRunId;
  readonly kind: "planning" | "execution";
  readonly planRevision?: number;
  readonly stepId?: string;
}

export async function beginRunAttempt(
  deps: ApplicationDeps,
  input: BeginRunAttemptCommand,
): Promise<{ attemptId: RunAttemptId }> {
  const now = deps.now();
  const attemptId = deps.ids.attempt();
  const requestSha256 = hashCanonical("command.begin-run-attempt.v1", input);
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "BeginRunAttempt",
    requestSha256,
    mutate: (draft) => {
      const run = draft.entities.runs[input.productRunId];
      if (run === undefined) throw notFound("Product Run不存在");
      draft.entities.attempts[attemptId] = {
        schemaVersion: "run-attempt.v1",
        attemptId,
        productRunId: input.productRunId,
        kind: input.kind,
        ...(input.planRevision !== undefined ? { planRevision: input.planRevision } : {}),
        ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
        outcome: "running",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      return { resultRefs: { attemptId } };
    },
  });
  return { attemptId: result.resultRefs["attemptId"] as RunAttemptId };
}

export interface CompleteRunAttemptCommand {
  readonly commandId: CommandId;
  readonly attemptId: RunAttemptId;
  readonly outcome: "success" | "failure";
  readonly errorCode?: string;
}

export async function completeRunAttempt(
  deps: ApplicationDeps,
  input: CompleteRunAttemptCommand,
): Promise<{ revision: number }> {
  const now = deps.now();
  const requestSha256 = hashCanonical("command.complete-run-attempt.v1", input);
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CompleteRunAttempt",
    requestSha256,
    mutate: (draft) => {
      const attempt = draft.entities.attempts[input.attemptId];
      if (attempt === undefined) throw notFound("Run Attempt不存在");
      if (attempt.outcome !== "running") return { resultRefs: {} };
      draft.entities.attempts[input.attemptId] = {
        ...attempt,
        outcome: input.outcome,
        ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
        revision: attempt.revision + 1,
        updatedAt: now,
      };
      return { resultRefs: {} };
    },
  });
  return { revision: result.storeRevision };
}

export interface CompileExecutionContractCommand {
  readonly commandId: CommandId;
  readonly productRunId: ProductRunId;
  readonly approvalDecisionId: DecisionId;
}

export async function compileExecutionContract(
  deps: ApplicationDeps,
  input: CompileExecutionContractCommand,
): Promise<{ contract: ExecutionContract }> {
  const now = deps.now();
  const executionContractId = deps.ids.executionContract();
  const requestSha256 = hashCanonical("command.compile-execution-contract.v1", {
    productRunId: input.productRunId,
    approvalDecisionId: input.approvalDecisionId,
  });

  await deps.store.transact({
    commandId: input.commandId,
    commandType: "CompileExecutionContract",
    requestSha256,
    mutate: (draft) => {
      const run = draft.entities.runs[input.productRunId];
      if (run === undefined) throw notFound("Product Run不存在");
      const decision = Object.values(draft.entities.decisions).find(
        (candidate) => candidate.decisionId === input.approvalDecisionId,
      );
      if (decision === undefined || decision.productRunId !== input.productRunId) {
        throw notFound("Decision不存在");
      }
      if (decision.kind !== "approve")
        throw revisionConflict("只有approve Decision能生成Execution Contract");

      const existing = Object.values(draft.entities.executionContracts).find(
        (candidate) => candidate.productRunId === input.productRunId,
      );
      if (existing !== undefined) {
        if (existing.approvalDecisionId !== decision.decisionId) {
          throw revisionConflict("同一Product Run不允许第二个Execution Contract");
        }
        return { resultRefs: { executionContractId: existing.executionContractId } };
      }

      const plan = Object.values(draft.entities.plans).find(
        (candidate) =>
          candidate.planId === decision.planId &&
          candidate.planRevision === decision.planRevision &&
          candidate.productRunId === input.productRunId,
      );
      if (plan === undefined) throw notFound("Approved Plan不存在");
      if (plan.status !== "approved") throw revisionConflict("Plan不在approved状态");
      if (plan.sha256 !== decision.planSha256) throw revisionConflict("Plan Hash与Decision不一致");

      const steps = plan.content.steps.map((step) => ({
        stepId: step.stepId,
        title: step.title,
        purpose: step.purpose,
        dependsOn: step.dependsOn,
        expectedOutput: step.expectedOutput,
        successCriteria: step.successCriteria,
      }));
      const contract: ExecutionContract = {
        schemaVersion: "execution-contract.v1",
        executionContractId,
        productRunId: input.productRunId,
        approvedPlanId: plan.planId,
        approvedPlanRevision: plan.planRevision,
        approvedPlanSha256: plan.sha256,
        approvalDecisionId: decision.decisionId,
        steps,
        completionCriteria: plan.content.completionCriteria,
        capabilityRefs: [EXECUTION_CAPABILITY_MARKDOWN_COMPOSE],
        limits: { ...EXECUTOR_LIMITS },
        sha256: hashCanonical("execution-contract.v1", {
          productRunId: input.productRunId,
          approvedPlanId: plan.planId,
          approvedPlanRevision: plan.planRevision,
          approvedPlanSha256: plan.sha256,
          approvalDecisionId: decision.decisionId,
          steps,
          completionCriteria: plan.content.completionCriteria,
          capabilityRefs: [EXECUTION_CAPABILITY_MARKDOWN_COMPOSE],
          limits: EXECUTOR_LIMITS,
        }),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.executionContracts[executionContractId] = contract;
      return { resultRefs: { executionContractId } };
    },
  });

  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const contract = Object.values(snapshot.entities.executionContracts).find(
    (candidate) => candidate.productRunId === input.productRunId,
  );
  if (contract === undefined) throw notFound("Execution Contract不存在");
  return { contract };
}
