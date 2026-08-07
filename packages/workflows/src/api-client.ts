import {
  commitExecutionResultResponseSchema,
  commitRejectedRunRequestSchema,
  commitRunFailureRequestSchema,
  completeRunAttemptRequestSchema,
  compileExecutionContractResponseSchema,
  loadCommittedDecisionResponseSchema,
  persistExecutionCandidateResponseSchema,
  persistValidationResultResponseSchema,
  planningInputDtoSchema,
  publishPlanReviewResponseSchema,
  runRevisionResponseSchema,
  INTERNAL_RUNTIME_SCHEMA_VERSION,
  type CompilePlanningInputRequest,
  type CommitExecutionResultRequest,
  type CompileExecutionContractRequest,
  type LoadCommittedDecisionRequest,
  type PersistExecutionCandidateRequest,
  type PersistValidationResultRequest,
  type PublishPlanReviewRequest,
} from "@chat/contracts";
import { z, type ZodType } from "zod";

/**
 * Workflow Runtime -> API私有Runtime Router的类型化客户端。
 *
 * 边界：
 * - 只调用后端私有Application Command；不直接读写Product Store。
 * - 凭据只在服务端内存中使用；所有请求/响应经Zod校验。
 * - 网络未知结果与业务冲突是不同错误族：unknown不自动重试付费路径。
 */

export class ApiClientError extends Error {
  readonly code: string;
  readonly httpStatus: number | undefined;
  readonly retryable: boolean;
  constructor(options: {
    code: string;
    message: string;
    httpStatus?: number;
    retryable?: boolean;
  }) {
    super(options.message);
    this.name = "ApiClientError";
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.retryable = options.retryable ?? false;
  }
}

export interface RuntimeApiClientOptions {
  readonly baseUrl: string;
  readonly credential: string;
}

async function call<TReq, TRes>(
  options: RuntimeApiClientOptions,
  path: string,
  body: TReq,
  responseSchema: ZodType<TRes>,
): Promise<TRes> {
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-chat-runtime-key": options.credential,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiClientError({
      code: "dispatch.outcome_unknown",
      message: `私有命令网络结果未知:${path}`,
      retryable: true,
    });
  }
  if (!response.ok) {
    let code = "internal_error";
    try {
      const problem = (await response.json()) as { code?: string };
      if (typeof problem.code === "string") code = problem.code;
    } catch {
      // 保留默认错误码
    }
    throw new ApiClientError({
      code,
      message: `私有命令被拒绝:${path}:${code}`,
      httpStatus: response.status,
    });
  }
  const json: unknown = await response.json();
  return responseSchema.parse(json);
}

export function createRuntimeApiClient(options: RuntimeApiClientOptions) {
  return {
    compilePlanningInput(input: Omit<CompilePlanningInputRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/compile-planning-input",
        { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, ...input },
        planningInputDtoSchema,
      );
    },
    publishPlanReview(input: Omit<PublishPlanReviewRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/publish-plan-review",
        { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, ...input },
        publishPlanReviewResponseSchema,
      );
    },
    loadCommittedDecision(input: Omit<LoadCommittedDecisionRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/load-committed-decision",
        { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, ...input },
        loadCommittedDecisionResponseSchema,
      );
    },
    compileExecutionContract(input: Omit<CompileExecutionContractRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/compile-execution-contract",
        { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, ...input },
        compileExecutionContractResponseSchema,
      );
    },
    beginRunAttempt(input: {
      commandId: string;
      productRunId: string;
      kind: "planning" | "execution";
      planRevision?: number;
      stepId?: string;
    }) {
      return call(
        options,
        "/internal/runtime/v1/begin-run-attempt",
        { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, ...input },
        z
          .object({
            schemaVersion: z.literal(INTERNAL_RUNTIME_SCHEMA_VERSION),
            attemptId: z.string(),
          })
          .strict(),
      );
    },
    completeRunAttempt(input: {
      commandId: string;
      attemptId: string;
      outcome: "success" | "failure";
      errorCode?: string;
    }) {
      return call(
        options,
        "/internal/runtime/v1/complete-run-attempt",
        completeRunAttemptRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        runRevisionResponseSchema,
      );
    },
    persistExecutionCandidate(input: Omit<PersistExecutionCandidateRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/persist-execution-candidate",
        { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, ...input },
        persistExecutionCandidateResponseSchema,
      );
    },
    persistValidationResult(input: Omit<PersistValidationResultRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/persist-validation-result",
        { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, ...input },
        persistValidationResultResponseSchema,
      );
    },
    commitExecutionResult(input: Omit<CommitExecutionResultRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/commit-execution-result",
        { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, ...input },
        commitExecutionResultResponseSchema,
      );
    },
    commitRejectedRun(input: { commandId: string; productRunId: string; decisionId: string }) {
      return call(
        options,
        "/internal/runtime/v1/commit-rejected-run",
        commitRejectedRunRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        runRevisionResponseSchema,
      );
    },
    commitRunFailure(input: {
      commandId: string;
      productRunId: string;
      errorCode: string;
      summary: string;
    }) {
      return call(
        options,
        "/internal/runtime/v1/commit-run-failure",
        commitRunFailureRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        runRevisionResponseSchema,
      );
    },
  };
}

export type RuntimeApiClient = ReturnType<typeof createRuntimeApiClient>;
