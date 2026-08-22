/**
 * registerMemoryRoutes：路由注册族。只终止协议与校验DTO，产品事务由Application拥有。
 */
import {
  commandEnvelopeSchema,
  createMemoryImportPayloadSchema,
  reconcileMemoryImportPayloadSchema,
  memoryImportIntentIdSchema,
  createMemoryWritePayloadSchema,
  reconcileMemoryWritePayloadSchema,
  memoryWriteIntentIdSchema,
  listMemoryProvidersResponseSchema,
} from "@chat/contracts";
import {
  ApplicationError,
  createMemoryImport,
  getMemoryImport,
  requestMemoryImportReconciliation,
  createMemoryWrite,
  getMemoryWrite,
  requestMemoryWriteReconciliation,
} from "@chat/application";
import {
  type ProductRouteContext,
  mapError,
  parseJsonBody,
  assertNoQuery,
  emitCommandAccepted,
  type ProductRouter,
} from "./shared.js";

export function registerMemoryRoutes(router: ProductRouter, ctx: ProductRouteContext): void {
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

  router.get("/memory/providers", async (c) => {
    try {
      assertNoQuery(c.req.url);
      return c.json(
        listMemoryProvidersResponseSchema.parse({
          providers: ctx.deps.workflowMemoryProviders?.list() ?? [],
        }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/memory-writes", async (c) => {
    try {
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = createMemoryWritePayloadSchema.parse(envelope.payload);
      const result = await createMemoryWrite(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        payload,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/memory-writes",
        statusCode: 201,
        productSessionId: payload.productSessionId,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/memory-writes/:memoryWriteIntentId", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const memoryWriteIntentId = memoryWriteIntentIdSchema.parse(
        c.req.param("memoryWriteIntentId"),
      );
      return c.json(
        await getMemoryWrite(ctx.deps, {
          principalId: ctx.principalId,
          memoryWriteIntentId,
        }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/memory-writes/:memoryWriteIntentId/reconcile", async (c) => {
    try {
      const memoryWriteIntentId = memoryWriteIntentIdSchema.parse(
        c.req.param("memoryWriteIntentId"),
      );
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = reconcileMemoryWritePayloadSchema.parse(envelope.payload);
      const result = await requestMemoryWriteReconciliation(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        memoryWriteIntentId,
        expectedResultRevision: payload.expectedResultRevision,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/memory-writes/:memoryWriteIntentId/reconcile",
        statusCode: 202,
      });
      return c.json(result, 202);
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
}
