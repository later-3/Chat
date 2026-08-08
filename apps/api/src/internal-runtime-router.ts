import { Hono, type Context } from "hono";
import { ZodError } from "zod";
import {
  compileExecutionContractRequestSchema,
  beginRunAttemptRequestSchema,
  loadCommittedDecisionRequestSchema,
  persistExecutionCandidateRequestSchema,
  persistValidationResultRequestSchema,
  commitExecutionResultRequestSchema,
  commitRejectedRunRequestSchema,
  commitRunFailureRequestSchema,
  compilePlanningInputRequestSchema,
  completeRunAttemptRequestSchema,
  expireApprovalRequestSchema,
  publishPlanReviewRequestSchema,
  preparePlanningContextRequestSchema,
  persistPlanningContextResultRequestSchema,
  loadMemoryImportRequestSchema,
  markMemoryImportDispatchingRequestSchema,
  commitMemoryImportAcceptedRequestSchema,
  commitMemoryImportMaterializedRequestSchema,
  commitMemoryImportFailedRequestSchema,
  commitMemoryImportOutcomeUnknownRequestSchema,
  INTERNAL_RUNTIME_SCHEMA_VERSION,
  type ProblemDetail,
  type RequestId,
} from "@chat/contracts";
import {
  ApplicationError,
  CommandIdReusedError,
  StoreCorruptedError,
  compileExecutionContract,
  compilePlanningInput,
  commitExecutionResult,
  commitRejectedRun,
  commitRunFailure,
  completeRunAttempt,
  expireApproval,
  loadCommittedDecision,
  persistExecutionCandidate,
  persistValidationResult,
  publishPlanForReview,
  beginRunAttempt,
  beginPlanningContext,
  persistPlanningContextResult,
  loadMemoryImportForRuntime,
  markMemoryImportDispatching,
  commitMemoryImportAccepted,
  commitMemoryImportMaterialized,
  commitMemoryImportFailed,
  commitMemoryImportOutcomeUnknown,
  type ApplicationDeps,
} from "@chat/application";

/**
 * 后端私有Runtime Router（任务书§12.4）。
 *
 * 不变量：
 * - 只接受产品对象引用和稳定命令身份；不接受浏览器原始决定。
 * - 仅服务端持有的Runtime凭据；与公开API分Router、分DTO、分授权测试。
 * - 所有写命令仍经过strict Zod、Application Coordinator、CAS、Trace与幂等；
 *   本Router不是直接写Store的后门。
 */

type Variables = { requestId: RequestId };

function internalProblem(
  c: { json: (body: unknown, status: number) => Response; get: (key: "requestId") => RequestId },
  options: {
    status: number;
    code: ProblemDetail["code"];
    title: string;
    retryable: boolean;
    recoveryAction: ProblemDetail["recoveryAction"];
  },
): Response {
  const body: ProblemDetail = {
    type: `https://chat.dev/problems/${options.code.replaceAll("_", "-")}`,
    title: options.title,
    status: options.status,
    code: options.code,
    requestId: c.get("requestId"),
    retryable: options.retryable,
    recoveryAction: options.recoveryAction,
  };
  return c.json(body, options.status);
}

function mapInternalError(
  c: { json: (body: unknown, status: number) => Response; get: (key: "requestId") => RequestId },
  error: unknown,
): Response {
  if (error instanceof ApplicationError) {
    return internalProblem(c, {
      status: error.httpStatus,
      code: error.code,
      title: error.message,
      retryable: error.retryable,
      recoveryAction: error.recoveryAction,
    });
  }
  if (error instanceof CommandIdReusedError) {
    return internalProblem(c, {
      status: 409,
      code: "command_id_reused",
      title: "commandId已被不同请求使用",
      retryable: false,
      recoveryAction: "none",
    });
  }
  if (error instanceof StoreCorruptedError) {
    return internalProblem(c, {
      status: 500,
      code: "store_corrupted",
      title: "Product Store不可用",
      retryable: false,
      recoveryAction: "contact_support",
    });
  }
  if (error instanceof ZodError) {
    return internalProblem(c, {
      status: 400,
      code: "validation_failed",
      title: "请求不符合合同",
      retryable: false,
      recoveryAction: "none",
    });
  }
  return internalProblem(c, {
    status: 500,
    code: "internal_error",
    title: "内部错误",
    retryable: false,
    recoveryAction: "none",
  });
}

type Ctx = Context<{ Variables: Variables }>;

async function parseInternalBody(c: Ctx): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: "请求体不是合法JSON",
    });
  }
}

function handle<S extends 200 | 201, T>(status: S, fn: (c: Ctx) => Promise<T>) {
  return async (c: Ctx): Promise<Response> => {
    try {
      return c.json(await fn(c), status);
    } catch (error) {
      return mapInternalError(c, error);
    }
  };
}

export interface InternalRuntimeRouterOptions {
  readonly deps: ApplicationDeps;
  readonly credential: string;
}

export function createInternalRuntimeRouter(
  options: InternalRuntimeRouterOptions,
): Hono<{ Variables: Variables }> {
  const router = new Hono<{ Variables: Variables }>();

  router.use("*", async (c, next) => {
    if (c.req.header("x-chat-runtime-key") !== options.credential) {
      return internalProblem(c, {
        status: 403,
        code: "forbidden",
        title: "Runtime凭据无效",
        retryable: false,
        recoveryAction: "none",
      });
    }
    await next();
  });

  router.post(
    "/begin-planning-context",
    handle(200, async (c) => {
      const request = preparePlanningContextRequestSchema.parse(await parseInternalBody(c));
      return beginPlanningContext(options.deps, request);
    }),
  );

  router.post(
    "/persist-planning-context-result",
    handle(200, async (c) => {
      const request = persistPlanningContextResultRequestSchema.parse(await parseInternalBody(c));
      return persistPlanningContextResult(options.deps, request);
    }),
  );

  router.post(
    "/compile-planning-input",
    handle(200, async (c) => {
      const request = compilePlanningInputRequestSchema.parse(await parseInternalBody(c));
      return compilePlanningInput(options.deps, request);
    }),
  );

  router.post(
    "/publish-plan-review",
    handle(201, async (c) => {
      const request = publishPlanReviewRequestSchema.parse(await parseInternalBody(c));
      const result = await publishPlanForReview(options.deps, {
        productRunId: request.productRunId,
        commandId: request.commandId,
        content: request.content,
        attemptId: request.attemptId,
        expectedRunRevision: request.expectedRunRevision,
        inputManifestSha256: request.inputManifestSha256,
      });
      return {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        planId: result.plan.planId,
        planRevision: result.plan.planRevision,
        planSha256: result.plan.sha256,
        approvalRequestId: result.approval.approvalRequestId,
        approvalExpiresAt: result.approval.expiresAt,
      };
    }),
  );

  router.post(
    "/load-committed-decision",
    handle(200, async (c) => {
      const request = loadCommittedDecisionRequestSchema.parse(await parseInternalBody(c));
      return loadCommittedDecision(options.deps, request);
    }),
  );

  router.post(
    "/compile-execution-contract",
    handle(201, async (c) => {
      const request = compileExecutionContractRequestSchema.parse(await parseInternalBody(c));
      const result = await compileExecutionContract(options.deps, request);
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, contract: result.contract };
    }),
  );

  router.post(
    "/begin-run-attempt",
    handle(201, async (c) => {
      const request = beginRunAttemptRequestSchema.parse(await parseInternalBody(c));
      const result = await beginRunAttempt(options.deps, request);
      return {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        attemptId: result.attemptId,
        inputManifestSha256: result.inputManifestSha256,
        contextItems: result.contextItems,
      };
    }),
  );

  router.post(
    "/complete-run-attempt",
    handle(200, async (c) => {
      const request = completeRunAttemptRequestSchema.parse(await parseInternalBody(c));
      const result = await completeRunAttempt(options.deps, request);
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, revision: result.revision };
    }),
  );

  router.post(
    "/persist-execution-candidate",
    handle(201, async (c) => {
      const request = persistExecutionCandidateRequestSchema.parse(await parseInternalBody(c));
      const result = await persistExecutionCandidate(options.deps, request);
      return {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        executionCandidateId: result.executionCandidateId,
        sha256: result.sha256,
      };
    }),
  );

  router.post(
    "/persist-validation-result",
    handle(201, async (c) => {
      const request = persistValidationResultRequestSchema.parse(await parseInternalBody(c));
      const result = await persistValidationResult(options.deps, request);
      return {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        validationResultId: result.validationResultId,
        outcome: result.outcome,
        failures: result.failures,
      };
    }),
  );

  router.post(
    "/commit-execution-result",
    handle(201, async (c) => {
      const request = commitExecutionResultRequestSchema.parse(await parseInternalBody(c));
      const result = await commitExecutionResult(options.deps, request);
      return {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        finalMessageId: result.finalMessageId,
        revision: result.revision,
      };
    }),
  );

  router.post(
    "/commit-rejected-run",
    handle(200, async (c) => {
      const request = commitRejectedRunRequestSchema.parse(await parseInternalBody(c));
      const result = await commitRejectedRun(options.deps, request);
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, revision: result.revision };
    }),
  );

  router.post(
    "/expire-approval",
    handle(200, async (c) => {
      const request = expireApprovalRequestSchema.parse(await parseInternalBody(c));
      const result = await expireApproval(options.deps, request);
      return {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        status: result.status,
        revision: result.revision,
      };
    }),
  );

  router.post(
    "/commit-run-failure",
    handle(200, async (c) => {
      const request = commitRunFailureRequestSchema.parse(await parseInternalBody(c));
      const result = await commitRunFailure(options.deps, request);
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, revision: result.revision };
    }),
  );

  router.post(
    "/memory-import/load",
    handle(200, async (c) => {
      const request = loadMemoryImportRequestSchema.parse(await parseInternalBody(c));
      const loaded = await loadMemoryImportForRuntime(options.deps, request);
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, ...loaded };
    }),
  );

  router.post(
    "/memory-import/mark-dispatching",
    handle(200, async (c) => {
      const request = markMemoryImportDispatchingRequestSchema.parse(await parseInternalBody(c));
      const result = await markMemoryImportDispatching(options.deps, {
        commandId: request.commandId,
        memoryImportIntentId: request.memoryImportIntentId,
        memoryImportResultId: request.memoryImportResultId,
        requestSha256: request.requestSha256,
        expectedRevision: request.expectedRevision,
      });
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, result };
    }),
  );

  router.post(
    "/memory-import/commit-accepted",
    handle(200, async (c) => {
      const request = commitMemoryImportAcceptedRequestSchema.parse(await parseInternalBody(c));
      const result = await commitMemoryImportAccepted(options.deps, {
        commandId: request.commandId,
        memoryImportIntentId: request.memoryImportIntentId,
        memoryImportResultId: request.memoryImportResultId,
        requestSha256: request.requestSha256,
        expectedRevision: request.expectedRevision,
        ...(request.reconciled !== undefined ? { reconciled: request.reconciled } : {}),
        accepted: {
          externalObjectId: request.accepted.externalObjectId,
          responseSha256: request.accepted.responseSha256,
          ...(request.accepted.externalObjectVersion !== undefined
            ? { externalObjectVersion: request.accepted.externalObjectVersion }
            : {}),
          ...(request.accepted.externalStatus !== undefined
            ? { externalStatus: request.accepted.externalStatus }
            : {}),
        },
      });
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, result };
    }),
  );

  router.post(
    "/memory-import/commit-materialized",
    handle(200, async (c) => {
      const request = commitMemoryImportMaterializedRequestSchema.parse(await parseInternalBody(c));
      const result = await commitMemoryImportMaterialized(options.deps, {
        commandId: request.commandId,
        memoryImportIntentId: request.memoryImportIntentId,
        memoryImportResultId: request.memoryImportResultId,
        requestSha256: request.requestSha256,
        expectedRevision: request.expectedRevision,
        verificationSha256: request.verificationSha256,
        ...(request.reconciled !== undefined ? { reconciled: request.reconciled } : {}),
        accepted: {
          externalObjectId: request.accepted.externalObjectId,
          responseSha256: request.accepted.responseSha256,
          ...(request.accepted.externalObjectVersion !== undefined
            ? { externalObjectVersion: request.accepted.externalObjectVersion }
            : {}),
          ...(request.accepted.externalStatus !== undefined
            ? { externalStatus: request.accepted.externalStatus }
            : {}),
        },
      });
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, result };
    }),
  );

  router.post(
    "/memory-import/commit-failed",
    handle(200, async (c) => {
      const request = commitMemoryImportFailedRequestSchema.parse(await parseInternalBody(c));
      const result = await commitMemoryImportFailed(options.deps, {
        commandId: request.commandId,
        memoryImportIntentId: request.memoryImportIntentId,
        memoryImportResultId: request.memoryImportResultId,
        requestSha256: request.requestSha256,
        expectedRevision: request.expectedRevision,
        errorCode: request.errorCode,
        summary: request.summary,
        ...(request.reconciled !== undefined ? { reconciled: request.reconciled } : {}),
      });
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, result };
    }),
  );

  router.post(
    "/memory-import/commit-outcome-unknown",
    handle(200, async (c) => {
      const request = commitMemoryImportOutcomeUnknownRequestSchema.parse(
        await parseInternalBody(c),
      );
      const result = await commitMemoryImportOutcomeUnknown(options.deps, {
        commandId: request.commandId,
        memoryImportIntentId: request.memoryImportIntentId,
        memoryImportResultId: request.memoryImportResultId,
        requestSha256: request.requestSha256,
        expectedRevision: request.expectedRevision,
        errorCode: request.errorCode,
        ...(request.reconciled !== undefined ? { reconciled: request.reconciled } : {}),
      });
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, result };
    }),
  );

  return router;
}
