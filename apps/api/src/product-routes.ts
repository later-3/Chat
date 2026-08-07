import { Hono } from "hono";
import { ZodError } from "zod";
import {
  commandEnvelopeSchema,
  createSessionPayloadSchema,
  problemDetailSchema,
  productRunIdSchema,
  productSessionIdSchema,
  submitDecisionPayloadSchema,
  submitMessagePayloadSchema,
  type PrincipalId,
  type ProblemDetail,
  type RequestId,
} from "@chat/contracts";
import {
  ApplicationError,
  CommandIdReusedError,
  StoreCorruptedError,
  createProductSession,
  getCurrentApproval,
  getProductRun,
  getRunPlans,
  getSession,
  getSessionMessages,
  submitPlanDecision,
  submitUserMessage,
  type ApplicationDeps,
} from "@chat/application";

/**
 * B2公开产品路由（任务书§12.1）。
 *
 * 边界：Router只做DTO校验、Principal上下文和Problem Detail投影；
 * 产品事务属于Application用例；Router不得直接读写JSON Store。
 */

export interface ProductRouteContext {
  readonly deps: ApplicationDeps;
  readonly principalId: PrincipalId;
}

type Variables = { requestId: RequestId };

function problem(
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
  return c.json(problemDetailSchema.parse(body), options.status);
}

function mapError(
  c: { json: (body: unknown, status: number) => Response; get: (key: "requestId") => RequestId },
  error: unknown,
): Response {
  if (error instanceof ApplicationError) {
    return problem(c, {
      status: error.httpStatus,
      code: error.code,
      title: error.message,
      retryable: error.retryable,
      recoveryAction: error.recoveryAction,
    });
  }
  if (error instanceof CommandIdReusedError) {
    return problem(c, {
      status: 409,
      code: "command_id_reused",
      title: "commandId已被不同请求使用",
      retryable: false,
      recoveryAction: "none",
    });
  }
  if (error instanceof StoreCorruptedError) {
    return problem(c, {
      status: 500,
      code: "store_corrupted",
      title: "Product Store不可用",
      retryable: false,
      recoveryAction: "contact_support",
    });
  }
  if (error instanceof ZodError) {
    return problem(c, {
      status: 400,
      code: "validation_failed",
      title: "请求不符合合同",
      retryable: false,
      recoveryAction: "none",
    });
  }
  return problem(c, {
    status: 500,
    code: "internal_error",
    title: "内部错误",
    retryable: false,
    recoveryAction: "none",
  });
}

async function parseJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
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

export function createProductRouter(ctx: ProductRouteContext): Hono<{ Variables: Variables }> {
  const router = new Hono<{ Variables: Variables }>();

  router.post("/sessions", async (c) => {
    try {
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = createSessionPayloadSchema.parse(envelope.payload);
      const result = await createProductSession(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        payload,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/sessions/:sessionId", async (c) => {
    try {
      const sessionId = productSessionIdSchema.parse(c.req.param("sessionId"));
      const result = await getSession(ctx.deps, { principalId: ctx.principalId, sessionId });
      return c.json(result, 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/sessions/:sessionId/messages", async (c) => {
    try {
      const sessionId = productSessionIdSchema.parse(c.req.param("sessionId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = submitMessagePayloadSchema.parse(envelope.payload);
      const result = await submitUserMessage(ctx.deps, {
        principalId: ctx.principalId,
        sessionId,
        commandId: envelope.commandId,
        payload,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/sessions/:sessionId/messages", async (c) => {
    try {
      const sessionId = productSessionIdSchema.parse(c.req.param("sessionId"));
      const cursor = c.req.query("cursor");
      const limitRaw = c.req.query("limit");
      const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : undefined;
      if (
        limitRaw !== undefined &&
        (!Number.isSafeInteger(limit) || limit === undefined || limit < 1 || limit > 200)
      ) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "limit必须是1到200的整数",
        });
      }
      const result = await getSessionMessages(ctx.deps, {
        principalId: ctx.principalId,
        sessionId,
        cursor,
        limit,
      });
      return c.json(result.messages, 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/runs/:productRunId", async (c) => {
    try {
      const productRunId = productRunIdSchema.parse(c.req.param("productRunId"));
      const result = await getProductRun(ctx.deps, { principalId: ctx.principalId, productRunId });
      return c.json(result, 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/runs/:productRunId/plans", async (c) => {
    try {
      const productRunId = productRunIdSchema.parse(c.req.param("productRunId"));
      const result = await getRunPlans(ctx.deps, { principalId: ctx.principalId, productRunId });
      return c.json({ items: result.plans }, 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/runs/:productRunId/approvals/current", async (c) => {
    try {
      const productRunId = productRunIdSchema.parse(c.req.param("productRunId"));
      const result = await getCurrentApproval(ctx.deps, {
        principalId: ctx.principalId,
        productRunId,
      });
      return c.json(result, 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/runs/:productRunId/decisions", async (c) => {
    try {
      const productRunId = productRunIdSchema.parse(c.req.param("productRunId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Decision Command必须携带expectedRevision",
        });
      }
      const payload = submitDecisionPayloadSchema.parse(envelope.payload);
      const result = await submitPlanDecision(ctx.deps, {
        principalId: ctx.principalId,
        productRunId,
        commandId: envelope.commandId,
        expectedRunRevision: envelope.expectedRevision,
        payload,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  return router;
}
