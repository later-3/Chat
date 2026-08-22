/**
 * Session路由族：创建与详情/消息分页。只终止协议，产品事务由Application拥有。
 */
import {} from "hono";
import {
  commandEnvelopeSchema,
  createSessionPayloadSchema,
  productSessionIdSchema,
  submitMessagePayloadSchema,
  memoryImportIntentIdSchema,
  memoryWriteIntentIdSchema,
  messageIdSchema,
} from "@chat/contracts";
import {
  ApplicationError,
  createProductSession,
  getSession,
  getSessionMessage,
  getSessionMessages,
  submitUserMessage,
  listSessionMemoryImports,
  listMemoryWrites,
} from "@chat/application";
import {
  type ProductRouteContext,
  mapError,
  parseJsonBody,
  parseMessagePageQuery,
  assertNoQuery,
  emitCommandAccepted,
  type ProductRouter,
} from "./shared.js";

export function registerSessionCreateRoutes(router: ProductRouter, ctx: ProductRouteContext): void {
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
}

export function registerSessionDetailRoutes(router: ProductRouter, ctx: ProductRouteContext): void {
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
   * 首轮只接收用户消息；Product Session的创建、标题派生、Message、Run和
   * workflow_start Outbox由Application在同一Product Store事务内完成。
   * Bridge不提交Session ID或标题，只保存响应中的DSH→Chat身份映射。
   */
  router.post("/messages", async (c) => {
    try {
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = submitMessagePayloadSchema.parse(envelope.payload);
      const result = await submitUserMessage(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        payload,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/messages",
        statusCode: 201,
        productRunId: result.run.productRunId,
        productSessionId: result.session.sessionId,
      });
      return c.json(result, 201);
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
      return c.json({ message: result.message, run: result.run }, 201);
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

  router.get("/sessions/:sessionId/messages/:messageId", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const sessionId = productSessionIdSchema.parse(c.req.param("sessionId"));
      const messageId = messageIdSchema.parse(c.req.param("messageId"));
      return c.json(
        await getSessionMessage(ctx.deps, {
          principalId: ctx.principalId,
          sessionId,
          messageId,
        }),
        200,
      );
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

  router.get("/sessions/:sessionId/memory-writes", async (c) => {
    try {
      const productSessionId = productSessionIdSchema.parse(c.req.param("sessionId"));
      const params = new URL(c.req.url).searchParams;
      if (
        [...params.keys()].some((key) => key !== "limit" && key !== "cursor") ||
        params.getAll("limit").length > 1 ||
        params.getAll("cursor").length > 1
      ) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Memory Write列表包含未知或重复参数",
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
          message: "limit必须是1到100的整数",
        });
      }
      return c.json(
        await listMemoryWrites(ctx.deps, {
          principalId: ctx.principalId,
          productSessionId,
          limit: rawLimit === null ? 50 : Number(rawLimit),
          ...(params.get("cursor") !== null
            ? { cursor: memoryWriteIntentIdSchema.parse(params.get("cursor")) }
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
}
