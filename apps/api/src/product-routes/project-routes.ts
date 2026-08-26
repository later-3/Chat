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
  projectWorkIdSchema,
  adoptProjectPracticePayloadSchema,
  beginProjectIntakePayloadSchema,
  beginProjectManagementCandidatePayloadSchema,
  beginProjectAdvancementPayloadSchema,
  blockProjectWorkPayloadSchema,
  claimProjectWorkPayloadSchema,
  createContentProductionProjectPayloadSchema,
  createManagedProjectPayloadSchema,
  createProjectWorkPayloadSchema,
  decideProjectWorkTransitionPayloadSchema,
  handoffProjectWorkPayloadSchema,
  recordContentPublicationPayloadSchema,
  recordProjectEvidencePayloadSchema,
  registerProjectAgentPayloadSchema,
  requestProjectWorkReviewPayloadSchema,
  resumeProjectWorkPayloadSchema,
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
  projectAgentOpeningPacketV2QuerySchema,
  projectAgentOpeningPacketV2ResponseSchema,
  projectAgentOpeningPacketV3ResponseSchema,
  contentLabPlaneRolloutDryRunQuerySchema,
  contentLabPlaneRolloutDryRunResponseSchema,
  adoptProjectConfigurationPayloadSchema,
  adoptExistingPlaneProjectPayloadSchema,
  captureProjectNeedPayloadSchema,
  projectContextPurposeSchema,
  projectManagedObjectKindSchema,
  projectAgentContextV2RequestSchema,
  projectObjectQuerySchema,
  proposeProjectConfigurationPayloadSchema,
  proposeProjectRequirementPayloadSchema,
} from "@chat/contracts";
import {
  ApplicationError,
  adoptProjectPractice,
  beginProjectIntake,
  beginProjectManagementCandidate,
  beginProjectAdvancement,
  blockProjectWork,
  claimProjectWork,
  createContentProductionProject,
  createManagedProject,
  createProjectWork,
  decideProjectWorkTransition,
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
  recordContentPublication,
  recordProjectEvidence,
  registerProjectAgent,
  requestProjectWorkReview,
  resumeProjectWork,
  handoffProjectWork,
  observeProjectResource,
  getProjectAgentOpeningPacketV2,
  getProjectAgentOpeningPacketV3,
  previewContentLabPlaneRollout,
  adoptProjectConfiguration,
  adoptExistingPlaneProject,
  captureProjectNeed,
  compileProjectAgentContext,
  compileProjectAgentContextV2,
  evaluateProjectMaintenance,
  getProjectHome,
  queryProjectObjects,
  proposeProjectConfiguration,
  proposeProjectRequirement,
} from "@chat/application";
import {
  type ProductRouteContext,
  mapError,
  parseJsonBody,
  assertNoQuery,
  emitCommandAccepted,
  strictQueryParams,
  type ProductRouter,
} from "./shared.js";

export function registerProjectRoutes(router: ProductRouter, ctx: ProductRouteContext): void {
  router.get("/project-agent/opening-packet", async (c) => {
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
        ],
        "Project Agent开工包查询",
      );
      const query = projectAgentOpeningPacketV2QuerySchema.parse({
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
      });
      return c.json(
        projectAgentOpeningPacketV2ResponseSchema.parse(
          await getProjectAgentOpeningPacketV2(ctx.deps, {
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

  router.get("/project-agent/opening-packet-v3", async (c) => {
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
        ],
        "Project Agent v3开工包查询",
      );
      const query = projectAgentOpeningPacketV2QuerySchema.parse({
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
      });
      return c.json(
        projectAgentOpeningPacketV3ResponseSchema.parse(
          await getProjectAgentOpeningPacketV3(ctx.deps, {
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

  if (ctx.planeEnabled) {
    router.get("/content-production-projects/:projectId/plane-rollout-dry-run", async (c) => {
      try {
        const params = strictQueryParams(
          c.req.url,
          ["workspaceRootId", "planeWorkspaceSlug", "planeProjectIdentifier"],
          "Content Lab Plane Rollout Dry Run",
        );
        const query = contentLabPlaneRolloutDryRunQuerySchema.parse({
          projectId: c.req.param("projectId"),
          workspaceRootId: params.get("workspaceRootId"),
          planeWorkspaceSlug: params.get("planeWorkspaceSlug"),
          planeProjectIdentifier: params.get("planeProjectIdentifier"),
        });
        return c.json(
          contentLabPlaneRolloutDryRunResponseSchema.parse(
            await previewContentLabPlaneRollout(ctx.deps, {
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
  }

  router.post("/content-production-projects", async (c) => {
    try {
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const result = await createContentProductionProject(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        payload: createContentProductionProjectPayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/content-production-projects",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/projects/:projectId/agents", async (c) => {
    try {
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Agent注册必须携带Project expectedRevision",
        });
      }
      const result = await registerProjectAgent(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        projectId,
        expectedProjectRevision: envelope.expectedRevision,
        payload: registerProjectAgentPayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/projects/:projectId/agents",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/projects/:projectId/works", async (c) => {
    try {
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Work创建必须携带Project expectedRevision",
        });
      }
      const result = await createProjectWork(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        projectId,
        expectedProjectRevision: envelope.expectedRevision,
        payload: createProjectWorkPayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/projects/:projectId/works",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/projects/:projectId/evidence", async (c) => {
    try {
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const result = await recordProjectEvidence(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        projectId,
        payload: recordProjectEvidencePayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/projects/:projectId/evidence",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/projects/:projectId/works/:projectWorkId/claims", async (c) => {
    try {
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const workId = projectWorkIdSchema.parse(c.req.param("projectWorkId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Work Claim必须携带Work expectedRevision",
        });
      }
      const result = await claimProjectWork(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        projectId,
        workId,
        expectedWorkRevision: envelope.expectedRevision,
        payload: claimProjectWorkPayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/projects/:projectId/works/:projectWorkId/claims",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/projects/:projectId/works/:projectWorkId/blocks", async (c) => {
    try {
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const workId = projectWorkIdSchema.parse(c.req.param("projectWorkId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Work Block必须携带Work expectedRevision",
        });
      }
      const result = await blockProjectWork(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        projectId,
        workId,
        expectedWorkRevision: envelope.expectedRevision,
        payload: blockProjectWorkPayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/projects/:projectId/works/:projectWorkId/blocks",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/projects/:projectId/works/:projectWorkId/resume", async (c) => {
    try {
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const workId = projectWorkIdSchema.parse(c.req.param("projectWorkId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Work恢复必须携带Work expectedRevision",
        });
      }
      const result = await resumeProjectWork(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        projectId,
        workId,
        expectedWorkRevision: envelope.expectedRevision,
        payload: resumeProjectWorkPayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/projects/:projectId/works/:projectWorkId/resume",
        statusCode: 200,
      });
      return c.json(result, 200);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/projects/:projectId/works/:projectWorkId/review", async (c) => {
    try {
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const workId = projectWorkIdSchema.parse(c.req.param("projectWorkId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Work提审必须携带Work expectedRevision",
        });
      }
      const result = await requestProjectWorkReview(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        projectId,
        workId,
        expectedWorkRevision: envelope.expectedRevision,
        payload: requestProjectWorkReviewPayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/projects/:projectId/works/:projectWorkId/review",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/projects/:projectId/works/:projectWorkId/handoffs", async (c) => {
    try {
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const workId = projectWorkIdSchema.parse(c.req.param("projectWorkId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Work Handoff必须携带Work expectedRevision",
        });
      }
      const result = await handoffProjectWork(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        projectId,
        workId,
        expectedWorkRevision: envelope.expectedRevision,
        payload: handoffProjectWorkPayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/projects/:projectId/works/:projectWorkId/handoffs",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/projects/:projectId/works/:projectWorkId/decisions", async (c) => {
    try {
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const workId = projectWorkIdSchema.parse(c.req.param("projectWorkId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Work决定必须携带Work expectedRevision",
        });
      }
      const result = await decideProjectWorkTransition(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        projectId,
        workId,
        expectedWorkRevision: envelope.expectedRevision,
        payload: decideProjectWorkTransitionPayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/projects/:projectId/works/:projectWorkId/decisions",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/projects/:projectId/works/:projectWorkId/publications", async (c) => {
    try {
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const workId = projectWorkIdSchema.parse(c.req.param("projectWorkId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "发布结果必须携带Work expectedRevision",
        });
      }
      const result = await recordContentPublication(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        projectId,
        workId,
        expectedWorkRevision: envelope.expectedRevision,
        payload: recordContentPublicationPayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/projects/:projectId/works/:projectWorkId/publications",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/projects/:projectId/works/:projectWorkId/practice-revisions", async (c) => {
    try {
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const workId = projectWorkIdSchema.parse(c.req.param("projectWorkId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Practice采纳必须携带Work expectedRevision",
        });
      }
      const result = await adoptProjectPractice(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        projectId,
        workId,
        expectedWorkRevision: envelope.expectedRevision,
        payload: adoptProjectPracticePayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/projects/:projectId/works/:projectWorkId/practice-revisions",
        statusCode: 201,
      });
      return c.json(result, 201);
    } catch (error) {
      return mapError(c, error);
    }
  });

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

  router.get("/projects/:projectId/home", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      return c.json(
        await getProjectHome(ctx.deps, { principalId: ctx.principalId, projectId }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/projects/:projectId/objects", async (c) => {
    try {
      const params = strictQueryParams(
        c.req.url,
        ["q", "kind", "status", "view", "limit"],
        "Project Object Query",
      );
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const limit = params.get("limit");
      const query = projectObjectQuerySchema.parse({
        ...(params.get("q") === null ? {} : { q: params.get("q") }),
        ...(params.get("kind") === null ? {} : { kind: params.get("kind") }),
        ...(params.get("status") === null ? {} : { status: params.get("status") }),
        ...(params.get("view") === null ? {} : { view: params.get("view") }),
        ...(limit === null ? {} : { limit: Number(limit) }),
      });
      return c.json(
        await queryProjectObjects(ctx.deps, { principalId: ctx.principalId, projectId, query }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  /**
   * 一次性认领既有Plane项目是用户产品命令，不属于 scoped daily coordination key。
   * Application会先实时核验Project、State、Module和Label，再原子提交Binding。
   */
  if (ctx.planeEnabled) {
    router.post("/projects/:projectId/plane-binding-adoptions", async (c) => {
      try {
        const projectId = projectIdSchema.parse(c.req.param("projectId"));
        const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
        const payload = adoptExistingPlaneProjectPayloadSchema.parse(envelope.payload);
        if (payload.projectId !== projectId) {
          throw new ApplicationError({
            code: "validation_failed",
            httpStatus: 400,
            message: "路径与Payload的Project不一致",
          });
        }
        const result = await adoptExistingPlaneProject(ctx.deps, {
          principalId: ctx.principalId,
          commandId: envelope.commandId,
          ...payload,
        });
        emitCommandAccepted(ctx, c, {
          commandId: envelope.commandId,
          routeTemplate: "/api/projects/:projectId/plane-binding-adoptions",
          statusCode: 201,
        });
        return c.json(result, 201);
      } catch (error) {
        return mapError(c, error);
      }
    });
  }

  router.get("/projects/:projectId/contexts/:purpose", async (c) => {
    try {
      assertNoQuery(c.req.url);
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const purpose = projectContextPurposeSchema.parse(c.req.param("purpose"));
      return c.json(
        await compileProjectAgentContext(ctx.deps, {
          principalId: ctx.principalId,
          projectId,
          purpose,
        }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/projects/:projectId/contexts-v2/:purpose", async (c) => {
    try {
      const keys = [
        "workId",
        "workRevision",
        "subjectKind",
        "subjectId",
        "subjectRevision",
        "subjectSha256",
        "eventId",
        "eventRecordedAt",
        "eventPayloadSha256",
      ] as const;
      const params = strictQueryParams(c.req.url, [...keys], "Project Context v2查询");
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const purpose = projectContextPurposeSchema.parse(c.req.param("purpose"));
      const present = (key: (typeof keys)[number]) => params.get(key) !== null;
      const requireOnly = (required: readonly (typeof keys)[number][]) => {
        const requiredSet = new Set(required);
        if (keys.some((key) => present(key) !== requiredSet.has(key))) {
          throw new ApplicationError({
            code: "validation_failed",
            httpStatus: 400,
            message: `${purpose} Context目标参数不完整或包含多余字段`,
          });
        }
      };
      const positiveRevision = (key: "workRevision" | "subjectRevision") =>
        z.coerce.number().int().positive().parse(params.get(key));
      const target =
        purpose === "project_opening" || purpose === "maintenance"
          ? (requireOnly([]), { kind: "project" as const })
          : purpose === "work_execution" || purpose === "handoff"
            ? (requireOnly(["workId", "workRevision"]),
              {
                kind: "work" as const,
                workId: projectWorkIdSchema.parse(params.get("workId")),
                workRevision: positiveRevision("workRevision"),
              })
            : purpose === "review"
              ? (requireOnly([
                  "workId",
                  "workRevision",
                  "subjectKind",
                  "subjectId",
                  "subjectRevision",
                  "subjectSha256",
                ]),
                {
                  kind: "review" as const,
                  workId: projectWorkIdSchema.parse(params.get("workId")),
                  workRevision: positiveRevision("workRevision"),
                  subject: {
                    kind: projectManagedObjectKindSchema.parse(params.get("subjectKind")),
                    objectId: z.string().min(1).max(200).parse(params.get("subjectId")),
                    revision: positiveRevision("subjectRevision"),
                    sha256: z
                      .string()
                      .regex(/^[a-f0-9]{64}$/u)
                      .parse(params.get("subjectSha256")),
                  },
                })
              : (requireOnly(["eventId", "eventRecordedAt", "eventPayloadSha256"]),
                {
                  kind: "delta" as const,
                  watermark: {
                    projectEventId: z.string().min(1).max(200).parse(params.get("eventId")),
                    recordedAt: z.iso.datetime().parse(params.get("eventRecordedAt")),
                    payloadSha256: z
                      .string()
                      .regex(/^[a-f0-9]{64}$/u)
                      .parse(params.get("eventPayloadSha256")),
                  },
                });
      const request = projectAgentContextV2RequestSchema.parse({ purpose, target });
      return c.json(
        await compileProjectAgentContextV2(ctx.deps, {
          principalId: ctx.principalId,
          projectId,
          ...request,
        }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.get("/projects/:projectId/maintenance", async (c) => {
    try {
      const params = strictQueryParams(c.req.url, ["trigger"], "Project Maintenance查询");
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const trigger = z
        .enum([
          "agent_started",
          "agent_finished",
          "resource_changed",
          "provider_changed",
          "deadline",
          "daily",
          "weekly",
          "monthly",
          "manual",
        ])
        .parse(params.get("trigger"));
      return c.json(
        await evaluateProjectMaintenance(ctx.deps, {
          principalId: ctx.principalId,
          projectId,
          trigger,
        }),
        200,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/projects/:projectId/configuration-candidates", async (c) => {
    try {
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Configuration候选必须携带Project expectedRevision",
        });
      }
      return c.json(
        await proposeProjectConfiguration(ctx.deps, {
          principalId: ctx.principalId,
          commandId: envelope.commandId,
          projectId,
          expectedProjectRevision: envelope.expectedRevision,
          payload: proposeProjectConfigurationPayloadSchema.parse(envelope.payload),
        }),
        201,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/projects/:projectId/configuration-adoptions", async (c) => {
    try {
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Configuration采用必须携带Project expectedRevision",
        });
      }
      const payload = adoptProjectConfigurationPayloadSchema.parse(envelope.payload);
      return c.json(
        await adoptProjectConfiguration(ctx.deps, {
          principalId: ctx.principalId,
          commandId: envelope.commandId,
          projectId,
          expectedProjectRevision: envelope.expectedRevision,
          expectedCandidateRevision: payload.candidateRevision,
          payload,
        }),
        201,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/projects/:projectId/needs", async (c) => {
    try {
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Need记录必须携带Project expectedRevision",
        });
      }
      return c.json(
        await captureProjectNeed(ctx.deps, {
          principalId: ctx.principalId,
          commandId: envelope.commandId,
          projectId,
          expectedProjectRevision: envelope.expectedRevision,
          payload: captureProjectNeedPayloadSchema.parse(envelope.payload),
        }),
        201,
      );
    } catch (error) {
      return mapError(c, error);
    }
  });

  router.post("/projects/:projectId/requirements", async (c) => {
    try {
      const projectId = projectIdSchema.parse(c.req.param("projectId"));
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      if (envelope.expectedRevision === undefined) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 400,
          message: "Requirement候选必须携带Project expectedRevision",
        });
      }
      return c.json(
        await proposeProjectRequirement(ctx.deps, {
          principalId: ctx.principalId,
          commandId: envelope.commandId,
          projectId,
          expectedProjectRevision: envelope.expectedRevision,
          payload: proposeProjectRequirementPayloadSchema.parse(envelope.payload),
        }),
        201,
      );
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

  router.post("/projects", async (c) => {
    try {
      const envelope = commandEnvelopeSchema.parse(await parseJsonBody(c));
      const result = await createManagedProject(ctx.deps, {
        principalId: ctx.principalId,
        commandId: envelope.commandId,
        payload: createManagedProjectPayloadSchema.parse(envelope.payload),
      });
      emitCommandAccepted(ctx, c, {
        commandId: envelope.commandId,
        routeTemplate: "/api/projects",
        statusCode: 201,
      });
      return c.json(result, 201);
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
