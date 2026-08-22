/**
 * registerRuleRoutes：路由注册族。只终止协议与校验DTO，产品事务由Application拥有。
 */
import {
  commandEnvelopeSchema,
  ruleIdSchema,
  ruleTagIdSchema,
  listRulesQuerySchema,
  createRulePayloadSchema,
  reviseRulePayloadSchema,
  transitionRulePayloadSchema,
  createRuleTagPayloadSchema,
  updateRuleTagPayloadSchema,
  archiveRuleTagPayloadSchema,
} from "@chat/contracts";
import {
  ApplicationError,
  listRules,
  getRule,
  createRule,
  reviseRule,
  transitionRuleLifecycle,
  listRuleTags,
  createRuleTag,
  updateRuleTag,
  archiveRuleTag,
} from "@chat/application";
import {
  type ProductRouteContext,
  mapError,
  parseJsonBody,
  assertNoQuery,
  strictQueryParams,
  parseOptionalPositiveInteger,
  privateEtagJson,
  emitCommandAccepted,
  type ProductRouter,
} from "./shared.js";

export function registerRuleRoutes(router: ProductRouter, ctx: ProductRouteContext): void {
  router.get("/rules", async (c) => {
    try {
      const params = strictQueryParams(
        c.req.url,
        ["cursor", "limit", "lifecycle", "tagId", "scenario"],
        "Rule列表查询",
      );
      const limit = parseOptionalPositiveInteger(params, "limit", "Rule列表limit");
      const query = listRulesQuerySchema.parse({
        ...(params.get("cursor") !== null ? { cursor: params.get("cursor") } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(params.get("lifecycle") !== null ? { lifecycle: params.get("lifecycle") } : {}),
        ...(params.get("tagId") !== null ? { tagId: params.get("tagId") } : {}),
        ...(params.get("scenario") !== null ? { scenario: params.get("scenario") } : {}),
      });
      return privateEtagJson(
        c,
        "rules-list",
        await listRules(ctx.deps, { principalId: ctx.principalId, query }),
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/rules/:ruleId", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const ruleId = ruleIdSchema.parse(c.req.param("ruleId"));
      return privateEtagJson(
        c,
        "rule-detail",
        await getRule(ctx.deps, { principalId: ctx.principalId, ruleId }),
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/rules", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const result = await createRule(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        payload: createRulePayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/rules",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/rules/:ruleId/revisions", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const ruleId = ruleIdSchema.parse(c.req.param("ruleId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "修订Rule必须携带expectedRevision",
        });
      }
      const result = await reviseRule(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        ruleId,
        expectedRevision: envelope.expectedRevision,
        payload: reviseRulePayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/rules/:ruleId/revisions",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/rules/:ruleId/lifecycle", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const ruleId = ruleIdSchema.parse(c.req.param("ruleId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Rule生命周期命令必须携带expectedRevision",
        });
      }
      const result = await transitionRuleLifecycle(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        ruleId,
        expectedRevision: envelope.expectedRevision,
        payload: transitionRulePayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/rules/:ruleId/lifecycle",
        statusCode: 200,
      });
      return c.json(result, 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/rule-tags", async (c) => {
    try {
      assertNoQuery(c.req.url);
      return privateEtagJson(
        c,
        "rule-tags",
        await listRuleTags(ctx.deps, { principalId: ctx.principalId }),
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/rule-tags", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const result = await createRuleTag(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        payload: createRuleTagPayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/rule-tags",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/rule-tags/:ruleTagId", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const ruleTagId = ruleTagIdSchema.parse(c.req.param("ruleTagId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "修改Rule Tag必须携带expectedRevision",
        });
      }
      const result = await updateRuleTag(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        ruleTagId,
        expectedRevision: envelope.expectedRevision,
        payload: updateRuleTagPayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/rule-tags/:ruleTagId",
        statusCode: 200,
      });
      return c.json(result, 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/rule-tags/:ruleTagId/archive", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const ruleTagId = ruleTagIdSchema.parse(c.req.param("ruleTagId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "归档Rule Tag必须携带expectedRevision",
        });
      }
      archiveRuleTagPayloadSchema.parse(envelope.payload);
      const result = await archiveRuleTag(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        ruleTagId,
        expectedRevision: envelope.expectedRevision,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/rule-tags/:ruleTagId/archive",
        statusCode: 200,
      });
      return c.json(result, 200);
    } catch (error) {
      return mapError(c, error);
    }
  });
}
