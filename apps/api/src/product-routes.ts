import { Hono } from "hono";
import { ZodError } from "zod";
import {
  commandEnvelopeSchema,
  commandIdSchema,
  createSessionPayloadSchema,
  cursorPageRequestSchema,
  problemDetailSchema,
  productRunIdSchema,
  productSessionIdSchema,
  submitDecisionPayloadSchema,
  submitMessagePayloadSchema,
  createMemoryImportPayloadSchema,
  reconcileMemoryImportPayloadSchema,
  memoryImportIntentIdSchema,
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
  getRunContext,
  listMemoryBackends,
  newSpanId,
  runTraceId,
  submitPlanDecision,
  submitUserMessage,
  createMemoryImport,
  getMemoryImport,
  listSessionMemoryImports,
  requestMemoryImportReconciliation,
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

function parseMessagePageQuery(url: string): {
  cursor?: string | undefined;
  limit?: number | undefined;
} {
  const params = new URL(url).searchParams;
  for (const key of params.keys()) {
    if (key !== "cursor" && key !== "limit") {
      throw new ApplicationError({
        code: "validation_failed",
        httpStatus: 400,
        message: "消息分页查询包含未知参数",
      });
    }
  }
  const cursors = params.getAll("cursor");
  const limits = params.getAll("limit");
  if (cursors.length > 1 || limits.length > 1) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: "消息分页参数不得重复",
    });
  }
  const cursor = cursors[0];
  const limitRaw = limits[0];
  if (limitRaw !== undefined && !/^[0-9]+$/u.test(limitRaw)) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: "limit必须是1到200的整数",
    });
  }
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
  return cursorPageRequestSchema.parse({
    ...(cursor !== undefined ? { cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
}

function assertNoQuery(url: string): void {
  if ([...new URL(url).searchParams.keys()].length !== 0) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: "该查询不接受Query参数",
    });
  }
}

function emitCommandAccepted(
  ctx: ProductRouteContext,
  c: { get: (key: "requestId") => RequestId },
  input: {
    commandId: string;
    routeTemplate: string;
    statusCode: number;
    productRunId?: string;
    productSessionId?: string;
  },
): void {
  if (ctx.deps.trace === undefined) return;
  try {
    const productRunId =
      input.productRunId === undefined ? undefined : productRunIdSchema.parse(input.productRunId);
    const productSessionId =
      input.productSessionId === undefined
        ? undefined
        : productSessionIdSchema.parse(input.productSessionId);
    ctx.deps.trace({
      level: "info",
      eventName: "http.command.accepted",
      outcome: "success",
      traceId: productRunId !== undefined ? runTraceId(productRunId) : c.get("requestId"),
      spanId: newSpanId(),
      requestId: c.get("requestId"),
      httpMethod: "POST",
      routeTemplate: input.routeTemplate,
      statusCode: input.statusCode,
      commandId: commandIdSchema.parse(input.commandId),
      ...(productRunId !== undefined ? { productRunId } : {}),
      ...(productSessionId !== undefined ? { productSessionId } : {}),
    });
  } catch {
    // Trace故障不能把已经提交的产品命令改写成HTTP失败。
  }
}

export function createProductRouter(ctx: ProductRouteContext): Hono<{ Variables: Variables }> {
  const router = new Hono<{ Variables: Variables }>();

  router.get("/memory-backends", async (c) => {
    try {
      assertNoQuery(c.req.url);
      return c.json(await listMemoryBackends(ctx.deps), 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/memory-imports", async (c) => {
    try {
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = createMemoryImportPayloadSchema.parse(envelope.payload);
      const result = await createMemoryImport(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        payload,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/memory-imports",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/memory-imports/:memoryImportIntentId", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const memoryImportIntentId = memoryImportIntentIdSchema.parse(
        c.req.param("memoryImportIntentId"),
      );
      return c.json(
        {
          memoryImport: await getMemoryImport(ctx.deps, {
            principalId: ctx.principalId,
            memoryImportIntentId,
          }),
        },
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/memory-imports/:memoryImportIntentId/reconcile", async (c) => {
    try {
      const memoryImportIntentId = memoryImportIntentIdSchema.parse(
        c.req.param("memoryImportIntentId"),
      );
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      reconcileMemoryImportPayloadSchema.parse(envelope.payload);
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Memory Import对账必须携带expectedRevision",
        });
      }
      const result = await requestMemoryImportReconciliation(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        memoryImportIntentId,
        expectedResultRevision: envelope.expectedRevision,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/memory-imports/:memoryImportIntentId/reconcile",
        statusCode: 202,
      });
      return c.json(result, 202);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/sessions", async (c) => {
    try {
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = createSessionPayloadSchema.parse(envelope.payload);
      const result = await createProductSession(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        payload,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/sessions",
        statusCode: 201,
        productSessionId: result.session.sessionId,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/sessions/:sessionId", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const sessionId = productSessionIdSchema.parse(c.req.param("sessionId"));
      const result = await getSession(ctx.deps, { principalId: ctx.principalId, sessionId });
      return c.json(result, 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  /**
   * 调试导航④：浏览器Message Command进入Chat后端的唯一公开入口。
   *
   * 三层校验分别回答：URL属于哪个Session、命令是否有幂等身份、业务Payload是否符合公开合同。
   * submitUserMessage会在一个Product Store事务中提交Message、Run、ContextRequest、
   * Workflow Attempt和workflow_start Outbox；本Router不直接调用Workflow。
   * HTTP 201只表示这些Chat产品事实已提交，后台Workflow结果由后续Query投影。
   */
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
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/sessions/:sessionId/messages",
        statusCode: 201,
        productRunId: result.run.productRunId,
        productSessionId: sessionId,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/sessions/:sessionId/messages", async (c) => {
    try {
      const sessionId = productSessionIdSchema.parse(c.req.param("sessionId"));
      const { cursor, limit } = parseMessagePageQuery(c.req.url);
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

  router.get("/sessions/:sessionId/memory-imports", async (c) => {
    try {
      const sessionId = productSessionIdSchema.parse(c.req.param("sessionId"));
      const params = new URL(c.req.url).searchParams;
      if (
        [...params.keys()].some((key) => key !== "limit" && key !== "cursor") ||
        params.getAll("limit").length > 1 ||
        params.getAll("cursor").length > 1
      ) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Memory Import列表包含未知或重复参数",
        });
      }
      const rawLimit = params.get("limit");
      if (
        rawLimit !== null &&
        (!/^[0-9]+$/u.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100)
      ) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "limit必须是正整数",
        });
      }
      return c.json(
        await listSessionMemoryImports(ctx.deps, {
          principalId: ctx.principalId,
          sessionId,
          ...(rawLimit !== null ? { limit: Number(rawLimit) } : {}),
          ...(params.get("cursor") !== null
            ? { cursor: memoryImportIntentIdSchema.parse(params.get("cursor")) }
            : {}),
        }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  /**
   * 调试导航：下面4个Run Query是浏览器的权威回读面。
   * Run、Context、Plans和Approval分开投影，各自经过权限与公开DTO裁剪；它们只读Product Store，
   * 不读取Workflow返回值、Hook或pi会话。前端轮询这些资源，所以在这里断点会重复命中。
   */
  router.get("/runs/:productRunId", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const productRunId = productRunIdSchema.parse(c.req.param("productRunId"));
      const result = await getProductRun(ctx.deps, { principalId: ctx.principalId, productRunId });
      return c.json(result, 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/runs/:productRunId/context", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const productRunId = productRunIdSchema.parse(c.req.param("productRunId"));
      return c.json(
        await getRunContext(ctx.deps, { principalId: ctx.principalId, productRunId }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/runs/:productRunId/plans", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const productRunId = productRunIdSchema.parse(c.req.param("productRunId"));
      const result = await getRunPlans(ctx.deps, { principalId: ctx.principalId, productRunId });
      return c.json({ items: result.plans }, 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/runs/:productRunId/approvals/current", async (c) => {
    try {
      assertNoQuery(c.req.url);
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

  /**
   * 调试导航⑨：浏览器对当前Plan提交决定，而不是直接恢复Workflow Hook。
   *
   * expectedRevision是Product Run的乐观锁：用户看到旧计划后，若Run已变化，服务端返回409，
   * 防止旧页面批准新状态。submitPlanDecision会在同一事务中提交Decision、更新Plan/Approval/Run，
   * 并写入workflow_resume Outbox；201只表示决定已成为产品事实，不表示Hook已经恢复或执行完成。
   */
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
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/runs/:productRunId/decisions",
        statusCode: 201,
        productRunId,
        productSessionId: result.run.sessionId,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  return router;
}
