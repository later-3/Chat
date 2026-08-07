import { hashCanonical, transitionRunLifecycle, type RunLifecycle } from "@chat/domain";
import type {
  CommandId,
  DecisionId,
  ExecutionCandidateId,
  ExecutionContractId,
  Message,
  ProductRunId,
  ValidationResultId,
} from "@chat/contracts";
import type {
  PersistExecutionCandidateRequest,
  PersistValidationResultRequest,
} from "@chat/contracts";
import { type ApplicationDeps } from "./deps.js";
import { notFound, revisionConflict } from "./errors.js";
import { emitRunEvent } from "./trace-helpers.js";

/**
 * 候选持久化、验证结果与Product Commit（任务书§11三道门）。
 */

export async function persistExecutionCandidate(
  deps: ApplicationDeps,
  input: Omit<PersistExecutionCandidateRequest, "schemaVersion">,
): Promise<{ executionCandidateId: ExecutionCandidateId; sha256: string }> {
  const now = deps.now();
  const executionCandidateId = deps.ids.executionCandidate();
  const requestSha256 = hashCanonical("command.persist-execution-candidate.v1", input);
  const sha256 = hashCanonical("execution-candidate.v1", {
    executionContractId: input.executionContractId,
    attemptId: input.attemptId,
    stepResults: input.stepResults,
    finalOutput: input.finalOutput,
    completionCriteriaEvidence: input.completionCriteriaEvidence,
    warnings: input.warnings,
  });

  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "PersistExecutionCandidate",
    requestSha256,
    mutate: (draft) => {
      const contract = draft.entities.executionContracts[input.executionContractId];
      if (contract === undefined || contract.productRunId !== input.productRunId) {
        throw notFound("Execution Contract不存在");
      }
      const attempt = draft.entities.attempts[input.attemptId];
      if (attempt === undefined || attempt.productRunId !== input.productRunId) {
        throw notFound("Run Attempt不存在");
      }
      draft.entities.executionCandidates[executionCandidateId] = {
        schemaVersion: "execution-candidate.v1",
        executionCandidateId,
        productRunId: input.productRunId,
        executionContractId: input.executionContractId,
        attemptId: input.attemptId,
        stepResults: input.stepResults,
        finalOutput: input.finalOutput,
        completionCriteriaEvidence: input.completionCriteriaEvidence,
        warnings: input.warnings,
        sha256,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      return { resultRefs: { executionCandidateId } };
    },
  });
  return {
    executionCandidateId: result.resultRefs["executionCandidateId"] as ExecutionCandidateId,
    sha256,
  };
}

export async function persistValidationResult(
  deps: ApplicationDeps,
  input: Omit<PersistValidationResultRequest, "schemaVersion">,
): Promise<{ validationResultId: ValidationResultId }> {
  const now = deps.now();
  const validationResultId = deps.ids.validationResult();
  const requestSha256 = hashCanonical("command.persist-validation-result.v1", input);

  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "PersistValidationResult",
    requestSha256,
    mutate: (draft) => {
      const contract = draft.entities.executionContracts[input.executionContractId];
      if (contract === undefined || contract.productRunId !== input.productRunId) {
        throw notFound("Execution Contract不存在");
      }
      const candidate = draft.entities.executionCandidates[input.executionCandidateId];
      if (candidate === undefined || candidate.executionContractId !== input.executionContractId) {
        throw notFound("Execution Candidate不存在");
      }
      draft.entities.validationResults[validationResultId] = {
        schemaVersion: "validation-result.v1",
        validationResultId,
        productRunId: input.productRunId,
        executionContractId: input.executionContractId,
        executionCandidateId: input.executionCandidateId,
        outcome: input.outcome,
        failures: input.failures,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      return { resultRefs: { validationResultId } };
    },
  });

  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const candidate = snapshot.entities.executionCandidates[input.executionCandidateId];
  const workflowAttempt = findWorkflowAttempt(snapshot.entities, input.productRunId);
  if (candidate !== undefined && workflowAttempt !== undefined) {
    const eventBase = {
      productRunId: input.productRunId,
      attemptId: workflowAttempt.attemptId,
      candidateRef: {
        objectType: "execution_candidate" as const,
        objectId: candidate.executionCandidateId,
        sha256: candidate.sha256,
      },
    };
    if (input.outcome === "pass") {
      emitRunEvent(deps, input.productRunId, {
        level: "info",
        eventName: "execution.validated",
        outcome: "success",
        ...eventBase,
      });
    } else {
      emitRunEvent(deps, input.productRunId, {
        level: "warn",
        eventName: "execution.rejected",
        outcome: "rejected",
        ...eventBase,
        error: {
          code: input.failures[0]?.code ?? "validation_failed",
          type: "ValidationError",
        },
      });
    }
  }
  return { validationResultId: result.resultRefs["validationResultId"] as ValidationResultId };
}

export interface CommitExecutionResultCommand {
  readonly commandId: CommandId;
  readonly productRunId: ProductRunId;
  readonly executionContractId: ExecutionContractId;
  readonly executionCandidateId: ExecutionCandidateId;
  readonly validationResultId: ValidationResultId;
  readonly renderedMarkdown: string;
}

/** Product Commit：原子提交Assistant Message + Run终态 + Receipt；失败三者都不提交。 */
export async function commitExecutionResult(
  deps: ApplicationDeps,
  input: CommitExecutionResultCommand,
): Promise<{ finalMessageId: string; revision: number }> {
  const now = deps.now();
  const finalMessageId = deps.ids.message();
  const renderedMarkdown = input.renderedMarkdown;
  const requestSha256 = hashCanonical("command.commit-execution-result.v1", {
    productRunId: input.productRunId,
    executionContractId: input.executionContractId,
    executionCandidateId: input.executionCandidateId,
    validationResultId: input.validationResultId,
    renderedMarkdown,
  });

  const { snapshot: before } = await deps.store.read({ kind: "committedSnapshot" });
  const workflowAttempt = findWorkflowAttempt(before.entities, input.productRunId);
  if (workflowAttempt !== undefined) {
    emitRunEvent(deps, input.productRunId, {
      level: "info",
      eventName: "product_commit.started",
      outcome: "unknown",
      productRunId: input.productRunId,
      attemptId: workflowAttempt.attemptId,
      outputRefs: [],
    });
  }

  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CommitExecutionResult",
    requestSha256,
    mutate: (draft) => {
      const run = draft.entities.runs[input.productRunId];
      if (run === undefined) throw notFound("Product Run不存在");
      const contract = draft.entities.executionContracts[input.executionContractId];
      if (contract === undefined || contract.productRunId !== input.productRunId) {
        throw notFound("Execution Contract不存在");
      }
      const candidate = draft.entities.executionCandidates[input.executionCandidateId];
      if (
        candidate === undefined ||
        candidate.executionContractId !== contract.executionContractId
      ) {
        throw notFound("Execution Candidate不存在");
      }
      const validation = draft.entities.validationResults[input.validationResultId];
      if (
        validation === undefined ||
        validation.executionCandidateId !== candidate.executionCandidateId ||
        validation.executionContractId !== contract.executionContractId
      ) {
        throw notFound("Validation Result不存在");
      }
      if (validation.outcome !== "pass") {
        throw revisionConflict("验证未通过的候选不能提交为正式结果");
      }

      let lifecycle: RunLifecycle = { status: run.status, phase: run.phase };
      if (lifecycle.status === "running" && lifecycle.phase === "executing") {
        lifecycle = transitionRunLifecycle(lifecycle, { status: "running", phase: "validating" });
      }
      lifecycle = transitionRunLifecycle(lifecycle, { status: "succeeded", phase: "completed" });

      const session = draft.entities.sessions[run.sessionId];
      if (session === undefined) throw notFound("Session不存在");
      const sessionSequence = session.lastMessageSequence + 1;
      const message: Message = {
        schemaVersion: "message.v1",
        messageId: finalMessageId,
        sessionId: run.sessionId,
        sessionSequence,
        role: "assistant",
        content: { format: "markdown", text: renderedMarkdown },
        sourceRunId: input.productRunId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.messages[finalMessageId] = message;
      draft.entities.sessions[run.sessionId] = {
        ...session,
        lastMessageSequence: sessionSequence,
        revision: session.revision + 1,
        updatedAt: now,
      };
      draft.entities.runs[input.productRunId] = {
        ...run,
        status: lifecycle.status,
        phase: lifecycle.phase,
        finalMessageId,
        revision: run.revision + 1,
        updatedAt: now,
      };
      completeWorkflowAttempt(draft, input.productRunId, "success", now);
      return {
        resultRefs: {
          finalMessageId,
          productRunId: input.productRunId,
          messageSha256: hashCanonical("message.v1", {
            messageId: finalMessageId,
            sessionId: run.sessionId,
            sessionSequence,
            role: "assistant",
            content: message.content,
          }),
        },
      };
    },
  });

  if (workflowAttempt !== undefined) {
    emitRunEvent(deps, input.productRunId, {
      level: "info",
      eventName: "product_commit.committed",
      outcome: "success",
      productRunId: input.productRunId,
      attemptId: workflowAttempt.attemptId,
      outputRefs: [
        {
          objectType: "message",
          objectId: result.resultRefs["finalMessageId"] ?? "",
          sha256: result.resultRefs["messageSha256"] ?? "",
        },
      ],
    });
  }
  return {
    finalMessageId: result.resultRefs["finalMessageId"] ?? "",
    revision: result.storeRevision,
  };
}

export interface CommitRejectedRunCommand {
  readonly commandId: CommandId;
  readonly productRunId: ProductRunId;
  readonly decisionId: DecisionId;
}

/** Reject路径确认：Decision已在SubmitPlanDecision提交cancelled，本命令完成Attempt并保证幂等。 */
export async function commitRejectedRun(
  deps: ApplicationDeps,
  input: CommitRejectedRunCommand,
): Promise<{ revision: number }> {
  const now = deps.now();
  const requestSha256 = hashCanonical("command.commit-rejected-run.v1", input);
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CommitRejectedRun",
    requestSha256,
    mutate: (draft) => {
      const run = draft.entities.runs[input.productRunId];
      if (run === undefined) throw notFound("Product Run不存在");
      const decision = draft.entities.decisions[input.decisionId];
      if (decision === undefined || decision.productRunId !== input.productRunId) {
        throw notFound("Decision不存在");
      }
      if (decision.kind !== "reject") throw revisionConflict("只有reject Decision能提交取消终态");
      if (run.status !== "cancelled" || run.phase !== "rejected") {
        throw revisionConflict("Product Run不在cancelled/rejected终态");
      }
      completeWorkflowAttempt(draft, input.productRunId, "success", now);
      return { resultRefs: { productRunId: input.productRunId } };
    },
  });
  return { revision: result.storeRevision };
}

export interface CommitRunFailureCommand {
  readonly commandId: CommandId;
  readonly productRunId: ProductRunId;
  readonly errorCode: string;
  readonly summary: string;
}

/** 明确失败终态：不产生产假成功；等待中的Approval与under_review Plan一并过期。 */
export async function commitRunFailure(
  deps: ApplicationDeps,
  input: CommitRunFailureCommand,
): Promise<{ revision: number }> {
  const now = deps.now();
  const requestSha256 = hashCanonical("command.commit-run-failure.v1", input);
  const { snapshot: before } = await deps.store.read({ kind: "committedSnapshot" });
  const priorRun = before.entities.runs[input.productRunId];
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CommitRunFailure",
    requestSha256,
    mutate: (draft) => {
      const run = draft.entities.runs[input.productRunId];
      if (run === undefined) throw notFound("Product Run不存在");
      const lifecycle = transitionRunLifecycle(
        { status: run.status, phase: run.phase },
        { status: "failed", phase: run.phase },
      );
      draft.entities.runs[input.productRunId] = {
        ...run,
        status: lifecycle.status,
        phase: lifecycle.phase,
        failure: { code: input.errorCode, summary: input.summary },
        revision: run.revision + 1,
        updatedAt: now,
      };
      for (const approval of Object.values(draft.entities.approvalRequests)) {
        if (approval.productRunId === input.productRunId && approval.status === "open") {
          draft.entities.approvalRequests[approval.approvalRequestId] = {
            ...approval,
            status: "expired",
            revision: approval.revision + 1,
            updatedAt: now,
          };
        }
      }
      for (const plan of Object.values(draft.entities.plans)) {
        if (plan.productRunId === input.productRunId && plan.status === "under_review") {
          draft.entities.plans[plan.planRevisionId] = {
            ...plan,
            status: "expired",
            revision: plan.revision + 1,
            updatedAt: now,
          };
        }
      }
      completeWorkflowAttempt(draft, input.productRunId, "failure", now, input.errorCode);
      return { resultRefs: { productRunId: input.productRunId } };
    },
  });

  if (priorRun !== undefined) {
    emitRunEvent(deps, input.productRunId, {
      level: "warn",
      eventName: "product_run.transitioned",
      outcome: "success",
      productRunId: input.productRunId,
      fromStatus: priorRun.status,
      toStatus: "failed",
      fromPhase: priorRun.phase,
      toPhase: priorRun.phase,
      revision: result.storeRevision,
    });
  }
  return { revision: result.storeRevision };
}

/* ---------- Outbox（Dispatcher使用） ---------- */

export interface UpdateOutboxStatusCommand {
  readonly commandId: CommandId;
  readonly outboxId: string;
  /** pending仅用于对账后的安全重排队。 */
  readonly status:
    "pending" | "dispatched" | "acknowledged" | "outcome_unknown" | "failed_terminal";
  readonly errorCode?: string;
}

export async function updateOutboxStatus(
  deps: ApplicationDeps,
  input: UpdateOutboxStatusCommand,
): Promise<void> {
  const now = deps.now();
  const requestSha256 = hashCanonical("command.update-outbox-status.v1", input);
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "UpdateOutboxStatus",
    requestSha256,
    mutate: (draft) => {
      const entry = draft.outbox[input.outboxId];
      if (entry === undefined) throw notFound("Outbox Entry不存在");
      draft.outbox[input.outboxId] = {
        ...entry,
        status: input.status,
        dispatchAttempts:
          input.status === "dispatched" ? entry.dispatchAttempts + 1 : entry.dispatchAttempts,
        ...(input.errorCode !== undefined ? { lastErrorCode: input.errorCode } : {}),
        revision: entry.revision + 1,
        updatedAt: now,
      };
      return { resultRefs: {} };
    },
  });
}

/* ---------- 内部助手 ---------- */

type Entities = Parameters<
  Parameters<ApplicationDeps["store"]["transact"]>[0]["mutate"]
>[0]["entities"];

function findWorkflowAttempt(entities: Entities, productRunId: ProductRunId) {
  return Object.values(entities.attempts).find(
    (attempt) => attempt.productRunId === productRunId && attempt.kind === "workflow",
  );
}

function completeWorkflowAttempt(
  draft: Parameters<Parameters<ApplicationDeps["store"]["transact"]>[0]["mutate"]>[0],
  productRunId: ProductRunId,
  outcome: "success" | "failure",
  now: string,
  errorCode?: string,
): void {
  const attempt = findWorkflowAttempt(draft.entities, productRunId);
  if (attempt === undefined || attempt.outcome !== "running") return;
  draft.entities.attempts[attempt.attemptId] = {
    ...attempt,
    outcome,
    ...(errorCode !== undefined ? { errorCode } : {}),
    revision: attempt.revision + 1,
    updatedAt: now,
  };
}
