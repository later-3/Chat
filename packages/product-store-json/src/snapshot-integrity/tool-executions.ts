import type { ProductSnapshot } from "@chat/contracts";
import {
  computeDirectRuntimeOperationRefSha256,
  computeToolExecutionDecisionSha256,
} from "@chat/domain";
import type { Fail } from "./shared.js";

export function assertToolExecutions(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  for (const intent of Object.values(entities.toolExecutionIntents)) {
    const run = entities.runs[intent.productRunId];
    const attempt = entities.attempts[intent.attemptId];
    const session = run === undefined ? undefined : entities.sessions[run.sessionId];
    if (
      run === undefined ||
      attempt === undefined ||
      attempt.productRunId !== intent.productRunId ||
      attempt.inputManifestSha256 === undefined ||
      intent.runtimeOperationRefSha256 !==
        computeDirectRuntimeOperationRefSha256({
          productRunId: intent.productRunId,
          directAgentAttemptId: intent.attemptId,
          inputManifestSha256: attempt.inputManifestSha256,
        }) ||
      intent.effect === "read" ||
      intent.effect !== intent.capability.effect ||
      JSON.stringify(intent.scopeRef) !== JSON.stringify(intent.capability.ref.scopeRef)
    ) {
      fail(`Tool Intent ${intent.toolExecutionIntentId} 的Run/Attempt/Capability绑定非法`);
    }
    const decision =
      intent.decidedByToolExecutionDecisionId === undefined
        ? undefined
        : entities.toolExecutionDecisions[intent.decidedByToolExecutionDecisionId];
    if (
      decision !== undefined &&
      (decision.toolExecutionIntentId !== intent.toolExecutionIntentId ||
        decision.productRunId !== intent.productRunId ||
        decision.intentRevision >= intent.revision ||
        decision.capabilityDescriptorSha256 !== intent.capability.ref.descriptorSha256 ||
        decision.inputSha256 !== intent.inputSha256 ||
        decision.principalId !== session?.ownerPrincipalId ||
        JSON.stringify(decision.scopeRef) !== JSON.stringify(intent.scopeRef))
    ) {
      fail(`Tool Intent ${intent.toolExecutionIntentId} 的Decision绑定非法`);
    }
    const statusNeedsDecision = !["waiting_decision", "not_executed"].includes(intent.status);
    if (
      (intent.status === "waiting_decision" && decision !== undefined) ||
      (statusNeedsDecision && decision === undefined) ||
      (decision?.kind === "reject" && intent.status !== "rejected") ||
      (decision?.kind === "approve" && intent.status === "rejected") ||
      (intent.status === "not_executed" && decision?.kind === "reject")
    ) {
      fail(`Tool Intent ${intent.toolExecutionIntentId} 的Decision与状态不一致`);
    }
    const result =
      intent.resultId === undefined ? undefined : entities.toolExecutionResults[intent.resultId];
    const terminalWithResult = ["completed", "failed", "outcome_unknown"].includes(intent.status);
    if (
      terminalWithResult !== (result !== undefined) ||
      (result !== undefined &&
        (result.toolExecutionIntentId !== intent.toolExecutionIntentId ||
          result.productRunId !== intent.productRunId ||
          result.outcome !== intent.status ||
          ((result.outcome === "completed" || result.outcome === "failed") &&
            (result.evidenceRefs.length !== 1 ||
              result.evidenceRefs[0]?.kind !== "pi_journal_result"))))
    ) {
      fail(`Tool Intent ${intent.toolExecutionIntentId} 的Result与状态不一致`);
    }
  }

  for (const decision of Object.values(entities.toolExecutionDecisions)) {
    const intent = entities.toolExecutionIntents[decision.toolExecutionIntentId];
    if (
      intent === undefined ||
      intent.decidedByToolExecutionDecisionId !== decision.toolExecutionDecisionId ||
      decision.productRunId !== intent.productRunId ||
      decision.intentRevision >= intent.revision
    ) {
      fail(`Tool Decision ${decision.toolExecutionDecisionId} 悬空或没有被Intent采用`);
    }
    const expected = computeToolExecutionDecisionSha256({
      toolExecutionDecisionId: decision.toolExecutionDecisionId,
      toolExecutionIntentId: decision.toolExecutionIntentId,
      productRunId: decision.productRunId,
      intentRevision: decision.intentRevision,
      capabilityDescriptorSha256: decision.capabilityDescriptorSha256,
      inputSha256: decision.inputSha256,
      scopeRef: decision.scopeRef,
      kind: decision.kind,
      principalId: decision.principalId,
      ...(decision.explanation === undefined ? {} : { explanation: decision.explanation }),
      commandId: decision.commandId,
    });
    if (expected !== decision.sha256) {
      fail(`Tool Decision ${decision.toolExecutionDecisionId} Hash不一致`);
    }
  }

  for (const result of Object.values(entities.toolExecutionResults)) {
    const intent = entities.toolExecutionIntents[result.toolExecutionIntentId];
    if (intent === undefined || intent.resultId !== result.toolExecutionResultId) {
      fail(`Tool Result ${result.toolExecutionResultId} 悬空或没有被Intent采用`);
    }
  }

  const terminalRunStatuses = new Set(["succeeded", "failed", "cancelled", "outcome_unknown"]);
  for (const run of Object.values(entities.runs)) {
    if (!terminalRunStatuses.has(run.status)) continue;
    const active = Object.values(entities.toolExecutionIntents).some(
      (intent) =>
        intent.productRunId === run.productRunId &&
        ["waiting_decision", "approved", "dispatching"].includes(intent.status),
    );
    if (active) fail(`终态Run ${run.productRunId} 仍包含活动Tool Intent`);
  }
}
