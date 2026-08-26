import { GOVERNANCE_REVIEW_PROFILE_VERSION, MODEL_CONFIG_VERSION } from "@chat/contracts";
import { getWorkflowRuntimeContext } from "./runtime-context.js";
import {
  cmdId,
  emitCompletedProviderCall,
  emitPiNodeTrace,
  emitProviderTrace,
  PiStepFailure,
  providerResultTraceDetails,
  runStep,
  wrapApiError,
} from "./workflow-step-support.js";

export async function reviewExecutionGovernanceStep(input: {
  readonly productRunId: string;
  readonly workflowAttemptId: string;
  readonly workflowRunSpecId: string;
  readonly executionCandidateId: string;
}): Promise<{
  readonly outcome: "pass" | "fail";
  readonly validationResultId: string;
  readonly failures: readonly { readonly code: string; readonly detail: string }[];
}> {
  "use step";
  return runStep(
    input.productRunId,
    input.workflowAttemptId,
    "review_execution_governance",
    async () => {
      const ctx = getWorkflowRuntimeContext();
      const reviewer = ctx.governanceReview;
      if (reviewer === undefined) {
        throw new PiStepFailure(
          "governance_reviewer.not_configured",
          "Workflow Runtime未配置治理检查Agent",
        );
      }
      let reviewInput;
      try {
        const prepared = await ctx.api.prepareGovernanceReviewInput({
          commandId: cmdId(
            "prepare-governance-review-input",
            input.productRunId,
            input.executionCandidateId,
          ) as never,
          productRunId: input.productRunId as never,
          workflowRunSpecId: input.workflowRunSpecId as never,
          executionCandidateId: input.executionCandidateId as never,
        });
        reviewInput = prepared.reviewInput;
      } catch (error) {
        wrapApiError(error);
      }
      const inputManifestSha256 = reviewInput.inputManifestSha256;
      const providerScope = {
        productRunId: input.productRunId,
        attemptId: reviewInput.attemptId,
        promptTemplateVersion: GOVERNANCE_REVIEW_PROFILE_VERSION,
        modelConfigVersion: MODEL_CONFIG_VERSION,
        nodeKind: "governance_reviewer" as const,
      };

      const failAttempt = async (code: string, durationMs?: number): Promise<never> => {
        emitPiNodeTrace(providerScope, "pi.node.failed", "governance_reviewer", {
          errorCode: code,
          ...(durationMs === undefined ? {} : { durationMs }),
        });
        try {
          await ctx.api.completeRunAttempt({
            commandId: cmdId("complete-governance-review-attempt", reviewInput.attemptId) as never,
            attemptId: reviewInput.attemptId,
            outcome: "failure",
            errorCode: code as never,
          });
        } catch (error) {
          wrapApiError(error);
        }
        throw new PiStepFailure(code, `治理检查失败:${code}`);
      };

      if (ctx.bailian.apiKey === undefined) {
        const code = "provider.pre_request.no_api_key";
        emitProviderTrace(providerScope, "provider.request.failed", {
          durationMs: 0,
          errorCode: code,
          preRequest: true,
        });
        return failAttempt(code, 0);
      }
      emitPiNodeTrace(providerScope, "pi.node.started", "governance_reviewer");

      let result;
      try {
        result = await reviewer({
          config: ctx.bailian,
          reviewInput,
          onProviderRequestStart: () =>
            emitProviderTrace(providerScope, "provider.request.started", {
              inputManifestSha256,
            }),
        });
      } catch (error) {
        const code =
          error instanceof Error && "code" in error && typeof error.code === "string"
            ? error.code
            : "provider.pre_request.governance_review_failed";
        emitProviderTrace(providerScope, "provider.request.failed", {
          durationMs: 0,
          errorCode: code,
          preRequest: true,
        });
        return failAttempt(code);
      }
      if (result.kind === "invalid_candidate") {
        if (!emitCompletedProviderCall(providerScope, inputManifestSha256, result)) {
          const code = "provider.evidence_missing";
          emitProviderTrace(providerScope, "provider.request.failed", {
            inputManifestSha256,
            durationMs: result.durationMs,
            errorCode: code,
            ...(result.providerMeta.httpStatus === undefined
              ? {}
              : { httpStatus: result.providerMeta.httpStatus }),
            ...(result.providerMeta.providerRequestId === undefined
              ? {}
              : { providerRequestId: result.providerMeta.providerRequestId }),
            ...providerResultTraceDetails(result.providerMeta),
          });
          return failAttempt(code, result.durationMs);
        }
        return failAttempt(`model.candidate.${result.errorCode}`, result.durationMs);
      }
      if (result.kind === "provider_failed") {
        emitProviderTrace(providerScope, "provider.request.failed", {
          inputManifestSha256,
          durationMs: result.durationMs,
          errorCode: result.errorCode,
          ...(result.providerMeta.httpStatus === undefined
            ? {}
            : { httpStatus: result.providerMeta.httpStatus }),
          ...(result.providerMeta.providerRequestId === undefined
            ? {}
            : { providerRequestId: result.providerMeta.providerRequestId }),
          ...providerResultTraceDetails(result.providerMeta),
          ...(result.providerCallCount === 0 ? { preRequest: true } : {}),
        });
        return failAttempt(result.errorCode, result.durationMs);
      }
      if (!emitCompletedProviderCall(providerScope, inputManifestSha256, result)) {
        const code = "provider.evidence_missing";
        emitProviderTrace(providerScope, "provider.request.failed", {
          inputManifestSha256,
          durationMs: result.durationMs,
          errorCode: code,
          ...(result.providerMeta.httpStatus === undefined
            ? {}
            : { httpStatus: result.providerMeta.httpStatus }),
          ...(result.providerMeta.providerRequestId === undefined
            ? {}
            : { providerRequestId: result.providerMeta.providerRequestId }),
          ...providerResultTraceDetails(result.providerMeta),
        });
        return failAttempt(code, result.durationMs);
      }

      try {
        const persisted = await ctx.api.persistValidationResult({
          commandId: cmdId(
            "persist-governance-validation",
            input.productRunId,
            input.executionCandidateId,
            reviewInput.nodePrompt.nodeAssemblySha256,
          ) as never,
          productRunId: input.productRunId as never,
          executionContractId: reviewInput.contract.executionContractId,
          executionCandidateId: reviewInput.candidate.executionCandidateId,
          strictEvidence: reviewInput.strictEvidence,
          governanceReview: result.candidate,
          governanceReviewAttemptId: reviewInput.attemptId,
          governanceReviewInputManifestSha256: reviewInput.inputManifestSha256,
        });
        emitPiNodeTrace(providerScope, "pi.node.completed", "governance_reviewer", {
          durationMs: result.durationMs,
        });
        return {
          outcome: persisted.outcome,
          validationResultId: persisted.validationResultId,
          failures: persisted.failures,
        };
      } catch (error) {
        wrapApiError(error);
      }
    },
  );
}

reviewExecutionGovernanceStep.maxRetries = 0;
