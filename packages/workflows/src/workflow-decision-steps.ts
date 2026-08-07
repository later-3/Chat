import { WORKFLOW_DEFINITION_VERSION } from "@chat/contracts";
import {
  getWorkflowRuntimeContext,
  workflowRunTraceId,
  workflowSpanId,
} from "./runtime-context.js";
import { decisionHookToken } from "./workflow-input.js";
import { cmdId, runStep, wrapApiError } from "./workflow-step-support.js";

/* ---------- Hook ---------- */

export async function claimDecisionHookStep(input: {
  productRunId: string;
  attemptId: string;
  planRevision: number;
  approvalRequestId: string;
}): Promise<{ token: string }> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "claim_decision_hook", async () => {
    const ctx = getWorkflowRuntimeContext();
    const token = decisionHookToken(input.productRunId, input.planRevision);
    await ctx.bindings.claimHookBinding({
      approvalRequestId: input.approvalRequestId as never,
      productRunId: input.productRunId as never,
      planRevision: input.planRevision,
      hookToken: token,
      now: ctx.now(),
    });
    ctx.trace({
      level: "info",
      eventName: "workflow.hook.waiting",
      outcome: "unknown",
      traceId: workflowRunTraceId(input.productRunId),
      spanId: workflowSpanId(),
      productRunId: input.productRunId as never,
      attemptId: input.attemptId as never,
      workflowDefinitionVersion: WORKFLOW_DEFINITION_VERSION,
      waitReason: "plan_approval",
    } as never);
    return { token };
  });
}

export async function loadCommittedDecisionStep(input: {
  productRunId: string;
  attemptId: string;
  decisionId: string;
  expectedPlanId: string;
  expectedPlanRevision: number;
  expectedPlanSha256: string;
}): Promise<{
  decisionId: string;
  kind: "request_revision" | "approve" | "reject";
  principalId: string;
}> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "load_committed_decision", async () => {
    const ctx = getWorkflowRuntimeContext();
    try {
      const decision = await ctx.api.loadCommittedDecision({
        commandId: cmdId("load-committed-decision", input.productRunId, input.decisionId) as never,
        productRunId: input.productRunId as never,
        decisionId: input.decisionId as never,
        expectedPlanId: input.expectedPlanId as never,
        expectedPlanRevision: input.expectedPlanRevision,
        expectedPlanSha256: input.expectedPlanSha256,
      });
      ctx.trace({
        level: "info",
        eventName: "workflow.hook.resumed",
        outcome: "success",
        traceId: workflowRunTraceId(input.productRunId),
        spanId: workflowSpanId(),
        productRunId: input.productRunId as never,
        attemptId: input.attemptId as never,
        workflowDefinitionVersion: WORKFLOW_DEFINITION_VERSION,
        resumeAttempt: 1,
      } as never);
      return {
        decisionId: decision.decisionId,
        kind: decision.kind,
        principalId: decision.principalId,
      };
    } catch (error) {
      wrapApiError(error);
    }
  });
}

export async function expireApprovalStep(input: {
  productRunId: string;
  attemptId: string;
  approvalRequestId: string;
  expectedExpiresAt: string;
}): Promise<"expired" | "already_decided"> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "expire_approval", async () => {
    const ctx = getWorkflowRuntimeContext();
    try {
      const result = await ctx.api.expireApproval({
        commandId: cmdId("expire-approval", input.productRunId, input.approvalRequestId) as never,
        productRunId: input.productRunId,
        approvalRequestId: input.approvalRequestId,
        expectedExpiresAt: input.expectedExpiresAt,
      });
      return result.status;
    } catch (error) {
      wrapApiError(error);
    }
  });
}
