import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import {
  AgentSessionPiDirectAgentRunner,
  DirectAgentExecutionError,
  DirectAgentSuspendedError,
  P1_DIRECT_AGENT_PROFILE,
  type DirectAgentRunInput,
  type DirectAgentRunner,
} from "./direct-agent-executor.js";
import {
  PiDirectExecutorOperationConflictError,
  PiDirectExecutorOperationNotFoundError,
  type PiDirectExecutorOperationStore,
} from "./direct-executor-operation-store.js";
import { operationIdForDirectAgentAttempt } from "./direct-executor-identity.js";
import {
  PI_DIRECT_EXECUTOR_PROTOCOL_VERSION,
  authorizedDirectAgentProfileSchema,
  directAgentResultRefSchema,
  piDirectExecutorEventsResponseSchema,
  piDirectExecutorOperationSnapshotSchema,
  startPiDirectExecutorOperationRequestSchema,
  submitDirectPromptReviewDecisionRequestSchema,
  type DirectAgentResultRef,
  type AuthorizedDirectAgentProfile,
  type StartPiDirectExecutorOperationRequest,
} from "./direct-executor-service-contract.js";
import { PI_EXECUTOR_RUNTIME_HEADER, piOperationIdSchema } from "./executor-service-contract.js";
import {
  DirectPromptReviewCoordinator,
  PromptReviewRejectedError,
  type DirectPromptReviewProductPort,
} from "./prompt-review-gate.js";
import { hashExecutorValue } from "./executor-operation-store.js";
import type { PiExecutorWorkspaceRoot } from "./executor-service.js";

export interface AuthorizedDirectAgentInput {
  readonly productRunId: string;
  readonly directAgentAttemptId: string;
  readonly runRevision: number;
  readonly sourceMessage: {
    readonly messageId: string;
    readonly text: string;
    readonly sha256: string;
  };
  readonly promptAssembly:
    | {
        readonly schemaVersion: "prompt-assembly.v1";
        readonly promptAssemblyId: string;
        readonly sha256: string;
        readonly systemPromptAppend: string;
        readonly userPrompt: string;
        readonly workspaceRootId?: string | undefined;
      }
    | {
        readonly schemaVersion: "prompt-assembly.v2";
        readonly promptAssemblyId: string;
        readonly sha256: string;
        readonly systemPromptAppend: string;
        readonly messages: readonly {
          readonly role: "user" | "assistant";
          readonly text: string;
          readonly source: Readonly<Record<string, unknown>>;
          readonly estimatedTokens: number;
        }[];
        readonly tools: {
          readonly capabilityMode: "read_only";
          readonly names: ("read" | "grep" | "find" | "ls")[];
          readonly estimatedTokens: 8_000;
        };
        readonly requestOptions: {
          readonly providerId: "dashscope-coding";
          readonly modelId: "qwen3.7-plus";
          readonly thinkingLevel: "off";
          readonly retryEnabled: false;
          readonly compactionEnabled: false;
        };
        readonly budget: Readonly<Record<string, unknown>>;
        readonly workspaceRootId?: string | undefined;
      };
  readonly capabilityMode: "read_only";
  readonly limits: AuthorizedDirectAgentProfile["limits"];
}

export interface PublishDirectAgentResultInput {
  readonly commandId: string;
  readonly productRunId: string;
  readonly directAgentAttemptId: string;
  readonly output: { readonly format: "markdown"; readonly text: string };
}

export interface PiDirectExecutorServiceOptions {
  readonly credential: string;
  readonly store: PiDirectExecutorOperationStore;
  readonly workspaceRoots: ReadonlyMap<string, PiExecutorWorkspaceRoot>;
  readonly emptyWorkspaceRoot: string;
  readonly agentDir: string;
  readonly sessionsDir: string;
  readonly checkpointsDir: string;
  readonly authorizeOperation: (
    request: StartPiDirectExecutorOperationRequest,
  ) => Promise<AuthorizedDirectAgentInput>;
  readonly promptReviewProduct: DirectPromptReviewProductPort;
  readonly publishResult: (input: PublishDirectAgentResultInput) => Promise<DirectAgentResultRef>;
  readonly runner?: DirectAgentRunner;
}

/** 只累计运行时钟；Prompt Review人工等待期间由Gate暂停。 */
export class PausableOperationTimeout {
  private remainingMs: number;
  private activeSince = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    timeoutMs: number,
    private readonly onTimeout: () => void,
  ) {
    this.remainingMs = timeoutMs;
    this.resume();
  }

  pause = (): void => {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.remainingMs = Math.max(0, this.remainingMs - (Date.now() - this.activeSince));
  };

  resume = (): void => {
    if (this.timer !== undefined) return;
    if (this.remainingMs <= 0) {
      this.onTimeout();
      return;
    }
    this.activeSince = Date.now();
    this.timer = setTimeout(this.onTimeout, this.remainingMs);
  };

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function authorized(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function statusForError(error: unknown): 400 | 401 | 404 | 409 | 500 {
  if (error instanceof PiDirectExecutorOperationConflictError) return 409;
  if (error instanceof PiDirectExecutorOperationNotFoundError) return 404;
  if (error instanceof DirectAgentExecutionError || error instanceof z.ZodError) return 400;
  return 500;
}

function problem(error: unknown): { readonly errorCode: string } {
  if (
    error instanceof PiDirectExecutorOperationConflictError ||
    error instanceof PiDirectExecutorOperationNotFoundError ||
    error instanceof DirectAgentExecutionError
  ) {
    return { errorCode: error.code };
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return { errorCode: "direct_executor.contract_invalid" };
  }
  return { errorCode: "direct_executor.internal_error" };
}

function stableExecutionError(error: unknown): string {
  if (error instanceof DirectAgentExecutionError) return error.code;
  return "direct_executor.session_failed";
}

function isCallbackOutcomeUnknown(error: unknown): error is { readonly outcomeUnknown: true } {
  return (
    typeof error === "object" &&
    error !== null &&
    "outcomeUnknown" in error &&
    error.outcomeUnknown === true
  );
}

export function createPiDirectExecutorService(options: PiDirectExecutorServiceOptions) {
  const app = new Hono();
  const runner = options.runner ?? new AgentSessionPiDirectAgentRunner();
  const promptReview = new DirectPromptReviewCoordinator(
    options.store,
    options.promptReviewProduct,
    options.checkpointsDir,
  );
  const active = new Map<string, AbortController>();
  const tasks = new Set<Promise<void>>();

  app.use("/internal/*", async (c, next) => {
    if (!authorized(c.req.header(PI_EXECUTOR_RUNTIME_HEADER), options.credential)) {
      return c.json({ errorCode: "runtime.unauthorized" }, 401);
    }
    await next();
  });

  app.post("/internal/pi-direct-executor/v1/operations", async (c) => {
    try {
      const request = startPiDirectExecutorOperationRequestSchema.parse(await c.req.json());
      if (request.operationId !== operationIdForDirectAgentAttempt(request.directAgentAttemptId)) {
        throw new PiDirectExecutorOperationConflictError(
          "Operation ID没有绑定唯一Direct Agent Attempt",
        );
      }
      const existing = options.store.getExistingSnapshotForRequest(request);
      if (existing !== undefined) return c.json(existing, 200);
      const authorizedInput = await loadAuthorizedInput(request);
      const created = await options.store.createOrGet(request, profileFrom(authorizedInput));
      if (created.created) startTask(request.operationId, false);
      return c.json(created.snapshot, created.created ? 202 : 200);
    } catch (error) {
      return c.json(problem(error), statusForError(error));
    }
  });

  app.get("/internal/pi-direct-executor/v1/operations/:operationId", (c) => {
    try {
      const operationId = piOperationIdSchema.parse(c.req.param("operationId"));
      return c.json(
        piDirectExecutorOperationSnapshotSchema.parse(options.store.getSnapshot(operationId)),
      );
    } catch (error) {
      return c.json(problem(error), statusForError(error));
    }
  });

  app.get("/internal/pi-direct-executor/v1/operations/:operationId/events", (c) => {
    try {
      const operationId = piOperationIdSchema.parse(c.req.param("operationId"));
      const rawAfter = c.req.query("afterSequence") ?? "0";
      if (!/^\d+$/u.test(rawAfter)) throw new SyntaxError("afterSequence非法");
      const afterSequence = Number.parseInt(rawAfter, 10);
      const events = options.store.getEvents(operationId, afterSequence);
      return c.json(
        piDirectExecutorEventsResponseSchema.parse({
          schemaVersion: PI_DIRECT_EXECUTOR_PROTOCOL_VERSION,
          operationId,
          events,
          lastEventSequence: options.store.getSnapshot(operationId).lastEventSequence,
        }),
      );
    } catch (error) {
      return c.json(problem(error), statusForError(error));
    }
  });

  app.post(
    "/internal/pi-direct-executor/v1/operations/:operationId/prompt-review-decisions",
    async (c) => {
      try {
        const operationId = piOperationIdSchema.parse(c.req.param("operationId"));
        const request = submitDirectPromptReviewDecisionRequestSchema.parse(await c.req.json());
        const activeReview = options.store.getActivePromptReview(operationId)?.review;
        if (
          activeReview === undefined ||
          activeReview.promptReviewRequestId !== request.promptReviewRequestId ||
          activeReview.requestRevision !== request.requestRevision ||
          activeReview.reviewSha256 !== request.reviewSha256 ||
          activeReview.payloadSha256 !== request.payloadSha256
        ) {
          throw new PiDirectExecutorOperationConflictError("Decision绑定了旧Prompt Review");
        }
        try {
          await promptReview.loadAndSubmitDecision({
            operationId,
            promptReviewRequestId: request.promptReviewRequestId,
            requestRevision: request.requestRevision,
            reviewSha256: request.reviewSha256,
            payloadSha256: request.payloadSha256,
            promptReviewDecisionId: request.promptReviewDecisionId,
          });
        } catch (error) {
          if (!isCallbackOutcomeUnknown(error)) throw error;
          await promptReview.markProviderOutcomeUnknown(
            operationId,
            "direct_executor.provider_permit_outcome_unknown",
          );
          return c.json(options.store.getSnapshot(operationId), 202);
        }
        const snapshot = options.store.getSnapshot(operationId);
        if (snapshot.decision?.kind === "approve" && !active.has(operationId)) {
          startTask(operationId, true);
        }
        return c.json(options.store.getSnapshot(operationId), 202);
      } catch (error) {
        return c.json(problem(error), statusForError(error));
      }
    },
  );

  async function loadAuthorizedInput(
    request: StartPiDirectExecutorOperationRequest,
  ): Promise<AuthorizedDirectAgentInput> {
    let authorizedInput: AuthorizedDirectAgentInput;
    try {
      authorizedInput = await options.authorizeOperation(request);
    } catch {
      throw new DirectAgentExecutionError("direct_executor.authorization_failed");
    }
    if (
      authorizedInput.productRunId !== request.productRunId ||
      authorizedInput.directAgentAttemptId !== request.directAgentAttemptId
    ) {
      throw new DirectAgentExecutionError("direct_executor.authorization_mismatch");
    }
    return authorizedInput;
  }

  function profileFrom(input: AuthorizedDirectAgentInput): AuthorizedDirectAgentProfile {
    return authorizedDirectAgentProfileSchema.parse({
      runRevision: input.runRevision,
      sourceMessageId: input.sourceMessage.messageId,
      sourceMessageSha256: input.sourceMessage.sha256,
      capabilityMode: input.capabilityMode,
      limits: input.limits,
    });
  }

  function startTask(operationId: string, resume: boolean): void {
    if (active.has(operationId)) return;
    const task = launch(operationId, resume);
    tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch(() => undefined);
  }

  async function launch(operationId: string, resume: boolean): Promise<void> {
    if (active.has(operationId)) return;
    const controller = new AbortController();
    active.set(operationId, controller);
    const request = options.store.getRequest(operationId);
    const profile = options.store.getProfile(operationId);
    const timeout = new PausableOperationTimeout(profile.limits.activeTimeoutMs, () => {
      controller.abort(new Error("direct agent active timeout"));
    });
    try {
      if (!resume) await options.store.markRunning(operationId);
      const authorizedInput = await loadAuthorizedInput(request);
      let prompt = "";
      let history: DirectAgentRunInput["history"] = [];
      const tools =
        authorizedInput.promptAssembly.schemaVersion === "prompt-assembly.v2"
          ? authorizedInput.promptAssembly.tools
          : {
              capabilityMode: "read_only" as const,
              names: [...P1_DIRECT_AGENT_PROFILE.enabledTools],
              estimatedTokens: 8_000 as const,
            };
      const requestOptions =
        authorizedInput.promptAssembly.schemaVersion === "prompt-assembly.v2"
          ? authorizedInput.promptAssembly.requestOptions
          : {
              providerId: P1_DIRECT_AGENT_PROFILE.providerId,
              modelId: P1_DIRECT_AGENT_PROFILE.modelId,
              thinkingLevel: P1_DIRECT_AGENT_PROFILE.thinkingLevel,
              retryEnabled: P1_DIRECT_AGENT_PROFILE.retryEnabled,
              compactionEnabled: P1_DIRECT_AGENT_PROFILE.compactionEnabled,
            };
      if (!resume) {
        const currentProfile = profileFrom(authorizedInput);
        if (
          authorizedInput.runRevision !== options.store.getProductRunRevision(operationId) ||
          JSON.stringify({ ...currentProfile, runRevision: profile.runRevision }) !==
            JSON.stringify(profile)
        ) {
          throw new DirectAgentExecutionError("direct_executor.authorization_mismatch");
        }
        if (authorizedInput.promptAssembly.schemaVersion === "prompt-assembly.v1") {
          prompt = authorizedInput.promptAssembly.userPrompt;
        } else {
          const current = authorizedInput.promptAssembly.messages.at(-1);
          if (current?.role !== "user" || current.source["kind"] !== "current_input") {
            throw new DirectAgentExecutionError("direct_executor.prompt_envelope_invalid");
          }
          prompt = current.text;
          history = authorizedInput.promptAssembly.messages.slice(0, -1).map((message) => ({
            role: message.role,
            text: message.text,
          }));
        }
      }
      const configuredRoot =
        authorizedInput.promptAssembly.workspaceRootId === undefined
          ? undefined
          : options.workspaceRoots.get(authorizedInput.promptAssembly.workspaceRootId);
      if (
        authorizedInput.promptAssembly.workspaceRootId !== undefined &&
        configuredRoot === undefined
      ) {
        throw new DirectAgentExecutionError("direct_executor.workspace_root_not_allowed");
      }
      const cwd = configuredRoot?.canonicalPath ?? resolve(options.emptyWorkspaceRoot, operationId);
      const output = await runner.run({
        request,
        prompt,
        history,
        systemPromptAppend: authorizedInput.promptAssembly.systemPromptAppend,
        tools,
        requestOptions,
        cwd,
        agentDir: options.agentDir,
        sessionsDir: options.sessionsDir,
        store: options.store,
        promptReview,
        signal: controller.signal,
        resume,
        pauseExecutionTimeout: timeout.pause,
        resumeExecutionTimeout: timeout.resume,
      });
      let publishedResult: DirectAgentResultRef;
      try {
        publishedResult = await options.publishResult({
          commandId: `cmd_${hashExecutorValue({ kind: "publish-direct-result", operationId }).slice(0, 40)}`,
          productRunId: request.productRunId,
          directAgentAttemptId: request.directAgentAttemptId,
          output: { format: "markdown", text: output },
        });
      } catch (error) {
        if (!isCallbackOutcomeUnknown(error)) throw error;
        await options.store.markOutcomeUnknown(
          operationId,
          "direct_executor.candidate_persist_outcome_unknown",
        );
        return;
      }
      const result = directAgentResultRefSchema.parse(publishedResult);
      await options.store.complete(operationId, result);
    } catch (error) {
      const snapshot = options.store.getSnapshot(operationId);
      if (snapshot.status === "waiting_prompt_review" && snapshot.decision?.kind === "approve") {
        await promptReview.markProviderOutcomeUnknown(
          operationId,
          "direct_executor.provider_permit_outcome_unknown",
        );
        return;
      }
      if (
        error instanceof DirectAgentSuspendedError ||
        error instanceof PromptReviewRejectedError ||
        snapshot.status === "preparing_prompt_review" ||
        snapshot.status === "waiting_prompt_review" ||
        snapshot.status === "cancelled" ||
        snapshot.status === "outcome_unknown"
      ) {
        return;
      }
      if (snapshot.status === "dispatching") {
        if (options.store.hasProviderCompletion(operationId)) {
          await promptReview.reconcileCompletedProvider(operationId).catch(() => undefined);
          await options.store.markOutcomeUnknown(
            operationId,
            "direct_executor.session_continuation_outcome_unknown",
          );
          return;
        }
        await promptReview.markProviderOutcomeUnknown(
          operationId,
          "direct_executor.provider_outcome_unknown",
        );
        return;
      }
      await options.store.fail(
        operationId,
        controller.signal.aborted ? "direct_executor.timeout" : stableExecutionError(error),
      );
    } finally {
      timeout.dispose();
      active.delete(operationId);
    }
  }

  const recover = async (): Promise<void> => {
    for (const operationId of options.store.getOperationIds()) {
      const snapshot = options.store.getSnapshot(operationId);
      if (snapshot.status === "waiting_prompt_review" && snapshot.decision?.kind === "approve") {
        await promptReview.markProviderOutcomeUnknown(
          operationId,
          "direct_executor.provider_permit_outcome_unknown",
        );
        continue;
      }
      if (
        snapshot.status === "outcome_unknown" &&
        options.store.hasProviderCompletion(operationId)
      ) {
        await promptReview.reconcileCompletedProvider(operationId);
        continue;
      }
      if (
        snapshot.status === "outcome_unknown" &&
        snapshot.activeReview !== undefined &&
        [
          "direct_executor.provider_outcome_unknown",
          "direct_executor.provider_permit_outcome_unknown",
          "direct_executor.provider_permit_already_claimed",
        ].includes(snapshot.errorCode ?? "")
      ) {
        await promptReview.markProviderOutcomeUnknown(operationId, snapshot.errorCode!);
      }
    }
    for (const operationId of options.store.getRecoverableOperationIds()) {
      startTask(operationId, true);
    }
  };

  const close = async (): Promise<void> => {
    for (const controller of active.values()) controller.abort(new Error("service shutdown"));
    await Promise.allSettled([...tasks]);
  };

  return { app, recover, close };
}
