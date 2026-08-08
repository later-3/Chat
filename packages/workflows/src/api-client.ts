import {
  commitExecutionResultResponseSchema,
  commitRejectedRunRequestSchema,
  commitRunFailureRequestSchema,
  completeRunAttemptRequestSchema,
  beginRunAttemptRequestSchema,
  beginRunAttemptResponseSchema,
  expireApprovalRequestSchema,
  expireApprovalResponseSchema,
  compileExecutionContractResponseSchema,
  loadCommittedDecisionResponseSchema,
  persistExecutionCandidateResponseSchema,
  persistValidationResultResponseSchema,
  planningInputDtoSchema,
  beginPlanningContextResponseSchema,
  preparePlanningContextResponseSchema,
  persistPlanningContextResultRequestSchema,
  publishPlanReviewResponseSchema,
  problemDetailSchema,
  runRevisionResponseSchema,
  loadMemoryImportResponseSchema,
  memoryImportResultResponseSchema,
  markMemoryImportDispatchingRequestSchema,
  commitMemoryImportAcceptedRequestSchema,
  commitMemoryImportMaterializedRequestSchema,
  commitMemoryImportFailedRequestSchema,
  commitMemoryImportOutcomeUnknownRequestSchema,
  INTERNAL_RUNTIME_SCHEMA_VERSION,
  MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
  type CompilePlanningInputRequest,
  type CommitExecutionResultRequest,
  type CompileExecutionContractRequest,
  type LoadCommittedDecisionRequest,
  type PersistExecutionCandidateRequest,
  type PersistValidationResultRequest,
  type PreparePlanningContextRequest,
  type PersistPlanningContextResultRequest,
  type PublishPlanReviewRequest,
  type LoadMemoryImportRequest,
} from "@chat/contracts";
import type { ZodType } from "zod";

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
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ApiClientError({
      code: "dispatch.outcome_unknown",
      message: `私有命令网络结果未知:${path}`,
      retryable: true,
    });
  }
  if (!response.ok) {
    let problem: ReturnType<typeof problemDetailSchema.parse>;
    try {
      problem = problemDetailSchema.parse(await response.json());
    } catch {
      throw new ApiClientError({
        code: "internal_error",
        message: `私有命令错误响应合同损坏:${path}`,
        httpStatus: response.status,
        retryable: response.status >= 500,
      });
    }
    throw new ApiClientError({
      code: problem.code,
      message: `私有命令被拒绝:${path}:${problem.code}`,
      httpStatus: response.status,
      retryable: problem.retryable,
    });
  }
  try {
    return responseSchema.parse(await response.json());
  } catch {
    throw new ApiClientError({
      code: "dispatch.outcome_unknown",
      message: `私有命令成功响应合同损坏:${path}`,
      retryable: true,
    });
  }
}

export function createRuntimeApiClient(options: RuntimeApiClientOptions) {
  return {
    beginPlanningContext(input: Omit<PreparePlanningContextRequest, "schemaVersion">) {
      return call(
        options,
        "/internal/runtime/v1/begin-planning-context",
        { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, ...input },
        beginPlanningContextResponseSchema,
      );
    },
    persistPlanningContextResult(
      input: Omit<PersistPlanningContextResultRequest, "schemaVersion">,
    ) {
      return call(
        options,
        "/internal/runtime/v1/persist-planning-context-result",
        persistPlanningContextResultRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        preparePlanningContextResponseSchema,
      );
    },
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
      kind: "execution";
      executionContractId: string;
      stepId: string;
      dependencyRefs: readonly {
        stepId: string;
        executionAttemptId: string;
        sha256: string;
      }[];
      promptTemplateVersion: string;
      modelConfigVersion: string;
    }) {
      return call(
        options,
        "/internal/runtime/v1/begin-run-attempt",
        beginRunAttemptRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        beginRunAttemptResponseSchema,
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
    expireApproval(input: {
      commandId: string;
      productRunId: string;
      approvalRequestId: string;
      expectedExpiresAt: string;
    }) {
      return call(
        options,
        "/internal/runtime/v1/expire-approval",
        expireApprovalRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          ...input,
        }),
        expireApprovalResponseSchema,
      );
    },
    loadMemoryImport(
      input: Omit<LoadMemoryImportRequest, "schemaVersion" | "workflowDefinitionVersion">,
    ) {
      return call(
        options,
        "/internal/runtime/v1/memory-import/load",
        {
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
          ...input,
        },
        loadMemoryImportResponseSchema,
      );
    },
    markMemoryImportDispatching(input: {
      commandId: string;
      memoryImportIntentId: string;
      memoryImportResultId: string;
      requestSha256: string;
      expectedRevision: number;
    }) {
      return call(
        options,
        "/internal/runtime/v1/memory-import/mark-dispatching",
        markMemoryImportDispatchingRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
          ...input,
        }),
        memoryImportResultResponseSchema,
      );
    },
    commitMemoryImportAccepted(input: {
      commandId: string;
      memoryImportIntentId: string;
      memoryImportResultId: string;
      requestSha256: string;
      expectedRevision: number;
      accepted: {
        externalObjectId: string;
        externalObjectVersion?: string;
        externalStatus?: string;
        responseSha256: string;
      };
      reconciled?: boolean;
    }) {
      return call(
        options,
        "/internal/runtime/v1/memory-import/commit-accepted",
        commitMemoryImportAcceptedRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
          ...input,
        }),
        memoryImportResultResponseSchema,
      );
    },
    commitMemoryImportMaterialized(input: {
      commandId: string;
      memoryImportIntentId: string;
      memoryImportResultId: string;
      requestSha256: string;
      expectedRevision: number;
      accepted: {
        externalObjectId: string;
        externalObjectVersion?: string;
        externalStatus?: string;
        responseSha256: string;
      };
      verificationKind: "read_by_id_and_search" | "l0_and_session_l1";
      verificationSha256: string;
      reconciled?: boolean;
    }) {
      return call(
        options,
        "/internal/runtime/v1/memory-import/commit-materialized",
        commitMemoryImportMaterializedRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
          ...input,
        }),
        memoryImportResultResponseSchema,
      );
    },
    commitMemoryImportFailed(input: {
      commandId: string;
      memoryImportIntentId: string;
      memoryImportResultId: string;
      requestSha256: string;
      expectedRevision: number;
      errorCode: string;
      summary: string;
      reconciled?: boolean;
    }) {
      return call(
        options,
        "/internal/runtime/v1/memory-import/commit-failed",
        commitMemoryImportFailedRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
          ...input,
        }),
        memoryImportResultResponseSchema,
      );
    },
    commitMemoryImportOutcomeUnknown(input: {
      commandId: string;
      memoryImportIntentId: string;
      memoryImportResultId: string;
      requestSha256: string;
      expectedRevision: number;
      errorCode: string;
      reconciled?: boolean;
    }) {
      return call(
        options,
        "/internal/runtime/v1/memory-import/commit-outcome-unknown",
        commitMemoryImportOutcomeUnknownRequestSchema.parse({
          schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
          workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
          ...input,
        }),
        memoryImportResultResponseSchema,
      );
    },
  };
}

export type RuntimeApiClient = ReturnType<typeof createRuntimeApiClient>;
