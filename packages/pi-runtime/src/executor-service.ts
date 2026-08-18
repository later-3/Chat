import { timingSafeEqual } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import {
  EXECUTOR_PROMPT_TEMPLATE_VERSION,
  MODEL_CONFIG_VERSION,
  authorizeExecutorOperationResponseSchema,
  type AuthorizeExecutorOperationRequest,
  type AuthorizeExecutorOperationResponse,
} from "@chat/contracts";
import { computeExecutionInputManifestSha256, hashCanonical } from "@chat/domain";
import type { BailianConfig } from "./config.js";
import {
  AgentSessionPiCodingAgentRunner,
  PiCodingAgentExecutionError,
  type PiCodingAgentRunner,
} from "./coding-agent-executor.js";
import {
  PiExecutorOperationConflictError,
  PiExecutorOperationNotFoundError,
  type PiExecutorOperationStore,
} from "./executor-operation-store.js";
import {
  PI_EXECUTOR_PROTOCOL_VERSION,
  PI_EXECUTOR_RUNTIME_HEADER,
  piExecutorEventsResponseSchema,
  piExecutorOperationSnapshotSchema,
  piOperationIdSchema,
  startPiExecutorOperationRequestSchema,
} from "./executor-service-contract.js";

const projectRootConfigSchema = z
  .array(
    z
      .object({
        rootId: z.string().regex(/^root_[A-Za-z0-9]+$/u),
        displayName: z.string().min(1).max(160),
        canonicalPath: z.string().min(1).max(2_000),
        enabledAdapters: z.array(z.string()).min(1).max(20),
      })
      .strict(),
  )
  .max(20);

export interface PiExecutorWorkspaceRoot {
  readonly rootId: string;
  readonly canonicalPath: string;
}

/** canonical path只存在于Executor Service内存，不进入Operation协议、Trace或产品事实。 */
export async function loadPiExecutorWorkspaceRoots(
  env: NodeJS.ProcessEnv,
): Promise<ReadonlyMap<string, PiExecutorWorkspaceRoot>> {
  const raw = env.CHAT_PROJECT_ROOTS_JSON;
  if (raw === undefined || raw.trim() === "") return new Map();
  const parsed = projectRootConfigSchema.parse(JSON.parse(raw));
  const roots = new Map<string, PiExecutorWorkspaceRoot>();
  for (const item of parsed) {
    if (roots.has(item.rootId)) throw new Error("Pi Executor Workspace Root重复");
    const canonicalPath = await realpath(item.canonicalPath);
    if (!(await stat(canonicalPath)).isDirectory())
      throw new Error("Pi Executor Workspace Root不是目录");
    roots.set(item.rootId, { rootId: item.rootId, canonicalPath });
  }
  return roots;
}

export interface PiExecutorServiceOptions {
  readonly credential: string;
  readonly store: PiExecutorOperationStore;
  readonly bailian: BailianConfig;
  readonly workspaceRoots: ReadonlyMap<string, PiExecutorWorkspaceRoot>;
  readonly emptyWorkspaceRoot: string;
  readonly agentDir: string;
  readonly sessionsDir: string;
  readonly authorizeOperation: (
    input: Omit<AuthorizeExecutorOperationRequest, "schemaVersion">,
  ) => Promise<AuthorizeExecutorOperationResponse>;
  readonly runner?: PiCodingAgentRunner;
}

function authorized(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function stableServiceErrorCode(error: unknown): string {
  if (error instanceof PiCodingAgentExecutionError) return error.code;
  if (error instanceof z.ZodError) return "executor.contract_invalid";
  return "executor.session_failed";
}

function statusForError(error: unknown): 400 | 401 | 404 | 409 | 500 {
  if (error instanceof PiExecutorOperationConflictError) return 409;
  if (error instanceof PiExecutorOperationNotFoundError) return 404;
  if (error instanceof PiCodingAgentExecutionError) return 400;
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 400;
  return 500;
}

function problem(error: unknown): { readonly errorCode: string } {
  if (
    error instanceof PiExecutorOperationConflictError ||
    error instanceof PiExecutorOperationNotFoundError
  ) {
    return { errorCode: error.code };
  }
  if (error instanceof PiCodingAgentExecutionError) return { errorCode: error.code };
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return { errorCode: "executor.contract_invalid" };
  }
  return { errorCode: "executor.internal_error" };
}

export function createPiExecutorService(options: PiExecutorServiceOptions) {
  const app = new Hono();
  const runner = options.runner ?? new AgentSessionPiCodingAgentRunner();
  const active = new Map<string, AbortController>();
  const tasks = new Set<Promise<void>>();

  app.use("/internal/*", async (c, next) => {
    if (!authorized(c.req.header(PI_EXECUTOR_RUNTIME_HEADER), options.credential)) {
      return c.json({ errorCode: "runtime.unauthorized" }, 401);
    }
    await next();
  });

  app.get("/healthz", (c) =>
    c.json({ service: "chat-pi-executor", protocolVersion: PI_EXECUTOR_PROTOCOL_VERSION }),
  );

  app.post("/internal/pi-executor/v1/operations", async (c) => {
    try {
      const submitted = startPiExecutorOperationRequestSchema.parse(await c.req.json());
      let authorization: AuthorizeExecutorOperationResponse;
      try {
        authorization = authorizeExecutorOperationResponseSchema.parse(
          await options.authorizeOperation({
            executionAttemptId: submitted.executionAttemptId,
            executionContractId: submitted.contract.executionContractId,
            executionContractSha256: submitted.contract.sha256,
            stepId: submitted.stepId,
            inputManifestSha256: submitted.inputManifestSha256,
          }),
        );
      } catch {
        throw new PiCodingAgentExecutionError("executor.authorization_failed");
      }
      if (
        authorization.executionAttemptId !== submitted.executionAttemptId ||
        authorization.productRunId !== authorization.contract.productRunId
      ) {
        throw new PiCodingAgentExecutionError("executor.authorization_mismatch");
      }
      const request = startPiExecutorOperationRequestSchema.parse({
        ...submitted,
        contract: authorization.contract,
        contextItems: authorization.contextItems,
      });
      validateOperationRequest(request, authorization.dependencyRefs);
      const created = await options.store.createOrGet(request);
      if (created.created) {
        const task = launch(request.operationId);
        tasks.add(task);
        void task.finally(() => tasks.delete(task)).catch(() => undefined);
      }
      return c.json(created.snapshot, created.created ? 202 : 200);
    } catch (error) {
      return c.json(problem(error), statusForError(error));
    }
  });

  app.get("/internal/pi-executor/v1/operations/:operationId", (c) => {
    try {
      const operationId = piOperationIdSchema.parse(c.req.param("operationId"));
      return c.json(
        piExecutorOperationSnapshotSchema.parse(options.store.getSnapshot(operationId)),
      );
    } catch (error) {
      return c.json(problem(error), statusForError(error));
    }
  });

  app.get("/internal/pi-executor/v1/operations/:operationId/events", (c) => {
    try {
      const operationId = piOperationIdSchema.parse(c.req.param("operationId"));
      const rawAfter = c.req.query("afterSequence") ?? "0";
      if (!/^\d+$/u.test(rawAfter)) throw new SyntaxError("afterSequence非法");
      const afterSequence = Number.parseInt(rawAfter, 10);
      const events = options.store.getEvents(operationId, afterSequence);
      return c.json(
        piExecutorEventsResponseSchema.parse({
          schemaVersion: PI_EXECUTOR_PROTOCOL_VERSION,
          operationId,
          events,
          lastEventSequence: options.store.getSnapshot(operationId).lastEventSequence,
        }),
      );
    } catch (error) {
      return c.json(problem(error), statusForError(error));
    }
  });

  app.post("/internal/pi-executor/v1/operations/:operationId/abort", (c) => {
    try {
      const operationId = piOperationIdSchema.parse(c.req.param("operationId"));
      const snapshot = options.store.getSnapshot(operationId);
      active.get(operationId)?.abort(new Error("operation aborted"));
      return c.json(snapshot, 202);
    } catch (error) {
      return c.json(problem(error), statusForError(error));
    }
  });

  async function launch(operationId: string): Promise<void> {
    if (active.has(operationId)) return;
    const controller = new AbortController();
    active.set(operationId, controller);
    const request = options.store.getRequest(operationId);
    const startedAt = performance.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await options.store.markRunning(operationId);
      const workspaceRef = request.contract.workspaceRef;
      const requiresWorkspace = request.contract.steps
        .find((step) => step.stepId === request.stepId)
        ?.capabilityRefs.some((capability) => capability !== "markdown_text_compose");
      let cwd = resolve(options.emptyWorkspaceRoot, operationId);
      if (requiresWorkspace === true) {
        if (workspaceRef === undefined) {
          throw new PiCodingAgentExecutionError("executor.workspace_binding_missing");
        }
        const configured = options.workspaceRoots.get(workspaceRef.rootId);
        if (configured === undefined) {
          throw new PiCodingAgentExecutionError("executor.workspace_not_allowed");
        }
        cwd = configured.canonicalPath;
      }
      timeout = setTimeout(
        () => controller.abort(new Error("operation timeout")),
        request.contract.limits.timeoutMsPerStep,
      );
      const result = await runner.run({
        request,
        cwd,
        agentDir: options.agentDir,
        sessionsDir: options.sessionsDir,
        config: options.bailian,
        store: options.store,
        signal: controller.signal,
      });
      await options.store.complete(operationId, result, Math.round(performance.now() - startedAt));
    } catch (error) {
      const errorCode = controller.signal.aborted
        ? "executor.timeout"
        : stableServiceErrorCode(error);
      await options.store.fail(operationId, errorCode, Math.round(performance.now() - startedAt));
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      active.delete(operationId);
    }
  }

  const close = async () => {
    for (const controller of active.values()) controller.abort(new Error("service shutdown"));
    await Promise.allSettled([...tasks]);
  };

  return { app, close };
}

function validateOperationRequest(
  request: z.infer<typeof startPiExecutorOperationRequestSchema>,
  authorizedDependencyRefs: AuthorizeExecutorOperationResponse["dependencyRefs"],
): void {
  const contractSha256 = hashCanonical("execution-contract.v1", {
    productRunId: request.contract.productRunId,
    approvedPlanId: request.contract.approvedPlanId,
    approvedPlanRevision: request.contract.approvedPlanRevision,
    approvedPlanSha256: request.contract.approvedPlanSha256,
    approvalDecisionId: request.contract.approvalDecisionId,
    steps: request.contract.steps,
    completionCriteria: request.contract.completionCriteria,
    ...(request.contract.workspaceRef !== undefined
      ? { workspaceRef: request.contract.workspaceRef }
      : {}),
    capabilityRefs: request.contract.capabilityRefs,
    limits: request.contract.limits,
  });
  if (contractSha256 !== request.contract.sha256) {
    throw new PiCodingAgentExecutionError("execution.contract_hash_mismatch");
  }
  const step = request.contract.steps.find((candidate) => candidate.stepId === request.stepId);
  if (step === undefined) throw new PiCodingAgentExecutionError("executor.step_not_found");
  const contextRefs = request.contextItems.map(({ refId, revision, sha256 }) => ({
    refId,
    revision,
    sha256,
  }));
  if (JSON.stringify(contextRefs) !== JSON.stringify(step.inputRefs)) {
    throw new PiCodingAgentExecutionError("execution.context_ref_mismatch");
  }
  const dependencyRefs = request.dependencyResults.map(
    ({ stepId, executionAttemptId, sha256 }) => ({ stepId, executionAttemptId, sha256 }),
  );
  if (JSON.stringify(dependencyRefs) !== JSON.stringify(authorizedDependencyRefs)) {
    throw new PiCodingAgentExecutionError("execution.dependency_authorization_mismatch");
  }
  for (const dependency of request.dependencyResults) {
    const { sha256, ...durable } = dependency;
    if (hashCanonical("execution-step-result.v1", durable) !== sha256) {
      throw new PiCodingAgentExecutionError("execution.dependency_hash_mismatch");
    }
  }
  if (
    JSON.stringify(request.dependencyResults.map((dependency) => dependency.stepId)) !==
    JSON.stringify(step.dependsOn)
  ) {
    throw new PiCodingAgentExecutionError("execution.dependency_mismatch");
  }
  const computed = computeExecutionInputManifestSha256({
    executionContractId: request.contract.executionContractId,
    approvedPlanSha256: request.contract.approvedPlanSha256,
    stepId: request.stepId,
    inputRefs: step.inputRefs,
    dependencyRefs,
    promptTemplateVersion: EXECUTOR_PROMPT_TEMPLATE_VERSION,
    modelConfigVersion: MODEL_CONFIG_VERSION,
  });
  if (computed !== request.inputManifestSha256) {
    throw new PiCodingAgentExecutionError("execution.input_manifest_mismatch");
  }
  const contractCapabilities = new Set(request.contract.capabilityRefs);
  if (step.capabilityRefs.some((capability) => !contractCapabilities.has(capability))) {
    throw new PiCodingAgentExecutionError("execution.capability_mismatch");
  }
}
