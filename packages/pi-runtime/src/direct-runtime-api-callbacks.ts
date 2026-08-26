import {
  DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
  DIRECT_AGENT_RUNTIME_PATHS,
  authorizeDirectAgentOperationRuntimeRequestSchema,
  authorizeDirectAgentOperationRuntimeResponseSchema,
  commitPromptReviewDispatchOutcomeRuntimeRequestSchema,
  commitPromptReviewDispatchOutcomeRuntimeResponseSchema,
  consumePromptReviewDecisionRuntimeRequestSchema,
  consumePromptReviewDecisionRuntimeResponseSchema,
  persistDirectAgentCandidateRuntimeRequestSchema,
  persistDirectAgentCandidateRuntimeResponseSchema,
  publishPromptReviewRuntimeRequestSchema,
  publishPromptReviewRuntimeResponseSchema,
  prepareProjectBootstrapRuntimeRequestSchema,
  prepareProjectBootstrapRuntimeResponseSchema,
  publishToolExecutionIntentRuntimeRequestSchema,
  publishToolExecutionIntentRuntimeResponseSchema,
  claimToolExecutionDecisionRuntimeRequestSchema,
  claimToolExecutionDecisionRuntimeResponseSchema,
  commitToolExecutionResultRuntimeRequestSchema,
  commitToolExecutionResultRuntimeResponseSchema,
} from "@chat/contracts";
import { z, type ZodType } from "zod";
import {
  directAgentResultRefSchema,
  directPromptReviewDecisionRefSchema,
  directPromptReviewRefSchema,
  type StartPiDirectExecutorOperationRequest,
} from "./direct-executor-service-contract.js";
import type {
  AuthorizedDirectAgentInput,
  PiDirectExecutorServiceOptions,
  PublishDirectAgentResultInput,
  ProjectBootstrapProductPort,
} from "./direct-executor-service.js";
import type {
  DirectPromptReviewProductPort,
  LoadedDirectPromptReviewDecision,
} from "./prompt-review-gate.js";
import type { ToolExecutionProductPort } from "./tool-execution-gate.js";
import { hashCanonical } from "@chat/domain";

const INTERNAL_RUNTIME_BASE_PATH = "/internal/runtime/v1";

export class DirectAgentRuntimeCallbackError extends Error {
  constructor(
    readonly code: string,
    readonly outcomeUnknown: boolean,
  ) {
    super(code);
    this.name = "DirectAgentRuntimeCallbackError";
  }
}

export interface DirectAgentRuntimeApiCallbacksOptions {
  readonly baseUrl: string;
  readonly credential: string;
  readonly fetchFn?: typeof fetch;
}

async function postRuntime<T>(input: {
  readonly options: DirectAgentRuntimeApiCallbacksOptions;
  readonly path: string;
  readonly body: unknown;
  readonly responseSchema: ZodType<T>;
}): Promise<T> {
  let response: Response;
  try {
    response = await (input.options.fetchFn ?? fetch)(
      `${input.options.baseUrl.replace(/\/$/u, "")}${INTERNAL_RUNTIME_BASE_PATH}${input.path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-chat-runtime-key": input.options.credential,
        },
        body: JSON.stringify(input.body),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    throw new DirectAgentRuntimeCallbackError("direct_runtime.callback_outcome_unknown", true);
  }
  if (!response.ok) {
    throw new DirectAgentRuntimeCallbackError(
      `direct_runtime.callback_http_${String(response.status)}`,
      response.status >= 500,
    );
  }
  try {
    return input.responseSchema.parse(await response.json());
  } catch {
    throw new DirectAgentRuntimeCallbackError("direct_runtime.callback_response_invalid", true);
  }
}

/**
 * Pi Executor到Product Application的窄Fetch Adapter。Credential只进Header；所有正文
 * 均经双方固定Schema，Operation Journal永不复制source message或Provider payload。
 */
export function createDirectAgentRuntimeApiCallbacks(
  options: DirectAgentRuntimeApiCallbacksOptions,
): Pick<
  PiDirectExecutorServiceOptions,
  | "authorizeOperation"
  | "promptReviewProduct"
  | "toolExecutionProduct"
  | "publishResult"
  | "projectBootstrapProduct"
> {
  const authorizeOperation = async (
    request: StartPiDirectExecutorOperationRequest,
  ): Promise<AuthorizedDirectAgentInput> => {
    const response = await postRuntime({
      options,
      path: DIRECT_AGENT_RUNTIME_PATHS.authorizeOperation,
      body: authorizeDirectAgentOperationRuntimeRequestSchema.parse({
        schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
        productRunId: request.productRunId,
        directAgentAttemptId: request.directAgentAttemptId,
        workflowRunSpecId: request.workflowRunSpecId,
        workflowRunSpecSha256: request.workflowRunSpecSha256,
        inputManifestSha256: request.inputManifestSha256,
      }),
      responseSchema: authorizeDirectAgentOperationRuntimeResponseSchema,
    });
    const promptAssembly =
      response.promptAssembly.schemaVersion === "prompt-assembly.v1"
        ? response.promptAssembly
        : (() => {
            const { piSystemPrompt, ...assembly } = response.promptAssembly;
            return {
              ...assembly,
              ...(piSystemPrompt === undefined ? {} : { piSystemPrompt }),
            };
          })();
    return {
      productRunId: response.productRunId,
      directAgentAttemptId: response.directAgentAttemptId,
      runRevision: response.runRevision,
      sourceMessage: response.sourceMessage,
      promptAssembly,
      ...(response.memoryContext === undefined ? {} : { memoryContext: response.memoryContext }),
      capabilityMode: response.capabilityMode,
      ...(response.projectBootstrapContext === undefined
        ? {}
        : { projectBootstrapContext: response.projectBootstrapContext }),
      promptReviewMode: response.promptReviewMode,
      limits: response.limits,
    };
  };

  const promptReviewProduct: DirectPromptReviewProductPort = {
    async publish(input) {
      const response = await postRuntime({
        options,
        path: DIRECT_AGENT_RUNTIME_PATHS.publishPromptReview,
        body: publishPromptReviewRuntimeRequestSchema.parse({
          schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
          commandId: input.commandId,
          productRunId: input.productRunId,
          directAgentAttemptId: input.directAgentAttemptId,
          expectedRunRevision: input.expectedRunRevision,
          requestIndex: input.requestIndex,
          requestKind: input.requestKind,
          providerId: input.providerId,
          modelId: input.modelId,
          endpointHost: input.endpointHost,
          canonicalPayloadJson: input.canonicalPayloadJson,
          payloadSha256: input.payloadSha256,
        }),
        responseSchema: publishPromptReviewRuntimeResponseSchema,
      });
      if (
        response.productRunId !== input.productRunId ||
        response.requestIndex !== input.requestIndex ||
        response.payloadSha256 !== input.payloadSha256
      ) {
        throw new DirectAgentRuntimeCallbackError("direct_runtime.publish_binding_mismatch", false);
      }
      return {
        review: directPromptReviewRefSchema.parse({
          promptReviewRequestId: response.promptReviewRequestId,
          requestRevision: response.requestRevision,
          revision: response.revision,
          requestIndex: response.requestIndex,
          payloadSha256: response.payloadSha256,
          reviewSha256: response.reviewSha256,
        }),
        productRunRevision: response.runRevision,
      };
    },

    async consumeDecision(input): Promise<LoadedDirectPromptReviewDecision> {
      const response = await postRuntime({
        options,
        path: DIRECT_AGENT_RUNTIME_PATHS.consumePromptReviewDecision,
        body: consumePromptReviewDecisionRuntimeRequestSchema.parse({
          schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
          commandId: input.commandId,
          productRunId: input.productRunId,
          directAgentAttemptId: input.directAgentAttemptId,
          promptReviewRequestId: input.review.promptReviewRequestId,
          promptReviewDecisionId: input.promptReviewDecisionId,
          requestRevision: input.review.requestRevision,
          reviewSha256: input.review.reviewSha256,
          payloadSha256: input.review.payloadSha256,
        }),
        responseSchema: consumePromptReviewDecisionRuntimeResponseSchema,
      });
      if (
        response.decision.promptReviewRequestId !== input.review.promptReviewRequestId ||
        response.decision.promptReviewDecisionId !== input.promptReviewDecisionId ||
        response.decision.productRunId !== input.productRunId ||
        response.decision.requestRevision !== input.review.requestRevision ||
        response.decision.reviewSha256 !== input.review.reviewSha256 ||
        response.decision.payloadSha256 !== input.review.payloadSha256
      ) {
        throw new DirectAgentRuntimeCallbackError("direct_runtime.decision_binding_mismatch", true);
      }
      try {
        const decision = directPromptReviewDecisionRefSchema.parse({
          promptReviewDecisionId: response.decision.promptReviewDecisionId,
          revision: response.decision.revision,
          decisionSha256: response.decision.decisionSha256,
          kind: response.decision.kind,
        });
        const common = {
          review: input.review,
          decision,
          productRunRevision: response.runRevision,
        };
        if (response.status === "authorized") {
          if (
            decision.kind !== "approve" ||
            response.requestIndex !== input.review.requestIndex ||
            response.requestKind !== "agent_turn" ||
            response.providerId !== input.providerId ||
            response.modelId !== input.modelId ||
            response.endpointHost !== input.endpointHost ||
            response.payloadSha256 !== input.review.payloadSha256 ||
            response.reviewSha256 !== input.review.reviewSha256
          ) {
            throw new DirectAgentRuntimeCallbackError(
              "direct_runtime.provider_permit_binding_mismatch",
              true,
            );
          }
          return {
            ...common,
            status: "authorized",
            frozenPayload: z.json().parse(JSON.parse(response.canonicalPayloadJson)),
          };
        }
        if (response.status === "rejected" && decision.kind !== "reject") {
          throw new DirectAgentRuntimeCallbackError("direct_runtime.reject_binding_mismatch", true);
        }
        return { ...common, status: response.status };
      } catch (error) {
        if (error instanceof DirectAgentRuntimeCallbackError) throw error;
        // HTTP成功后Product可能已经消费一次性permit；任何本地解析失败都不能安全重试。
        throw new DirectAgentRuntimeCallbackError(
          "direct_runtime.provider_permit_response_invalid",
          true,
        );
      }
    },

    async commitDispatchOutcome(input) {
      const response = await postRuntime({
        options,
        path: DIRECT_AGENT_RUNTIME_PATHS.commitPromptReviewDispatchOutcome,
        body: commitPromptReviewDispatchOutcomeRuntimeRequestSchema.parse({
          schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        responseSchema: commitPromptReviewDispatchOutcomeRuntimeResponseSchema,
      });
      if (
        response.productRunId !== input.productRunId ||
        response.promptReviewRequestId !== input.promptReviewRequestId ||
        response.status !== input.outcome
      ) {
        throw new DirectAgentRuntimeCallbackError("direct_runtime.outcome_binding_mismatch", false);
      }
    },
  };

  const publishResult = async (input: PublishDirectAgentResultInput) => {
    const response = await postRuntime({
      options,
      path: DIRECT_AGENT_RUNTIME_PATHS.persistCandidate,
      body: persistDirectAgentCandidateRuntimeRequestSchema.parse({
        schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
        commandId: input.commandId,
        productRunId: input.productRunId,
        directAgentAttemptId: input.directAgentAttemptId,
        output: input.output,
      }),
      responseSchema: persistDirectAgentCandidateRuntimeResponseSchema,
    });
    if (response.productRunId !== input.productRunId) {
      throw new DirectAgentRuntimeCallbackError("direct_runtime.candidate_binding_mismatch", false);
    }
    return directAgentResultRefSchema.parse({
      directAgentCandidateId: response.directAgentCandidateId,
      sha256: response.sha256,
    });
  };

  const toolExecutionProduct: ToolExecutionProductPort = {
    async publish(input) {
      const response = await postRuntime({
        options,
        path: DIRECT_AGENT_RUNTIME_PATHS.publishToolExecutionIntent,
        body: publishToolExecutionIntentRuntimeRequestSchema.parse({
          schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
          scopeRef: input.capability.ref.scopeRef,
          effect: input.capability.effect,
        }),
        responseSchema: publishToolExecutionIntentRuntimeResponseSchema,
      });
      const expectedIntentId = `tei_${hashCanonical("id.tool-execution-intent.v1", {
        productRunId: input.productRunId,
        directAgentAttemptId: input.directAgentAttemptId,
        toolCallId: input.toolCallId,
        capabilityId: input.capability.ref.capabilityId,
        inputSha256: input.inputSha256,
      }).slice(0, 40)}`;
      if (
        response.toolExecutionIntentId !== expectedIntentId ||
        response.revision !== 1 ||
        response.status !== "waiting_decision"
      ) {
        throw new DirectAgentRuntimeCallbackError(
          "direct_runtime.tool_intent_binding_mismatch",
          true,
        );
      }
      return {
        toolExecutionIntentId: response.toolExecutionIntentId,
        revision: response.revision,
      };
    },
    async claim(input) {
      const response = await postRuntime({
        options,
        path: DIRECT_AGENT_RUNTIME_PATHS.claimToolExecutionDecision,
        body: claimToolExecutionDecisionRuntimeRequestSchema.parse({
          schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        responseSchema: claimToolExecutionDecisionRuntimeResponseSchema,
      });
      if (
        response.toolExecutionIntentId !== input.toolExecutionIntentId ||
        (response.status === "waiting_decision" && response.revision !== input.intentRevision) ||
        ((response.status === "authorized" || response.status === "rejected") &&
          (response.decisionIntentRevision !== input.intentRevision ||
            response.capabilityDescriptorSha256 !== input.capabilityDescriptorSha256 ||
            response.inputSha256 !== input.inputSha256 ||
            JSON.stringify(response.scopeRef) !== JSON.stringify(input.scopeRef)))
      ) {
        throw new DirectAgentRuntimeCallbackError(
          "direct_runtime.tool_decision_binding_mismatch",
          true,
        );
      }
      return response;
    },
    async commitResult(input) {
      const response = await postRuntime({
        options,
        path: DIRECT_AGENT_RUNTIME_PATHS.commitToolExecutionResult,
        body: commitToolExecutionResultRuntimeRequestSchema.parse({
          schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        responseSchema: commitToolExecutionResultRuntimeResponseSchema,
      });
      if (
        response.toolExecutionIntentId !== input.toolExecutionIntentId ||
        response.status !== input.outcome
      ) {
        throw new DirectAgentRuntimeCallbackError(
          "direct_runtime.tool_result_binding_mismatch",
          true,
        );
      }
    },
  };

  const projectBootstrapProduct: ProjectBootstrapProductPort = {
    async prepare(input) {
      const response = await postRuntime({
        options,
        path: DIRECT_AGENT_RUNTIME_PATHS.prepareProjectBootstrap,
        body: prepareProjectBootstrapRuntimeRequestSchema.parse({
          schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
          commandId: input.commandId,
          productRunId: input.productRunId,
          proposal: input.proposal,
        }),
        responseSchema: prepareProjectBootstrapRuntimeResponseSchema,
      });
      if (response.candidate.sourceProductRunId !== input.productRunId) {
        throw new DirectAgentRuntimeCallbackError(
          "direct_runtime.project_bootstrap_binding_mismatch",
          false,
        );
      }
      return response.candidate;
    },
  };

  return {
    authorizeOperation,
    promptReviewProduct,
    toolExecutionProduct,
    publishResult,
    projectBootstrapProduct,
  };
}
