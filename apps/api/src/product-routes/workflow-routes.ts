/**
 * registerWorkflowRoutes：路由注册族。只终止协议与校验DTO，产品事务由Application拥有。
 */
import {
  commandEnvelopeSchema,
  workflowDefinitionIdSchema,
  createWorkflowDefinitionCopyPayloadSchema,
  saveWorkflowAgentNodeConfigurationPayloadSchema,
  saveWorkflowDefinitionDraftV3PayloadSchema,
  validateWorkflowDefinitionV3PayloadSchema,
  publishWorkflowDefinitionPayloadSchema,
  changeWorkflowDefinitionArchiveStatusPayloadSchema,
} from "@chat/contracts";
import {
  ApplicationError,
  listMemoryBackends,
  getWorkflowBlueprints,
  getWorkflowCatalog,
  getWorkflowDefinitions,
  getWorkflowResources,
  getWorkflowDefinitionDetail,
  createWorkflowDefinitionCopy,
  saveWorkflowAgentNodeConfiguration,
  saveWorkflowDefinitionDraft,
  validateWorkflowDefinition,
  publishWorkflowDefinition,
  changeWorkflowDefinitionArchiveStatus,
} from "@chat/application";
import {
  type ProductRouteContext,
  mapError,
  parseJsonBody,
  assertNoQuery,
  parseWorkflowResourcesQuery,
  privateEtagJson,
  emitCommandAccepted,
  type ProductRouter,
} from "./shared.js";

export function registerWorkflowRoutes(router: ProductRouter, ctx: ProductRouteContext): void {
  router.get("/memory-backends", async (c) => {
    try {
      assertNoQuery(c.req.url);
      return c.json(await listMemoryBackends(ctx.deps), 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/workflow/catalog", async (c) => {
    try {
      assertNoQuery(c.req.url);
      return privateEtagJson(c, "workflow-catalog", await getWorkflowCatalog(ctx.deps));
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/workflow/blueprints", async (c) => {
    try {
      assertNoQuery(c.req.url);
      return privateEtagJson(c, "workflow-blueprints", await getWorkflowBlueprints(ctx.deps));
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/workflow/definitions", async (c) => {
    try {
      assertNoQuery(c.req.url);
      return privateEtagJson(
        c,
        "workflow-definitions",
        await getWorkflowDefinitions(ctx.deps, { principalId: ctx.principalId }),
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/workflow/definitions/copies", async (c) => {
    try {
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = createWorkflowDefinitionCopyPayloadSchema.parse(envelope.payload);
      const result = await createWorkflowDefinitionCopy(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        payload,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/workflow/definitions/copies",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/workflow/definitions/agent-node-configurations", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const result = await saveWorkflowAgentNodeConfiguration(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        payload: saveWorkflowAgentNodeConfigurationPayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/workflow/definitions/agent-node-configurations",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/workflow/definitions/validate", async (c) => {
    try {
      const payload = validateWorkflowDefinitionV3PayloadSchema.parse(await parseJsonBody(c));
      return c.json(
        await validateWorkflowDefinition(ctx.deps, {
          principalId: ctx.principalId,
          payload,
        }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/workflow/definitions/:workflowDefinitionId", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const workflowDefinitionId = workflowDefinitionIdSchema.parse(
        c.req.param("workflowDefinitionId"),
      );
      return privateEtagJson(
        c,
        "workflow-definition-detail",
        await getWorkflowDefinitionDetail(ctx.deps, {
          principalId: ctx.principalId,
          workflowDefinitionId,
        }),
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/workflow/definitions/:workflowDefinitionId/drafts", async (c) => {
    try {
      const workflowDefinitionId = workflowDefinitionIdSchema.parse(
        c.req.param("workflowDefinitionId"),
      );
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "保存Definition Draft必须携带expectedRevision",
        });
      }
      const payload = saveWorkflowDefinitionDraftV3PayloadSchema.parse(envelope.payload);
      const result = await saveWorkflowDefinitionDraft(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        workflowDefinitionId,
        expectedRevision: envelope.expectedRevision,
        payload,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/workflow/definitions/:workflowDefinitionId/drafts",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/workflow/definitions/:workflowDefinitionId/publish", async (c) => {
    try {
      const workflowDefinitionId = workflowDefinitionIdSchema.parse(
        c.req.param("workflowDefinitionId"),
      );
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "发布Definition必须携带expectedRevision",
        });
      }
      const payload = publishWorkflowDefinitionPayloadSchema.parse(envelope.payload);
      const result = await publishWorkflowDefinition(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        workflowDefinitionId,
        expectedRevision: envelope.expectedRevision,
        payload,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/workflow/definitions/:workflowDefinitionId/publish",
        statusCode: 200,
      });
      return c.json(result, 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/workflow/definitions/:workflowDefinitionId/archive-status", async (c) => {
    try {
      const workflowDefinitionId = workflowDefinitionIdSchema.parse(
        c.req.param("workflowDefinitionId"),
      );
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "归档或恢复Definition必须携带expectedRevision",
        });
      }
      const payload = changeWorkflowDefinitionArchiveStatusPayloadSchema.parse(envelope.payload);
      const result = await changeWorkflowDefinitionArchiveStatus(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        workflowDefinitionId,
        expectedRevision: envelope.expectedRevision,
        payload,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/workflow/definitions/:workflowDefinitionId/archive-status",
        statusCode: 200,
      });
      return c.json(result, 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/workflow/resources", async (c) => {
    try {
      const query = parseWorkflowResourcesQuery(c.req.url);
      return privateEtagJson(
        c,
        "workflow-resources",
        await getWorkflowResources(ctx.deps, {
          principalId: ctx.principalId,
          ...query,
        }),
      );
    } catch (error) {
      return mapError(c, error);
    }
  });
}
