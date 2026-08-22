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
  executeProjectBootstrapPayloadSchema,
  projectBootstrapReviewResponseSchema,
  currentProjectBootstrapResponseSchema,
} from "@chat/contracts";
import {
  ApplicationError,
  listProjectRoots,
  decideProjectBootstrapCandidate,
  executeProjectBootstrapOperation,
  getProjectBootstrapConfiguration,
  getProjectBootstrapReview,
  getCurrentProjectBootstrapForSession,
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

  router.post("/project-bootstrap/operations/:projectBootstrapOperationId/execute", async (c) => {
    try {
      const operationId = projectBootstrapOperationIdSchema.parse(
        c.req.param("projectBootstrapOperationId"),
      );
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = executeProjectBootstrapPayloadSchema.parse(envelope.payload);
      if (payload.projectBootstrapOperationId !== operationId) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "路径与Payload的Project Bootstrap Operation不一致",
        });
      }
      const operation = await executeProjectBootstrapOperation(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        projectBootstrapOperationId: operationId,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/project-bootstrap/operations/:projectBootstrapOperationId/execute",
        statusCode: 200,
      });
      return c.json({ operation }, 200);
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
