import { Hono, type Context } from "hono";
import { ZodError } from "zod";
import {
  compileExecutionContractRequestSchema,
  loadCommittedDecisionRequestSchema,
  persistExecutionCandidateRequestSchema,
  persistValidationResultRequestSchema,
  commitExecutionResultRequestSchema,
  commitRejectedRunRequestSchema,
  commitRunFailureRequestSchema,
  compilePlanningInputRequestSchema,
  completeRunAttemptRequestSchema,
  publishPlanReviewRequestSchema,
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
  loadCommittedDecision,
  persistExecutionCandidate,
  persistValidationResult,
  publishPlanForReview,
  beginRunAttempt,
  type ApplicationDeps,
} from "@chat/application";
import { z } from "zod";

/**
 * 后端私有Runtime Router（任务书§12.4）。
 *
 * 不变量：
 * - 只接受产品对象引用和稳定命令身份；不接受浏览器原始决定。
 * - 仅服务端持有的Runtime凭据；与公开API分Router、分DTO、分授权测试。
 * - 所有写命令仍经过strict Zod、Application Coordinator、CAS、Trace与幂等；
 *   本Router不是直接写Store的后门。
 */

const beginRunAttemptRequestSchema = z
  .object({
    schemaVersion: z.literal(INTERNAL_RUNTIME_SCHEMA_VERSION),
    commandId: z.string().regex(/^cmd_[A-Za-z0-9]+$/),
    productRunId: z.string().regex(/^run_[A-Za-z0-9]+$/),
    kind: z.enum(["planning", "execution"]),
    planRevision: z.number().int().positive().optional(),
    stepId: z.string().min(1).max(100).optional(),
  })
  .strict();

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
    "/compile-planning-input",
    handle(200, async (c) => {
      const request = compilePlanningInputRequestSchema.parse(await c.req.json());
      return compilePlanningInput(options.deps, request);
    }),
  );

  router.post(
    "/publish-plan-review",
    handle(201, async (c) => {
      const request = publishPlanReviewRequestSchema.parse(await c.req.json());
      const result = await publishPlanForReview(options.deps, {
        productRunId: request.productRunId,
        commandId: request.commandId,
        content: request.content,
        attemptId: request.attemptId,
      });
      return {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        planId: result.plan.planId,
        planRevision: result.plan.planRevision,
        planSha256: result.plan.sha256,
        approvalRequestId: result.approval.approvalRequestId,
      };
    }),
  );

  router.post(
    "/load-committed-decision",
    handle(200, async (c) => {
      const request = loadCommittedDecisionRequestSchema.parse(await c.req.json());
      return loadCommittedDecision(options.deps, request);
    }),
  );

  router.post(
    "/compile-execution-contract",
    handle(201, async (c) => {
      const request = compileExecutionContractRequestSchema.parse(await c.req.json());
      const result = await compileExecutionContract(options.deps, request);
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, contract: result.contract };
    }),
  );

  router.post(
    "/begin-run-attempt",
    handle(201, async (c) => {
      const request = beginRunAttemptRequestSchema.parse(await c.req.json());
      const result = await beginRunAttempt(options.deps, {
        commandId: request.commandId as never,
        productRunId: request.productRunId as never,
        kind: request.kind,
        ...(request.planRevision !== undefined ? { planRevision: request.planRevision } : {}),
        ...(request.stepId !== undefined ? { stepId: request.stepId } : {}),
      });
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, attemptId: result.attemptId };
    }),
  );

  router.post(
    "/complete-run-attempt",
    handle(200, async (c) => {
      const request = completeRunAttemptRequestSchema.parse(await c.req.json());
      if (request.outcome === "running") {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "complete-run-attempt不接受running outcome",
        });
      }
      const result = await completeRunAttempt(options.deps, {
        commandId: request.commandId,
        attemptId: request.attemptId,
        outcome: request.outcome,
        ...(request.errorCode !== undefined ? { errorCode: request.errorCode } : {}),
      });
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, revision: result.revision };
    }),
  );

  router.post(
    "/persist-execution-candidate",
    handle(201, async (c) => {
      const request = persistExecutionCandidateRequestSchema.parse(await c.req.json());
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
      const request = persistValidationResultRequestSchema.parse(await c.req.json());
      const result = await persistValidationResult(options.deps, request);
      return {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        validationResultId: result.validationResultId,
      };
    }),
  );

  router.post(
    "/commit-execution-result",
    handle(201, async (c) => {
      const request = commitExecutionResultRequestSchema.parse(await c.req.json());
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
      const request = commitRejectedRunRequestSchema.parse(await c.req.json());
      const result = await commitRejectedRun(options.deps, request);
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, revision: result.revision };
    }),
  );

  router.post(
    "/commit-run-failure",
    handle(200, async (c) => {
      const request = commitRunFailureRequestSchema.parse(await c.req.json());
      const result = await commitRunFailure(options.deps, request);
      return { schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION, revision: result.revision };
    }),
  );

  return router;
}
