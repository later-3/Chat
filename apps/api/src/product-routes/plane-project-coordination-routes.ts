/**
 * 受管Plane项目协作公开路由。这里只解析Query/Command并校验严格DTO；
 * Binding事务、外部Operation Journal与对账全部由Application拥有。
 */
import {
  commandEnvelopeSchema,
  executePlaneProjectOperationPayloadSchema,
  getPlaneProjectBindingResponseSchema,
  getPlaneProjectSnapshotResponseSchema,
  listPlaneProjectBindingsQuerySchema,
  listPlaneProjectBindingsResponseSchema,
  listPlaneProjectInboundChangesQuerySchema,
  listPlaneProjectInboundChangesResponseSchema,
  listPlaneProjectOperationsQuerySchema,
  listPlaneProjectOperationsResponseSchema,
  listPlaneWorkItemCommentsQuerySchema,
  listPlaneWorkItemCommentsResponseSchema,
  projectProviderBindingIdSchema,
  projectInboundChangeIdSchema,
  projectCoordinationOperationIdSchema,
  planeProjectOperationResponseSchema,
  preparePlaneProjectOperationPayloadSchema,
  reconcilePlaneProjectOperationPayloadSchema,
  resolvePlaneProjectInboundChangePayloadSchema,
  resolvePlaneProjectInboundChangeResponseSchema,
  syncPlaneProjectPayloadSchema,
  syncPlaneProjectResponseSchema,
  planeWorkItemIdSchema,
  projectAgentOpeningPacketQuerySchema,
  projectAgentOpeningPacketResponseSchema,
} from "@chat/contracts";
import {
  ApplicationError,
  executePlaneProjectOperation,
  getPlaneProjectBinding,
  getPlaneProjectOperation,
  getPlaneProjectSnapshot,
  listPlaneProjectBindings,
  listPlaneProjectInboundChanges,
  listPlaneProjectOperations,
  listPlaneWorkItemComments,
  preparePlaneProjectOperation,
  reconcilePlaneProjectOperation,
  resolvePlaneProjectInboundChange,
  syncPlaneProject,
  getProjectAgentOpeningPacket,
} from "@chat/application";
import {
  assertNoQuery,
  emitCommandAccepted,
  mapError,
  parseJsonBody,
  strictQueryParams,
  type ProductRouteContext,
  type ProductRouter,
} from "./shared.js";
import { timingSafeEqual } from "node:crypto";

export function registerPlaneProjectCoordinationRoutes(
  router: ProductRouter,
  ctx: ProductRouteContext,
): void {
  router.use("/plane-projects/*", async (c, next) => {
    try {
      requirePlaneCoordinationCredential(
        c.req.header("x-chat-plane-client-key"),
        ctx.planeCoordinationCredential,
      );
      await next();
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/plane-projects/bindings", async (c) => {
    try {
      const params = strictQueryParams(
        c.req.url,
        ["status", "cursor", "limit"],
        "Plane项目绑定查询",
      );
      const query = listPlaneProjectBindingsQuerySchema.parse({
        ...(params.get("status") === null ? {} : { status: params.get("status") }),
        ...(params.get("cursor") === null ? {} : { cursor: params.get("cursor") }),
        ...(params.get("limit") === null ? {} : { limit: params.get("limit") }),
      });
      return c.json(
        listPlaneProjectBindingsResponseSchema.parse(
          await listPlaneProjectBindings(ctx.deps, {
            principalId: ctx.principalId,
            limit: query.limit,
            ...(query.status === undefined ? {} : { status: query.status }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          }),
        ),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/plane-projects/opening-packet", async (c) => {
    try {
      const params = strictQueryParams(
        c.req.url,
        [
          "projectId",
          "productSessionId",
          "workspaceRootId",
          "workKey",
          "participantId",
          "includeResourceContext",
          "refreshPlane",
        ],
        "受管Plane Agent开工包查询",
      );
      const query = projectAgentOpeningPacketQuerySchema.parse({
        ...(params.get("projectId") === null ? {} : { projectId: params.get("projectId") }),
        ...(params.get("productSessionId") === null
          ? {}
          : { productSessionId: params.get("productSessionId") }),
        ...(params.get("workspaceRootId") === null
          ? {}
          : { workspaceRootId: params.get("workspaceRootId") }),
        ...(params.get("workKey") === null ? {} : { workKey: params.get("workKey") }),
        ...(params.get("participantId") === null
          ? {}
          : { participantId: params.get("participantId") }),
        ...(params.get("includeResourceContext") === null
          ? {}
          : { includeResourceContext: params.get("includeResourceContext") }),
        ...(params.get("refreshPlane") === null
          ? {}
          : { refreshPlane: params.get("refreshPlane") }),
      });
      return c.json(
        projectAgentOpeningPacketResponseSchema.parse(
          await getProjectAgentOpeningPacket(ctx.deps, {
            principalId: ctx.principalId,
            query,
          }),
        ),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/plane-projects/bindings/:planeProjectBindingId", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const planeProjectBindingId = projectProviderBindingIdSchema.parse(
        c.req.param("planeProjectBindingId"),
      );
      return c.json(
        getPlaneProjectBindingResponseSchema.parse({
          binding: await getPlaneProjectBinding(ctx.deps, {
            principalId: ctx.principalId,
            planeProjectBindingId,
          }),
        }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/plane-projects/bindings/:planeProjectBindingId/snapshot", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const planeProjectBindingId = projectProviderBindingIdSchema.parse(
        c.req.param("planeProjectBindingId"),
      );
      return c.json(
        getPlaneProjectSnapshotResponseSchema.parse({
          snapshot: await getPlaneProjectSnapshot(ctx.deps, {
            principalId: ctx.principalId,
            planeProjectBindingId,
          }),
        }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get(
    "/plane-projects/bindings/:planeProjectBindingId/work-items/:planeWorkItemId/comments",
    async (c) => {
      try {
        const params = strictQueryParams(c.req.url, ["limit"], "Plane评论摘要查询");
        const query = listPlaneWorkItemCommentsQuerySchema.parse({
          ...(params.get("limit") === null ? {} : { limit: params.get("limit") }),
        });
        const planeProjectBindingId = projectProviderBindingIdSchema.parse(
          c.req.param("planeProjectBindingId"),
        );
        const planeWorkItemId = planeWorkItemIdSchema.parse(c.req.param("planeWorkItemId"));
        return c.json(
          listPlaneWorkItemCommentsResponseSchema.parse({
            snapshot: await listPlaneWorkItemComments(ctx.deps, {
              principalId: ctx.principalId,
              planeProjectBindingId,
              planeWorkItemId,
              limit: query.limit,
            }),
          }),
          200,
        );
      } catch (error) {
        return mapError(c, error);
      }
    },
  );

  router.post("/plane-projects/bindings/:planeProjectBindingId/sync", async (c) => {
    try {
      const pathId = projectProviderBindingIdSchema.parse(c.req.param("planeProjectBindingId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = syncPlaneProjectPayloadSchema.parse(envelope.payload);
      if (pathId !== payload.planeProjectBindingId) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "路径与Payload的Plane Binding不一致",
        });
      }
      const result = await syncPlaneProject(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        planeProjectBindingId: pathId,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/plane-projects/bindings/:planeProjectBindingId/sync",
        statusCode: 200,
      });
      return c.json(syncPlaneProjectResponseSchema.parse(result), 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/plane-projects/inbound-changes", async (c) => {
    try {
      const params = strictQueryParams(
        c.req.url,
        ["planeProjectBindingId", "status", "cursor", "limit"],
        "Plane入站Change查询",
      );
      const query = listPlaneProjectInboundChangesQuerySchema.parse({
        ...(params.get("planeProjectBindingId") === null
          ? {}
          : { planeProjectBindingId: params.get("planeProjectBindingId") }),
        ...(params.get("status") === null ? {} : { status: params.get("status") }),
        ...(params.get("cursor") === null ? {} : { cursor: params.get("cursor") }),
        ...(params.get("limit") === null ? {} : { limit: params.get("limit") }),
      });
      return c.json(
        listPlaneProjectInboundChangesResponseSchema.parse(
          await listPlaneProjectInboundChanges(ctx.deps, {
            principalId: ctx.principalId,
            limit: query.limit,
            ...(query.planeProjectBindingId === undefined
              ? {}
              : { planeProjectBindingId: query.planeProjectBindingId }),
            ...(query.status === undefined ? {} : { status: query.status }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          }),
        ),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/plane-projects/inbound-changes/:projectInboundChangeId/resolve", async (c) => {
    try {
      const pathId = projectInboundChangeIdSchema.parse(c.req.param("projectInboundChangeId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = resolvePlaneProjectInboundChangePayloadSchema.parse(envelope.payload);
      if (payload.projectInboundChangeId !== pathId) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "路径与Payload的Plane入站Change不一致",
        });
      }
      const expectedRevision = requireExpectedRevision(
        envelope.expectedRevision,
        "处置Plane入站Change",
      );
      const inboundChange = await resolvePlaneProjectInboundChange(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        projectInboundChangeId: pathId,
        expectedRevision,
        disposition: payload.disposition,
        rationale: payload.rationale,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/plane-projects/inbound-changes/:projectInboundChangeId/resolve",
        statusCode: 200,
      });
      return c.json(resolvePlaneProjectInboundChangeResponseSchema.parse({ inboundChange }), 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/plane-projects/operations", async (c) => {
    try {
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = preparePlaneProjectOperationPayloadSchema.parse(envelope.payload);
      const expectedRevision = requireExpectedRevision(
        envelope.expectedRevision,
        "准备Plane Operation",
      );
      const operation = await preparePlaneProjectOperation(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        expectedBindingRevision: expectedRevision,
        ...payload,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/plane-projects/operations",
        statusCode: 201,
      });
      return c.json(planeProjectOperationResponseSchema.parse({ operation }), 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/plane-projects/operations", async (c) => {
    try {
      const params = strictQueryParams(
        c.req.url,
        ["planeProjectBindingId", "status", "cursor", "limit"],
        "Plane项目Operation查询",
      );
      const query = listPlaneProjectOperationsQuerySchema.parse({
        ...(params.get("planeProjectBindingId") === null
          ? {}
          : { planeProjectBindingId: params.get("planeProjectBindingId") }),
        ...(params.get("status") === null ? {} : { status: params.get("status") }),
        ...(params.get("cursor") === null ? {} : { cursor: params.get("cursor") }),
        ...(params.get("limit") === null ? {} : { limit: params.get("limit") }),
      });
      return c.json(
        listPlaneProjectOperationsResponseSchema.parse(
          await listPlaneProjectOperations(ctx.deps, {
            principalId: ctx.principalId,
            limit: query.limit,
            ...(query.planeProjectBindingId === undefined
              ? {}
              : { planeProjectBindingId: query.planeProjectBindingId }),
            ...(query.status === undefined ? {} : { status: query.status }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          }),
        ),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/plane-projects/operations/:planeProjectOperationId/execute", async (c) => {
    try {
      const operationId = projectCoordinationOperationIdSchema.parse(
        c.req.param("planeProjectOperationId"),
      );
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = executePlaneProjectOperationPayloadSchema.parse(envelope.payload);
      const expectedRevision = requireExpectedRevision(
        envelope.expectedRevision,
        "执行Plane Operation",
      );
      assertOperationPath(operationId, payload.planeProjectOperationId);
      const operation = await executePlaneProjectOperation(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        planeProjectOperationId: operationId,
        expectedOperationRevision: expectedRevision,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/plane-projects/operations/:planeProjectOperationId/execute",
        statusCode: 200,
      });
      return c.json(planeProjectOperationResponseSchema.parse({ operation }), 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/plane-projects/operations/:planeProjectOperationId/reconcile", async (c) => {
    try {
      const operationId = projectCoordinationOperationIdSchema.parse(
        c.req.param("planeProjectOperationId"),
      );
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = reconcilePlaneProjectOperationPayloadSchema.parse(envelope.payload);
      const expectedRevision = requireExpectedRevision(
        envelope.expectedRevision,
        "对账Plane Operation",
      );
      assertOperationPath(operationId, payload.planeProjectOperationId);
      const operation = await reconcilePlaneProjectOperation(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        planeProjectOperationId: operationId,
        expectedOperationRevision: expectedRevision,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/plane-projects/operations/:planeProjectOperationId/reconcile",
        statusCode: 200,
      });
      return c.json(planeProjectOperationResponseSchema.parse({ operation }), 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/plane-projects/operations/:planeProjectOperationId", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const planeProjectOperationId = projectCoordinationOperationIdSchema.parse(
        c.req.param("planeProjectOperationId"),
      );
      const operation = await getPlaneProjectOperation(ctx.deps, {
        principalId: ctx.principalId,
        planeProjectOperationId,
      });
      return c.json(planeProjectOperationResponseSchema.parse({ operation }), 200);
    } catch (error) {
      return mapError(c, error);
    }
  });
}

function requirePlaneCoordinationCredential(
  provided: string | undefined,
  expected: string | undefined,
): void {
  if (expected === undefined) {
    throw new ApplicationError({
      code: "internal_error",
      httpStatus: 503,
      message: "Plane项目协调客户端凭据尚未配置",
      retryable: false,
      recoveryAction: "contact_support",
    });
  }
  const left = Buffer.from(provided ?? "", "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new ApplicationError({
      code: "forbidden",
      httpStatus: 403,
      message: "Plane项目协调客户端凭据无效",
      retryable: false,
      recoveryAction: "none",
    });
  }
}

function assertOperationPath(pathId: string, payloadId: string): void {
  if (pathId !== payloadId) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: "路径与Payload的Plane项目Operation不一致",
    });
  }
}

function requireExpectedRevision(value: number | undefined, label: string): number {
  if (value !== undefined) return value;
  throw new ApplicationError({
    code: "validation_failed",
    httpStatus: 400,
    message: `${label}必须携带expectedRevision`,
  });
}
