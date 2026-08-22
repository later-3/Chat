/**
 * registerProjectRoutes：路由注册族。只终止协议与校验DTO，产品事务由Application拥有。
 */
import { z } from "zod";
import {
  commandEnvelopeSchema,
  productSessionIdSchema,
  projectCandidateIdSchema,
  projectIdSchema,
  projectActionIdSchema,
  projectStageIdSchema,
  projectMilestoneIdSchema,
  projectResourceIdSchema,
  beginProjectIntakePayloadSchema,
  beginProjectManagementCandidatePayloadSchema,
  beginProjectAdvancementPayloadSchema,
  projectAdvancementCandidateDecisionPayloadSchema,
  projectCandidateDecisionPayloadSchema,
  projectManagementCandidateDecisionPayloadSchema,
  createProjectActionPayloadSchema,
  assignProjectActionPayloadSchema,
  setProjectArchiveStatusPayloadSchema,
  transitionProjectActionPayloadSchema,
  transitionProjectStagePayloadSchema,
  transitionProjectLifecyclePayloadSchema,
  transitionProjectMilestonePayloadSchema,
  recordProjectDecisionPayloadSchema,
  recordProjectContributionPayloadSchema,
} from "@chat/contracts";
import {
  ApplicationError,
  beginProjectIntake,
  beginProjectManagementCandidate,
  beginProjectAdvancement,
  decideProjectAdvancementCandidate,
  getProjectCandidate,
  getCurrentProjectCandidate,
  decideProjectCandidate,
  decideProjectManagementCandidate,
  listProjects,
  getProjectWorkspace,
  getProjectTimeline,
  createProjectAction,
  assignProjectAction,
  setProjectArchiveStatus,
  transitionProjectAction,
  transitionProjectStage,
  transitionProjectLifecycle,
  transitionProjectMilestone,
  recordProjectDecision,
  recordProjectContribution,
  observeProjectResource,
} from "@chat/application";
import {
  type ProductRouteContext,
  mapError,
  parseJsonBody,
  assertNoQuery,
  emitCommandAccepted,
  type ProductRouter,
} from "./shared.js";

export function registerProjectRoutes(router: ProductRouter, ctx: ProductRouteContext): void {
  router.post("/project-intakes", async (c) => {
    try {
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = beginProjectIntakePayloadSchema.parse(envelope.payload);
      const result = await beginProjectIntake(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        payload,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/project-intakes",
        statusCode: 202,
        productSessionId: payload.sessionId,
      });
      return c.json(result, 202);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/project-management-candidates", async (c) => {
    try {
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = beginProjectManagementCandidatePayloadSchema.parse(envelope.payload);
      return c.json(
        await beginProjectManagementCandidate(ctx.deps, {
          principalId: ctx.principalId,
          commandId: envelope.commandId,
          payload,
        }),
        201,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/project-advancements", async (c) => {
    try {
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = beginProjectAdvancementPayloadSchema.parse(envelope.payload);
      const result = await beginProjectAdvancement(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        payload,
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/project-advancements",
        statusCode: 202,
        productSessionId: payload.sessionId,
      });
      return c.json(result, 202);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/project-candidates/:projectCandidateId", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const projectCandidateId = projectCandidateIdSchema.parse(c.req.param("projectCandidateId"));
      return c.json(
        await getProjectCandidate(ctx.deps, {
          principalId: ctx.principalId,
          projectCandidateId,
        }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/sessions/:sessionId/project-candidates/current", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const sessionId = productSessionIdSchema.parse(c.req.param("sessionId"));
      return c.json(
        await getCurrentProjectCandidate(ctx.deps, {
          principalId: ctx.principalId,
          sessionId,
        }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/project-candidates/:projectCandidateId/decisions", async (c) => {
    try {
      const projectCandidateId = projectCandidateIdSchema.parse(c.req.param("projectCandidateId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "建项决定必须携带expectedRevision",
        });
      }
      const payload = projectCandidateDecisionPayloadSchema.parse(envelope.payload);
      const result = await decideProjectCandidate(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        projectCandidateId,
        expectedRevision: envelope.expectedRevision,
        payload,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/project-management-candidates/:projectCandidateId/decisions", async (c) => {
    try {
      const projectCandidateId = projectCandidateIdSchema.parse(c.req.param("projectCandidateId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Project管理Candidate决定必须携带expectedRevision",
        });
      }
      return c.json(
        await decideProjectManagementCandidate(ctx.deps, {
          principalId: ctx.principalId,
          commandId: envelope.commandId,
          projectCandidateId,
          expectedRevision: envelope.expectedRevision,
          payload: projectManagementCandidateDecisionPayloadSchema.parse(envelope.payload),
        }),
        201,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/project-advancements/:projectCandidateId/decisions", async (c) => {
    try {
      const projectCandidateId = projectCandidateIdSchema.parse(c.req.param("projectCandidateId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Project推进Candidate决定必须携带expectedRevision",
        });
      }
      const payload = projectAdvancementCandidateDecisionPayloadSchema.parse(envelope.payload);
      const result = await decideProjectAdvancementCandidate(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        projectCandidateId,
        expectedRevision: envelope.expectedRevision,
        payload,
      });
      return payload.kind === "confirm" ? c.json(result, 201) : c.json(result, 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/projects", async (c) => {
    try {
      assertNoQuery(c.req.url);
      return c.json(await listProjects(ctx.deps, { principalId: ctx.principalId }), 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/projects/:projectId", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      return c.json(
        await getProjectWorkspace(ctx.deps, { principalId: ctx.principalId, projectId }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/projects/:projectId/timeline", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      return c.json(
        await getProjectTimeline(ctx.deps, { principalId: ctx.principalId, projectId }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/projects/:projectId/actions", async (c) => {
    try {
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = createProjectActionPayloadSchema.parse(envelope.payload);
      return c.json(
        await createProjectAction(ctx.deps, {
          principalId: ctx.principalId,
          commandId: envelope.commandId,
          projectId,
          payload,
        }),
        201,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/project-actions/:projectActionId/transitions", async (c) => {
    try {
      const actionId = projectActionIdSchema.parse(c.req.param("projectActionId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Action转换必须携带expectedRevision",
        });
      }
      const payload = transitionProjectActionPayloadSchema.parse(envelope.payload);
      return c.json(
        await transitionProjectAction(ctx.deps, {
          principalId: ctx.principalId,
          commandId: envelope.commandId,
          actionId,
          expectedRevision: envelope.expectedRevision,
          payload,
        }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/project-stages/:projectStageId/transitions", async (c) => {
    try {
      const projectStageId = projectStageIdSchema.parse(c.req.param("projectStageId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Stage转换必须携带expectedRevision",
        });
      }
      return c.json(
        {
          project: await transitionProjectStage(ctx.deps, {
            principalId: ctx.principalId,
            commandId: envelope.commandId,
            projectStageId,
            expectedRevision: envelope.expectedRevision,
            payload: transitionProjectStagePayloadSchema.parse(envelope.payload),
          }),
        },
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/projects/:projectId/transitions", async (c) => {
    try {
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Project生命周期转换必须携带expectedRevision",
        });
      }
      return c.json(
        await transitionProjectLifecycle(ctx.deps, {
          principalId: ctx.principalId,
          commandId: envelope.commandId,
          projectId,
          expectedRevision: envelope.expectedRevision,
          payload: transitionProjectLifecyclePayloadSchema.parse(envelope.payload),
        }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/project-milestones/:projectMilestoneId/transitions", async (c) => {
    try {
      const projectMilestoneId = projectMilestoneIdSchema.parse(c.req.param("projectMilestoneId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Milestone转换必须携带expectedRevision",
        });
      }
      return c.json(
        {
          project: await transitionProjectMilestone(ctx.deps, {
            principalId: ctx.principalId,
            commandId: envelope.commandId,
            projectMilestoneId,
            expectedRevision: envelope.expectedRevision,
            payload: transitionProjectMilestonePayloadSchema.parse(envelope.payload),
          }),
        },
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/project-actions/:projectActionId/assignments", async (c) => {
    try {
      const actionId = projectActionIdSchema.parse(c.req.param("projectActionId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Action分派必须携带expectedRevision",
        });
      }
      return c.json(
        await assignProjectAction(ctx.deps, {
          principalId: ctx.principalId,
          commandId: envelope.commandId,
          actionId,
          expectedRevision: envelope.expectedRevision,
          payload: assignProjectActionPayloadSchema.parse(envelope.payload),
        }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/projects/:projectId/archive-status", async (c) => {
    try {
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Project归档状态必须携带expectedRevision",
        });
      }
      return c.json(
        await setProjectArchiveStatus(ctx.deps, {
          principalId: ctx.principalId,
          commandId: envelope.commandId,
          projectId,
          expectedRevision: envelope.expectedRevision,
          payload: setProjectArchiveStatusPayloadSchema.parse(envelope.payload),
        }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/projects/:projectId/observations", async (c) => {
    try {
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = z
        .object({ resourceId: projectResourceIdSchema })
        .strict()
        .parse(envelope.payload);
      return c.json(
        await observeProjectResource(ctx.deps, {
          principalId: ctx.principalId,
          commandId: envelope.commandId,
          projectId,
          resourceId: payload.resourceId,
        }),
        201,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/projects/:projectId/decision-candidates", async (c) => {
    try {
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Project Decision必须携带expectedRevision",
        });
      }
      const payload = recordProjectDecisionPayloadSchema.parse(envelope.payload);
      return c.json(
        await recordProjectDecision(ctx.deps, {
          principalId: ctx.principalId,
          commandId: envelope.commandId,
          projectId,
          expectedRevision: envelope.expectedRevision,
          payload,
        }),
        201,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/projects/:projectId/contribution-candidates", async (c) => {
    try {
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const payload = recordProjectContributionPayloadSchema.parse(envelope.payload);
      return c.json(
        await recordProjectContribution(ctx.deps, {
          principalId: ctx.principalId,
          commandId: envelope.commandId,
          projectId,
          payload,
        }),
        201,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });
}
