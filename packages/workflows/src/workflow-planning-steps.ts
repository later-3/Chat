import { hashCanonical } from "@chat/domain";
import type { PlanContent, PlanningInputDto } from "@chat/contracts";
import {
  getWorkflowRuntimeContext,
  workflowRunTraceId,
  workflowSpanId,
} from "./runtime-context.js";
import {
  cmdId,
  completedProviderEvidence,
  emitPiNodeTrace,
  emitProviderTrace,
  PiStepFailure,
  runStep,
  wrapApiError,
} from "./workflow-step-support.js";

/* ---------- 规划 ---------- */

export async function compilePlanningInputStep(input: {
  productRunId: string;
  attemptId: string;
  planRevision: number;
}): Promise<PlanningInputDto> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "compile_planning_input", async () => {
    const ctx = getWorkflowRuntimeContext();
    try {
      return await ctx.api.compilePlanningInput({
        commandId: cmdId(
          "compile-planning-input",
          input.productRunId,
          String(input.planRevision),
        ) as never,
        productRunId: input.productRunId as never,
        planRevision: input.planRevision,
      });
    } catch (error) {
      wrapApiError(error);
    }
  });
}

export async function runPiPlannerStep(planningInput: PlanningInputDto): Promise<PlanContent> {
  "use step";
  const productRunId = planningInput.productRunId;
  const attemptId = planningInput.attemptId;
  return runStep(productRunId, attemptId, "pi.plan", async () => {
    const ctx = getWorkflowRuntimeContext();
    const startedAt = performance.now();
    const inputManifestSha256 = planningInput.inputManifestSha256;
    if (ctx.bailian.apiKey === undefined) {
      const code = "provider.pre_request.no_api_key";
      emitProviderTrace(planningInput, "provider.request.failed", {
        durationMs: 0,
        errorCode: code,
        preRequest: true,
      });
      emitPiNodeTrace(planningInput, "pi.node.failed", "planner", { errorCode: code });
      throw new PiStepFailure(code, "pi.plan预请求失败:未配置Provider凭据");
    }
    emitPiNodeTrace(planningInput, "pi.node.started", "planner");
    try {
      const result = await ctx.planner({
        config: ctx.bailian,
        planningInput,
        onProviderRequestStart: () =>
          emitProviderTrace(planningInput, "provider.request.started", {
            inputManifestSha256,
          }),
      });
      if (result.kind === "candidate") {
        const evidence = completedProviderEvidence(result);
        if (evidence === undefined) {
          const errorCode = "provider.evidence_missing";
          emitProviderTrace(planningInput, "provider.request.failed", {
            inputManifestSha256,
            durationMs: result.durationMs,
            errorCode,
            ...(result.providerMeta.httpStatus !== undefined
              ? { httpStatus: result.providerMeta.httpStatus }
              : {}),
            ...(result.providerMeta.providerRequestId !== undefined
              ? { providerRequestId: result.providerMeta.providerRequestId }
              : {}),
          });
          emitPiNodeTrace(planningInput, "pi.node.failed", "planner", {
            durationMs: result.durationMs,
            errorCode,
          });
          throw new PiStepFailure(errorCode, "pi.plan证据缺失");
        }
        emitProviderTrace(planningInput, "provider.request.completed", {
          inputManifestSha256,
          durationMs: result.durationMs,
          httpStatus: evidence.httpStatus,
          providerRequestId: evidence.providerRequestId,
          tokenUsage: evidence.tokenUsage,
        });
        emitPiNodeTrace(planningInput, "pi.node.completed", "planner", {
          durationMs: result.durationMs,
        });
        return result.candidate;
      }
      const errorCode =
        result.kind === "invalid_candidate"
          ? `model.candidate.${result.errorCode}`
          : result.errorCode;
      emitProviderTrace(planningInput, "provider.request.failed", {
        inputManifestSha256,
        durationMs: result.durationMs,
        errorCode,
        ...(result.providerMeta.httpStatus !== undefined
          ? { httpStatus: result.providerMeta.httpStatus }
          : {}),
        ...(result.providerMeta.providerRequestId !== undefined
          ? { providerRequestId: result.providerMeta.providerRequestId }
          : {}),
        ...(result.providerCallCount === 0 ? { preRequest: true } : {}),
      });
      emitPiNodeTrace(planningInput, "pi.node.failed", "planner", {
        durationMs: result.durationMs,
        errorCode,
      });
      throw new PiStepFailure(errorCode, `pi.plan失败:${errorCode}`);
    } catch (error) {
      if (error instanceof PiStepFailure) throw error;
      const code =
        error instanceof Error &&
        "code" in error &&
        error.code === "provider.pre_request.no_api_key"
          ? "provider.pre_request.no_api_key"
          : "provider.pre_request.planner_failed";
      emitProviderTrace(planningInput, "provider.request.failed", {
        durationMs: Math.round(performance.now() - startedAt),
        errorCode: code,
        preRequest: true,
      });
      emitPiNodeTrace(planningInput, "pi.node.failed", "planner", { errorCode: code });
      throw new PiStepFailure(code, `pi.plan预请求失败:${code}`);
    }
  });
}
runPiPlannerStep.maxRetries = 0;

export async function publishPlanReviewStep(input: {
  productRunId: string;
  attemptId: string;
  planningAttemptId: string;
  expectedRunRevision: number;
  inputManifestSha256: string;
  content: PlanContent;
}): Promise<{
  planId: string;
  planRevision: number;
  planSha256: string;
  approvalRequestId: string;
  approvalExpiresAt: string;
}> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "publish_plan_review", async () => {
    const ctx = getWorkflowRuntimeContext();
    const candidateSha256 = hashCanonical("plan-content.v1", input.content);
    ctx.trace({
      level: "info",
      eventName: "plan.candidate.received",
      outcome: "unknown",
      traceId: workflowRunTraceId(input.productRunId),
      spanId: workflowSpanId(),
      productRunId: input.productRunId as never,
      attemptId: input.planningAttemptId as never,
      candidateSha256,
    } as never);
    try {
      return await ctx.api.publishPlanReview({
        commandId: cmdId(
          "publish-plan-review",
          input.productRunId,
          input.planningAttemptId,
          input.inputManifestSha256,
          candidateSha256,
        ) as never,
        productRunId: input.productRunId as never,
        attemptId: input.planningAttemptId as never,
        expectedRunRevision: input.expectedRunRevision,
        inputManifestSha256: input.inputManifestSha256,
        content: input.content,
      });
    } catch (error) {
      ctx.trace({
        level: "warn",
        eventName: "plan.candidate.rejected",
        outcome: "rejected",
        traceId: workflowRunTraceId(input.productRunId),
        spanId: workflowSpanId(),
        productRunId: input.productRunId as never,
        attemptId: input.planningAttemptId as never,
        candidateSha256,
        error: { code: "plan.candidate_rejected", type: "PlanCandidateError" },
      } as never);
      wrapApiError(error);
    }
  });
}
