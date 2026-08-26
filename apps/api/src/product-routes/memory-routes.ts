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
  createMemorySessionImportPayloadSchema,
  listMemorySessionImportsQuerySchema,
  listMemorySessionImportsResponseSchema,
  listMemorySessionSourcesResponseSchema,
  memorySessionImportIdSchema,
  memorySessionImportResponseSchema,
  memorySessionSourceListQuerySchema,
  previewMemorySessionImportPayloadSchema,
  previewMemorySessionImportResponseSchema,
  previewMemoryProviderComparisonPayloadSchema,
  previewMemoryProviderComparisonResponseSchema,
  memoryAgentWriteCandidateIdSchema,
  listMemoryAgentWriteCandidatesQuerySchema,
  listMemoryAgentWriteCandidatesResponseSchema,
  memoryAgentWriteCandidateResponseSchema,
  decideMemoryAgentWriteCandidatePayloadSchema,
  memoryAgentWriteDecisionResponseSchema,
} from "@chat/contracts";
import {
  ApplicationError,
  createMemoryImport,
  getMemoryImport,
  requestMemoryImportReconciliation,
  createMemoryWrite,
  getMemoryWrite,
  requestMemoryWriteReconciliation,
  createMemorySessionImport,
  getMemorySessionImport,
  listMemorySessionImports,
  listMemorySessionSources,
  previewMemorySessionImport,
  previewMemoryProviderComparison,
  getMemoryAgentWriteCandidate,
  listMemoryAgentWriteCandidates,
  decideMemoryAgentWriteCandidate,
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
  router.get("/memory/write-candidates", async (c) => {
    try {
      const params = strictMemoryQuery(c.req.url, ["status", "limit"]);
      const query = listMemoryAgentWriteCandidatesQuerySchema.parse({
        status: params.get("status") ?? undefined,
        limit: params.get("limit") ?? undefined,
      });
      return c.json(
        listMemoryAgentWriteCandidatesResponseSchema.parse(
          await listMemoryAgentWriteCandidates(ctx.deps, {
            principalId: ctx.principalId,
            status: query.status,
            limit: query.limit,
          }),
        ),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/memory/write-candidates/:candidateId", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const candidateId = memoryAgentWriteCandidateIdSchema.parse(c.req.param("candidateId"));
      return c.json(
        memoryAgentWriteCandidateResponseSchema.parse(
          await getMemoryAgentWriteCandidate(ctx.deps, {
            principalId: ctx.principalId,
            candidateId,
          }),
        ),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/memory/write-candidates/:candidateId/decisions", async (c) => {
    try {
      const candidateId = memoryAgentWriteCandidateIdSchema.parse(c.req.param("candidateId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = decideMemoryAgentWriteCandidatePayloadSchema.parse(envelope.payload);
      const result = await decideMemoryAgentWriteCandidate(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        candidateId,
        payload,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/memory/write-candidates/:candidateId/decisions",
        statusCode: 201,
      });
      return c.json(memoryAgentWriteDecisionResponseSchema.parse(result), 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/memory/provider-comparison-previews", async (c) => {
    try {
      const payload = previewMemoryProviderComparisonPayloadSchema.parse(await parseJsonBody(c));
      return c.json(
        previewMemoryProviderComparisonResponseSchema.parse(
          await previewMemoryProviderComparison(ctx.deps, {
            principalId: ctx.principalId,
            payload,
          }),
        ),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/memory/session-sources", async (c) => {
    try {
      const params = strictMemoryQuery(c.req.url, ["kind", "limit"]);
      const query = memorySessionSourceListQuerySchema.parse({
        kind: params.get("kind"),
        limit: params.get("limit") ?? undefined,
      });
      return c.json(
        listMemorySessionSourcesResponseSchema.parse(
          await listMemorySessionSources(ctx.deps, {
            principalId: ctx.principalId,
            kind: query.kind,
            limit: query.limit,
          }),
        ),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/memory/session-import-previews", async (c) => {
    try {
      const payload = previewMemorySessionImportPayloadSchema.parse(await parseJsonBody(c));
      return c.json(
        previewMemorySessionImportResponseSchema.parse(
          await previewMemorySessionImport(ctx.deps, {
            principalId: ctx.principalId,
            source: payload.source,
            providerId: payload.providerId,
          }),
        ),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/memory/session-imports", async (c) => {
    try {
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = createMemorySessionImportPayloadSchema.parse(envelope.payload);
      const result = await createMemorySessionImport(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        payload,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/memory/session-imports",
        statusCode: 201,
      });
      return c.json(memorySessionImportResponseSchema.parse(result), 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/memory/session-imports", async (c) => {
    try {
      const params = strictMemoryQuery(c.req.url, ["limit"]);
      const query = listMemorySessionImportsQuerySchema.parse({
        limit: params.get("limit") ?? undefined,
      });
      return c.json(
        listMemorySessionImportsResponseSchema.parse(
          await listMemorySessionImports(ctx.deps, {
            principalId: ctx.principalId,
            limit: query.limit,
          }),
        ),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/memory/session-imports/:memorySessionImportId", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const memorySessionImportId = memorySessionImportIdSchema.parse(
        c.req.param("memorySessionImportId"),
      );
      return c.json(
        memorySessionImportResponseSchema.parse(
          await getMemorySessionImport(ctx.deps, {
            principalId: ctx.principalId,
            memorySessionImportId,
          }),
        ),
        200,
      );
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

function strictMemoryQuery(url: string, allowedKeys: readonly string[]): URLSearchParams {
  const params = new URL(url).searchParams;
  const allowed = new Set(allowedKeys);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) {
      throw new ApplicationError({
        code: "validation_failed",
        httpStatus: 400,
        message: "Memory查询参数未知或重复",
      });
    }
  }
  return params;
}
