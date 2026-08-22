/**
 * registerRunRoutes：路由注册族。只终止协议与校验DTO，产品事务由Application拥有。
 */
import {
  commandEnvelopeSchema,
  productRunIdSchema,
  workflowNodeRunIdSchema,
  submitDecisionPayloadSchema,
  submitPromptReviewDecisionPayloadSchema,
} from "@chat/contracts";
import {
  ApplicationError,
  getCurrentApproval,
  getProductRun,
  getRunExecutionTrace,
  getRunPlans,
  getRunContext,
  submitPlanDecision,
  getCurrentPromptReview,
  submitPromptReviewDecision,
  getWorkflowRunView,
  getWorkflowExecutionTrace,
  getWorkflowNodeDetail,
  getWorkflowRunConfigSummary,
} from "@chat/application";
import {
  type ProductRouteContext,
  mapError,
  parseJsonBody,
  assertNoQuery,
  strictQueryParams,
  parseWorkflowNodeIncludes,
  matchesEtag,
  privateEtagJson,
  emitCommandAccepted,
  type ProductRouter,
} from "./shared.js";

export function registerRunRoutes(router: ProductRouter, ctx: ProductRouteContext): void {
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

  router.get("/runs/:productRunId/execution-trace", async (c) => {
    try {
      const productRunId = productRunIdSchema.parse(c.req.param("productRunId"));
      const params = strictQueryParams(c.req.url, ["afterSequence", "limit"], "执行轨迹查询");
      const rawAfter = params.get("afterSequence") ?? "0";
      const rawLimit = params.get("limit") ?? "100";
      if (!/^(?:0|[1-9][0-9]*)$/u.test(rawAfter) || !/^[1-9][0-9]*$/u.test(rawLimit)) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "执行轨迹cursor或limit非法",
        });
      }
      const afterSequence = Number(rawAfter);
      const limit = Number(rawLimit);
      if (!Number.isSafeInteger(afterSequence) || limit > 100 || !Number.isSafeInteger(limit)) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "执行轨迹cursor或limit超出范围",
        });
      }
      c.header("Cache-Control", "private, no-store");
      return c.json(
        await getRunExecutionTrace(ctx.deps, {
          principalId: ctx.principalId,
          productRunId,
          afterSequence,
          limit,
        }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/runs/:productRunId/workflow-config-summary", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const productRunId = productRunIdSchema.parse(c.req.param("productRunId"));
      return privateEtagJson(
        c,
        "workflow-run-config-summary",
        await getWorkflowRunConfigSummary(ctx.deps, {
          principalId: ctx.principalId,
          productRunId,
        }),
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/runs/:productRunId/workflow-view", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const productRunId = productRunIdSchema.parse(c.req.param("productRunId"));
      const result = await getWorkflowRunView(ctx.deps, {
        principalId: ctx.principalId,
        productRunId,
      });
      c.header("ETag", result.etag);
      c.header("Cache-Control", "private, no-cache");
      if (matchesEtag(c.req.header("If-None-Match"), result.etag)) return c.body(null, 304);
      return c.json(result.value, 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/runs/:productRunId/workflow-execution-trace", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const productRunId = productRunIdSchema.parse(c.req.param("productRunId"));
      const result = await getWorkflowExecutionTrace(ctx.deps, {
        principalId: ctx.principalId,
        productRunId,
      });
      c.header("ETag", result.etag);
      c.header("Cache-Control", "private, no-cache");
      if (matchesEtag(c.req.header("If-None-Match"), result.etag)) return c.body(null, 304);
      return c.json(result.value, 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/runs/:productRunId/workflow-nodes/:workflowNodeRunId", async (c) => {
    try {
      const productRunId = productRunIdSchema.parse(c.req.param("productRunId"));
      const workflowNodeRunId = workflowNodeRunIdSchema.parse(c.req.param("workflowNodeRunId"));
      const result = await getWorkflowNodeDetail(ctx.deps, {
        principalId: ctx.principalId,
        productRunId,
        workflowNodeRunId,
        include: parseWorkflowNodeIncludes(c.req.url),
      });
      c.header("ETag", result.etag);
      c.header("Cache-Control", "private, no-cache");
      if (matchesEtag(c.req.header("If-None-Match"), result.etag)) return c.body(null, 304);
      return c.json(result.value, 200);
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

  router.get("/runs/:productRunId/prompt-reviews/current", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const productRunId = productRunIdSchema.parse(c.req.param("productRunId"));
      c.header("Cache-Control", "private, no-store");
      return c.json(
        await getCurrentPromptReview(ctx.deps, {
          principalId: ctx.principalId,
          productRunId,
        }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  /** 浏览器只提交产品Decision；Workflow Hook与Pi Operation身份永不进入公开面。 */
  router.post("/runs/:productRunId/prompt-review-decisions", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const productRunId = productRunIdSchema.parse(c.req.param("productRunId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Prompt Review Decision必须携带expectedRevision",
        });
      }
      const payload = submitPromptReviewDecisionPayloadSchema.parse(envelope.payload);
      const result = await submitPromptReviewDecision(ctx.deps, {
        principalId: ctx.principalId,
        productRunId,
        commandId: envelope.commandId,
        expectedRunRevision: envelope.expectedRevision,
        payload,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/runs/:productRunId/prompt-review-decisions",
        statusCode: 201,
        productRunId,
        productSessionId: result.run.sessionId,
      });
      return c.json(result, 201);
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
}
