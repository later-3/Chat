/**
 * registerProjectBootstrapRoutes：路由注册族。只终止协议与校验DTO，产品事务由Application拥有。
 */
import {
  commandEnvelopeSchema,
  productSessionIdSchema,
  projectBootstrapCandidateIdSchema,
  projectBootstrapOperationIdSchema,
  projectBootstrapConfigurationSchema,
  projectBootstrapDecisionPayloadSchema,
  projectBootstrapDecisionResponseSchema,
  retryProjectBootstrapPayloadSchema,
  projectBootstrapReviewResponseSchema,
  currentProjectBootstrapResponseSchema,
  submitMessagePayloadSchema,
} from "@chat/contracts";
import {
  ApplicationError,
  listProjectRoots,
  decideProjectBootstrapCandidate,
  requestProjectBootstrapOperationRetry,
  getProjectBootstrapConfiguration,
  getProjectBootstrapReview,
  getCurrentProjectBootstrapForSession,
  submitProjectBootstrapUserMessage,
} from "@chat/application";
import {
  type ProductRouteContext,
  mapError,
  parseJsonBody,
  assertNoQuery,
  emitCommandAccepted,
  type ProductRouter,
} from "./shared.js";

export function registerProjectBootstrapRoutes(
  router: ProductRouter,
  ctx: ProductRouteContext,
): void {
  /**
   * 专用Message Command是Product侧授权边界。普通/messages即使某个已发布Definition
   * 默认启用project_bootstrap也会被Application拒绝。
   */
  router.post("/project-bootstrap/messages", async (c) => {
    try {
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = submitMessagePayloadSchema.parse(envelope.payload);
      const result = await submitProjectBootstrapUserMessage(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        payload,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/project-bootstrap/messages",
        statusCode: 201,
        productRunId: result.run.productRunId,
        productSessionId: result.session.sessionId,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/sessions/:sessionId/project-bootstrap/messages", async (c) => {
    try {
      const sessionId = productSessionIdSchema.parse(c.req.param("sessionId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = submitMessagePayloadSchema.parse(envelope.payload);
      const result = await submitProjectBootstrapUserMessage(ctx.deps, {
        principalId: ctx.principalId,
        sessionId,
        commandId: envelope.commandId,
        payload,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/sessions/:sessionId/project-bootstrap/messages",
        statusCode: 201,
        productRunId: result.run.productRunId,
        productSessionId: sessionId,
      });
      return c.json({ message: result.message, run: result.run }, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/project-roots", async (c) => {
    try {
      assertNoQuery(c.req.url);
      return c.json(await listProjectRoots(ctx.deps), 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/project-bootstrap/configuration", async (c) => {
    try {
      assertNoQuery(c.req.url);
      return c.json(
        projectBootstrapConfigurationSchema.parse(getProjectBootstrapConfiguration(ctx.deps)),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/project-bootstrap/candidates/:projectBootstrapCandidateId/decision", async (c) => {
    try {
      const candidateId = projectBootstrapCandidateIdSchema.parse(
        c.req.param("projectBootstrapCandidateId"),
      );
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = projectBootstrapDecisionPayloadSchema.parse(envelope.payload);
      if (payload.projectBootstrapCandidateId !== candidateId) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "路径与Payload的Project Bootstrap Candidate不一致",
        });
      }
      const result = await decideProjectBootstrapCandidate(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        projectBootstrapCandidateId: candidateId,
        candidateRevision: payload.candidateRevision,
        candidateSha256: payload.candidateSha256,
        kind: payload.kind,
        ...(payload.reason === undefined ? {} : { reason: payload.reason }),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/project-bootstrap/candidates/:projectBootstrapCandidateId/decision",
        statusCode: 201,
        productSessionId: result.candidate.sourceProductSessionId,
        productRunId: result.candidate.sourceProductRunId,
      });
      return c.json(projectBootstrapDecisionResponseSchema.parse(result), 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/project-bootstrap/operations/:projectBootstrapOperationId/retry", async (c) => {
    try {
      const operationId = projectBootstrapOperationIdSchema.parse(
        c.req.param("projectBootstrapOperationId"),
      );
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = retryProjectBootstrapPayloadSchema.parse(envelope.payload);
      if (payload.projectBootstrapOperationId !== operationId) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "路径与Payload的Project Bootstrap Operation不一致",
        });
      }
      const operation = await requestProjectBootstrapOperationRetry(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        projectBootstrapOperationId: operationId,
        expectedOperationRevision: payload.expectedOperationRevision,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/project-bootstrap/operations/:projectBootstrapOperationId/retry",
        statusCode: 202,
      });
      return c.json({ operation }, 202);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/project-bootstrap/operations/:projectBootstrapOperationId", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const operationId = projectBootstrapOperationIdSchema.parse(
        c.req.param("projectBootstrapOperationId"),
      );
      return c.json(
        projectBootstrapReviewResponseSchema.parse(
          await getProjectBootstrapReview(ctx.deps, {
            principalId: ctx.principalId,
            projectBootstrapOperationId: operationId,
          }),
        ),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/sessions/:sessionId/project-bootstrap/current", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const productSessionId = productSessionIdSchema.parse(c.req.param("sessionId"));
      return c.json(
        currentProjectBootstrapResponseSchema.parse({
          projectBootstrap: await getCurrentProjectBootstrapForSession(ctx.deps, {
            principalId: ctx.principalId,
            productSessionId,
          }),
        }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });
}
