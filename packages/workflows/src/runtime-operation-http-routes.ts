import { z } from "zod";
import { getRun, start } from "workflow/api";
import {
  memoryImportWorkflowDispatchRequestSchema,
  memoryWriteWorkflowDispatchRequestSchema,
  MEMORY_WRITE_WORKFLOW_DEFINITION_VERSION,
  MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
} from "@chat/contracts";
import { memoryImportWorkflowInputSchema } from "./memory-import-workflow-input.js";
import { memoryWriteWorkflowInputSchema } from "./memory-write-workflow-input.js";
import type { WorkflowRuntimeHttpRouteContext } from "./runtime-http-route-context.js";

/** 注册Memory独立Workflow的分派、恢复与对账端点。 */
export function registerOperationalWorkflowHttpRoutes(
  context: WorkflowRuntimeHttpRouteContext,
): void {
  const { app, bindings, world } = context;
  app.post("/internal/workflow/v1/memory-write/start", async (c) => {
    const parsed = memoryWriteWorkflowDispatchRequestSchema.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!parsed.success) {
      return c.json({ code: "validation_failed", title: "请求不符合合同" }, 400);
    }
    const request = parsed.data;
    if (request.workflowDefinitionVersion !== MEMORY_WRITE_WORKFLOW_DEFINITION_VERSION) {
      return c.json({ code: "revision_conflict", title: "Memory Write Workflow版本不一致" }, 409);
    }
    const startClaim = await bindings.claimMemoryWriteStartIntent({
      outboxId: request.outboxId,
      memoryWriteIntentId: request.memoryWriteIntentId,
      memoryWriteResultId: request.memoryWriteResultId,
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
      const run = await start({ workflowId: world.memoryWriteWorkflowId }, [
        memoryWriteWorkflowInputSchema.parse({
          schemaVersion: "memory-write-workflow-input.v1",
          memoryWriteIntentId: request.memoryWriteIntentId,
          memoryWriteResultId: request.memoryWriteResultId,
          outboxId: request.outboxId,
          expectedResultRevision: request.expectedResultRevision,
          mode: request.mode,
        }),
      ]);
      await bindings.claimMemoryWriteWorkflowBinding({
        outboxId: request.outboxId,
        memoryWriteIntentId: request.memoryWriteIntentId,
        memoryWriteResultId: request.memoryWriteResultId,
        mode: request.mode,
        workflowRunId: run.runId,
        workflowDefinitionVersion: request.workflowDefinitionVersion,
        now: new Date().toISOString(),
      });
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "started" }, 201);
    } catch {
      await bindings.markMemoryWriteStartOutcomeUnknown(request.outboxId, new Date().toISOString());
      return c.json({ schemaVersion: "chat-workflow-dispatch.v1", status: "outcome_unknown" }, 202);
    }
  });

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

  const memoryImportReconcileQuerySchema = z.object({ outboxId: z.string().min(1) }).strict();
  app.get("/internal/workflow/v1/memory-write/reconcile", async (c) => {
    const query = memoryImportReconcileQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ code: "validation_failed", title: "请求不符合合同" }, 400);
    }
    const outboxId = query.data.outboxId as never;
    const startBinding = bindings.getMemoryWriteStartState(outboxId);
    if (startBinding !== "exists") {
      return c.json({
        schemaVersion: "chat-workflow-dispatch.v1",
        outboxId: query.data.outboxId,
        startBinding,
      });
    }
    const binding = bindings.getMemoryWriteWorkflowBinding(outboxId);
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
