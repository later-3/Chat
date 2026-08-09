import { z } from "zod";
import { getHookByToken, getRun, resumeHook, start } from "workflow/api";
import {
  memoryImportWorkflowDispatchRequestSchema,
  MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
  projectIntakeWorkflowDispatchRequestSchema,
  projectIntakeWorkflowInputSchema,
  projectIntakeHookPayloadSchema,
  PROJECT_INTAKE_WORKFLOW_DEFINITION_VERSION,
  projectAdvancementWorkflowDispatchRequestSchema,
  projectAdvancementWorkflowInputSchema,
  projectAdvancementHookPayloadSchema,
  PROJECT_ADVANCEMENT_WORKFLOW_DEFINITION_VERSION,
} from "@chat/contracts";
import { memoryImportWorkflowInputSchema } from "./memory-import-workflow-input.js";
import type { WorkflowRuntimeHttpRouteContext } from "./runtime-http-route-context.js";

/** 注册Memory Import与Project Candidate独立Workflow的分派、恢复与对账端点。 */
export function registerOperationalWorkflowHttpRoutes(
  context: WorkflowRuntimeHttpRouteContext,
): void {
  const { app, bindings, world } = context;
  app.post("/internal/workflow/v1/memory-import/start", async (c) => {
    const parsed = memoryImportWorkflowDispatchRequestSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return c.json({ code: "validation_failed", title: "请求不符合合同" }, 400);
    }
    const request = parsed.data;
    if (request.workflowDefinitionVersion !== MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION) {
      return c.json({ code: "revision_conflict", title: "Memory Import Workflow版本不一致" }, 409);
    }
    const startClaim = await bindings.claimMemoryImportStartIntent({
      outboxId: request.outboxId,
      memoryImportIntentId: request.memoryImportIntentId,
      memoryImportResultId: request.memoryImportResultId,
      mode: request.mode,
      workflowDefinitionVersion: request.workflowDefinitionVersion,
      now: new Date().toISOString(),
    });
    if (startClaim === "already_started") {
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "already_started" }, 200);
    }
    if (startClaim === "outcome_unknown") {
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
    try {
      const run = await start({ workflowId: world.memoryImportWorkflowId }, [
        memoryImportWorkflowInputSchema.parse({
          schemaVersion: "memory-import-workflow-input.v1",
          memoryImportIntentId: request.memoryImportIntentId,
          memoryImportResultId: request.memoryImportResultId,
          outboxId: request.outboxId,
          expectedResultRevision: request.expectedResultRevision,
          mode: request.mode,
        }),
      ]);
      await bindings.claimMemoryImportWorkflowBinding({
        outboxId: request.outboxId,
        memoryImportIntentId: request.memoryImportIntentId,
        memoryImportResultId: request.memoryImportResultId,
        mode: request.mode,
        workflowRunId: run.runId,
        workflowDefinitionVersion: request.workflowDefinitionVersion,
        now: new Date().toISOString(),
      });
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "started" }, 201);
    } catch {
      await bindings.markMemoryImportStartOutcomeUnknown(
        request.outboxId,
        new Date().toISOString(),
      );
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
  });

  app.post("/internal/workflow/v1/project-intake/start", async (c) => {
    const parsed = projectIntakeWorkflowDispatchRequestSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return c.json({ code: "validation_failed", title: "请求不符合合同" }, 400);
    }
    const request = parsed.data;
    if (request.workflowDefinitionVersion !== PROJECT_INTAKE_WORKFLOW_DEFINITION_VERSION) {
      return c.json({ code: "revision_conflict", title: "Project Intake Workflow版本不一致" }, 409);
    }
    const startClaim = await bindings.claimProjectIntakeStartIntent({
      projectCandidateId: request.projectCandidateId,
      outboxId: request.outboxId,
      workflowDefinitionVersion: request.workflowDefinitionVersion,
      now: new Date().toISOString(),
    });
    if (startClaim === "already_started") {
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "already_started" }, 200);
    }
    if (startClaim === "outcome_unknown") {
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
    const hookToken = `pih-${request.projectCandidateId}`;
    try {
      const run = await start({ workflowId: world.projectIntakeWorkflowId }, [
        projectIntakeWorkflowInputSchema.parse({
          schemaVersion: "project-intake-workflow-input.v1",
          projectCandidateId: request.projectCandidateId,
          expectedCandidateRevision: request.expectedCandidateRevision,
        }),
      ]);
      await bindings.claimProjectIntakeWorkflowBinding({
        projectCandidateId: request.projectCandidateId,
        outboxId: request.outboxId,
        workflowRunId: run.runId,
        workflowDefinitionVersion: request.workflowDefinitionVersion,
        hookToken,
        now: new Date().toISOString(),
      });
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "started" }, 201);
    } catch {
      // start越过Runtime边界后无法确认时绝不重派；Binding与Outbox均保留未知状态。
      await bindings.markProjectIntakeStartOutcomeUnknown(
        request.projectCandidateId,
        new Date().toISOString(),
      );
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
  });

  app.post("/internal/workflow/v1/project-intake/resume", async (c) => {
    const parsed = projectIntakeWorkflowDispatchRequestSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return c.json({ code: "validation_failed", title: "请求不符合合同" }, 400);
    }
    const request = parsed.data;
    if (request.workflowDefinitionVersion !== PROJECT_INTAKE_WORKFLOW_DEFINITION_VERSION) {
      return c.json({ code: "revision_conflict", title: "Project Intake Workflow版本不一致" }, 409);
    }
    let binding = bindings.getProjectIntakeBinding(request.projectCandidateId);
    const deadline = Date.now() + 5_000;
    while (binding === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      binding = bindings.getProjectIntakeBinding(request.projectCandidateId);
    }
    if (binding === undefined) {
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
    if (binding.resumeDispatchState === "dispatched") {
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "already_resumed" }, 200);
    }
    if (
      binding.resumeDispatchState === "dispatching" ||
      binding.resumeDispatchState === "outcome_unknown"
    ) {
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
    if (binding.resumeDispatchState === "failed_terminal") {
      return c.json({ code: "workflow_resume_unknown", title: "Project Intake恢复已终止" }, 409);
    }
    try {
      await getHookByToken(binding.hookToken);
    } catch {
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        try {
          await getHookByToken(binding.hookToken);
          break;
        } catch {
          if (Date.now() >= deadline) {
            return c.json(
              { schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" },
              202,
            );
          }
        }
      }
    }
    await bindings.markProjectIntakeResumeDispatching(
      request.projectCandidateId,
      new Date().toISOString(),
    );
    try {
      await resumeHook(
        binding.hookToken,
        projectIntakeHookPayloadSchema.parse({
          schemaVersion: "project-intake-hook-payload.v1",
          projectCandidateId: request.projectCandidateId,
          candidateRevision: request.expectedCandidateRevision,
        }),
      );
      await bindings.markProjectIntakeResumeDispatched(
        request.projectCandidateId,
        new Date().toISOString(),
      );
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "resumed" }, 200);
    } catch {
      await bindings.markProjectIntakeResumeOutcomeUnknown(
        request.projectCandidateId,
        new Date().toISOString(),
      );
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
  });

  app.post("/internal/workflow/v1/project-advancement/start", async (c) => {
    const parsed = projectAdvancementWorkflowDispatchRequestSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return c.json({ code: "validation_failed", title: "请求不符合合同" }, 400);
    }
    const request = parsed.data;
    const startClaim = await bindings.claimProjectIntakeStartIntent({
      projectCandidateId: request.projectCandidateId,
      outboxId: request.outboxId,
      workflowDefinitionVersion: request.workflowDefinitionVersion,
      now: new Date().toISOString(),
    });
    if (startClaim === "already_started") {
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "already_started" }, 200);
    }
    if (startClaim === "outcome_unknown") {
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
    const hookToken = `pah-${request.projectCandidateId}`;
    try {
      const run = await start({ workflowId: world.projectAdvancementWorkflowId }, [
        projectAdvancementWorkflowInputSchema.parse({
          schemaVersion: "project-advancement-workflow-input.v1",
          projectCandidateId: request.projectCandidateId,
          expectedCandidateRevision: request.expectedCandidateRevision,
        }),
      ]);
      await bindings.claimProjectIntakeWorkflowBinding({
        projectCandidateId: request.projectCandidateId,
        outboxId: request.outboxId,
        workflowRunId: run.runId,
        workflowDefinitionVersion: request.workflowDefinitionVersion,
        hookToken,
        now: new Date().toISOString(),
      });
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "started" }, 201);
    } catch {
      await bindings.markProjectIntakeStartOutcomeUnknown(
        request.projectCandidateId,
        new Date().toISOString(),
      );
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
  });

  app.post("/internal/workflow/v1/project-advancement/resume", async (c) => {
    const parsed = projectAdvancementWorkflowDispatchRequestSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return c.json({ code: "validation_failed", title: "请求不符合合同" }, 400);
    }
    const request = parsed.data;
    let binding = bindings.getProjectIntakeBinding(request.projectCandidateId);
    const deadline = Date.now() + 5_000;
    while (binding === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      binding = bindings.getProjectIntakeBinding(request.projectCandidateId);
    }
    if (binding === undefined) {
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
    if (binding.workflowDefinitionVersion !== PROJECT_ADVANCEMENT_WORKFLOW_DEFINITION_VERSION) {
      return c.json(
        { code: "revision_conflict", title: "Project Advancement Workflow版本不一致" },
        409,
      );
    }
    if (binding.resumeDispatchState === "dispatched") {
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "already_resumed" }, 200);
    }
    if (
      binding.resumeDispatchState === "dispatching" ||
      binding.resumeDispatchState === "outcome_unknown"
    ) {
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
    if (binding.resumeDispatchState === "failed_terminal") {
      return c.json(
        { code: "workflow_resume_unknown", title: "Project Advancement恢复已终止" },
        409,
      );
    }
    try {
      await getHookByToken(binding.hookToken);
    } catch {
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        try {
          await getHookByToken(binding.hookToken);
          break;
        } catch {
          if (Date.now() >= deadline) {
            return c.json(
              { schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" },
              202,
            );
          }
        }
      }
    }
    await bindings.markProjectIntakeResumeDispatching(
      request.projectCandidateId,
      new Date().toISOString(),
    );
    try {
      await resumeHook(
        binding.hookToken,
        projectAdvancementHookPayloadSchema.parse({
          schemaVersion: "project-advancement-hook-payload.v1",
          projectCandidateId: request.projectCandidateId,
          candidateRevision: request.expectedCandidateRevision,
        }),
      );
      await bindings.markProjectIntakeResumeDispatched(
        request.projectCandidateId,
        new Date().toISOString(),
      );
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "resumed" }, 200);
    } catch {
      await bindings.markProjectIntakeResumeOutcomeUnknown(
        request.projectCandidateId,
        new Date().toISOString(),
      );
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
  });

  const memoryImportReconcileQuerySchema = z.object({ outboxId: z.string().min(1) }).strict();
  app.get("/internal/workflow/v1/memory-import/reconcile", async (c) => {
    const query = memoryImportReconcileQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ code: "validation_failed", title: "请求不符合合同" }, 400);
    }
    const outboxId = query.data.outboxId as never;
    const startBinding = bindings.getMemoryImportStartState(outboxId);
    if (startBinding !== "exists") {
      return c.json({
        schemaVersion: "chat-workflow-dispatch.v1",
        outboxId: query.data.outboxId,
        startBinding,
      });
    }
    const binding = bindings.getMemoryImportWorkflowBinding(outboxId);
    const run = binding === undefined ? undefined : getRun(binding.workflowRunId);
    const status = run === undefined || !(await run.exists) ? "missing" : String(await run.status);
    const runStatus = ["completed", "failed", "cancelled"].includes(status)
      ? status
      : status === "missing"
        ? "missing"
        : "active";
    return c.json({
      schemaVersion: "chat-workflow-dispatch.v1",
      outboxId: query.data.outboxId,
      startBinding,
      runStatus,
    });
  });
}
