/**
 * registerPromptRoutes：路由注册族。只终止协议与校验DTO，产品事务由Application拥有。
 */
import {
  commandEnvelopeSchema,
  agentKeySchema,
  promptFragmentIdSchema,
  promptFragmentRevisionIdSchema,
  listPromptFragmentsQuerySchema,
  createPromptFragmentPayloadSchema,
  copyPromptFragmentPayloadSchema,
  revisePromptFragmentPayloadSchema,
  changePromptFragmentArchiveStatusPayloadSchema,
  previewPromptAssemblyPayloadSchema,
  previewPromptConfigurationPayloadSchema,
  previewPromptTurnPayloadSchema,
  reviseAgentPromptPayloadSchema,
  restoreAgentPromptPayloadSchema,
  createAgentVersionPayloadSchema,
} from "@chat/contracts";
import {
  ApplicationError,
  listAgentProfiles,
  getAgentProfile,
  reviseAgentPrompt,
  restoreAgentPrompt,
  createAgentVersion,
  listPromptRegions,
  listPromptWorkspaces,
  listPromptFragments,
  getPromptFragment,
  getPromptFragmentRevision,
  createPromptFragment,
  copyPromptFragment,
  revisePromptFragment,
  changePromptFragmentArchiveStatus,
  previewDirectPromptAssembly,
  previewDirectPromptConfiguration,
  previewPromptTurn,
} from "@chat/application";
import {
  type ProductRouteContext,
  mapError,
  parseJsonBody,
  parseAgentProfilesQuery,
  assertNoQuery,
  strictQueryParams,
  parseOptionalPositiveInteger,
  privateEtagJson,
  emitCommandAccepted,
  type ProductRouter,
} from "./shared.js";

export function registerPromptRoutes(router: ProductRouter, ctx: ProductRouteContext): void {
  router.get("/prompt-regions", async (c) => {
    try {
      assertNoQuery(c.req.url);
      return privateEtagJson(c, "prompt-regions", await listPromptRegions(ctx.deps));
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/agent-profiles", async (c) => {
    try {
      const query = parseAgentProfilesQuery(c.req.url);
      return privateEtagJson(
        c,
        "agent-profiles",
        await listAgentProfiles(ctx.deps, { principalId: ctx.principalId, ...query }),
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/agent-profiles/:agentKey", async (c) => {
    try {
      const query = parseAgentProfilesQuery(c.req.url);
      return privateEtagJson(
        c,
        "agent-profile",
        await getAgentProfile(ctx.deps, {
          principalId: ctx.principalId,
          agentKey: agentKeySchema.parse(c.req.param("agentKey")),
          ...query,
        }),
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/agent-profiles/:agentKey/prompt-revisions", async (c) => {
    try {
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const result = await reviseAgentPrompt(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        agentKey: agentKeySchema.parse(c.req.param("agentKey")),
        payload: reviseAgentPromptPayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/agent-profiles/:agentKey/prompt-revisions",
        statusCode: 200,
      });
      return c.json(result, 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/agent-profiles/:agentKey/restore-default", async (c) => {
    try {
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const result = await restoreAgentPrompt(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        agentKey: agentKeySchema.parse(c.req.param("agentKey")),
        payload: restoreAgentPromptPayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/agent-profiles/:agentKey/restore-default",
        statusCode: 200,
      });
      return c.json(result, 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/agent-profiles/:agentKey/versions", async (c) => {
    try {
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const result = await createAgentVersion(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        agentKey: agentKeySchema.parse(c.req.param("agentKey")),
        payload: createAgentVersionPayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/agent-profiles/:agentKey/versions",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/prompt-workspaces", async (c) => {
    try {
      assertNoQuery(c.req.url);
      return privateEtagJson(c, "prompt-workspaces", await listPromptWorkspaces(ctx.deps));
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/prompt-assembly-previews", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const payload = previewPromptAssemblyPayloadSchema.parse(await parseJsonBody(c));
      return c.json(
        await previewDirectPromptAssembly(ctx.deps, {
          principalId: ctx.principalId,
          text: payload.text,
          selection: payload.selection,
        }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/prompt-turn-previews", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const payload = previewPromptTurnPayloadSchema.parse(await parseJsonBody(c));
      return c.json(
        await previewPromptTurn(ctx.deps, {
          principalId: ctx.principalId,
          payload,
        }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/prompt-configuration-previews", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const payload = previewPromptConfigurationPayloadSchema.parse(await parseJsonBody(c));
      return c.json(
        await previewDirectPromptConfiguration(ctx.deps, {
          principalId: ctx.principalId,
          selection: payload.selection,
          ...(payload.definitionNodeId === undefined
            ? {}
            : { definitionNodeId: payload.definitionNodeId }),
        }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/prompt-fragments", async (c) => {
    try {
      const params = strictQueryParams(
        c.req.url,
        ["cursor", "limit", "regionKey", "ownerKind", "status", "scopeKind", "workspaceRootId"],
        "Prompt Fragment列表查询",
      );
      const limit = parseOptionalPositiveInteger(params, "limit", "Prompt Fragment列表limit");
      const query = listPromptFragmentsQuerySchema.parse({
        ...(params.get("cursor") !== null ? { cursor: params.get("cursor") } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(params.get("regionKey") !== null ? { regionKey: params.get("regionKey") } : {}),
        ...(params.get("ownerKind") !== null ? { ownerKind: params.get("ownerKind") } : {}),
        ...(params.get("status") !== null ? { status: params.get("status") } : {}),
        ...(params.get("scopeKind") !== null ? { scopeKind: params.get("scopeKind") } : {}),
        ...(params.get("workspaceRootId") !== null
          ? { workspaceRootId: params.get("workspaceRootId") }
          : {}),
      });
      return privateEtagJson(
        c,
        "prompt-fragments-list",
        await listPromptFragments(ctx.deps, { principalId: ctx.principalId, query }),
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/prompt-fragments/:promptFragmentId", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const promptFragmentId = promptFragmentIdSchema.parse(c.req.param("promptFragmentId"));
      return privateEtagJson(
        c,
        "prompt-fragment-detail",
        await getPromptFragment(ctx.deps, { principalId: ctx.principalId, promptFragmentId }),
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/prompt-fragment-revisions/:promptFragmentRevisionId", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const promptFragmentRevisionId = promptFragmentRevisionIdSchema.parse(
        c.req.param("promptFragmentRevisionId"),
      );
      return privateEtagJson(
        c,
        "prompt-fragment-revision-detail",
        await getPromptFragmentRevision(ctx.deps, {
          principalId: ctx.principalId,
          promptFragmentRevisionId,
        }),
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/prompt-fragments", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const result = await createPromptFragment(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        payload: createPromptFragmentPayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/prompt-fragments",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/prompt-fragments/copies", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const result = await copyPromptFragment(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        payload: copyPromptFragmentPayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/prompt-fragments/copies",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/prompt-fragments/:promptFragmentId/revisions", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const promptFragmentId = promptFragmentIdSchema.parse(c.req.param("promptFragmentId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "修订Prompt Fragment必须携带expectedRevision",
        });
      }
      const result = await revisePromptFragment(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        promptFragmentId,
        expectedRevision: envelope.expectedRevision,
        payload: revisePromptFragmentPayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/prompt-fragments/:promptFragmentId/revisions",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/prompt-fragments/:promptFragmentId/archive-status", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const promptFragmentId = promptFragmentIdSchema.parse(c.req.param("promptFragmentId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Prompt归档命令必须携带expectedRevision",
        });
      }
      const result = await changePromptFragmentArchiveStatus(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        promptFragmentId,
        expectedRevision: envelope.expectedRevision,
        payload: changePromptFragmentArchiveStatusPayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/prompt-fragments/:promptFragmentId/archive-status",
        statusCode: 200,
      });
      return c.json(result, 200);
    } catch (error) {
      return mapError(c, error);
    }
  });
}
