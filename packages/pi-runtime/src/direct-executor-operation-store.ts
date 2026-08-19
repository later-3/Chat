import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DIRECT_AGENT_MAX_PROVIDER_REQUESTS } from "@chat/contracts";
import { z } from "zod";
import { hashExecutorValue } from "./executor-operation-store.js";
import {
  PI_DIRECT_EXECUTOR_PROTOCOL_VERSION,
  authorizedDirectAgentProfileSchema,
  directAgentResultRefSchema,
  directPromptReviewCheckpointSchema,
  directPromptReviewDecisionRefSchema,
  directPromptReviewRefSchema,
  piDirectExecutorEventSchema,
  piDirectExecutorOperationSnapshotSchema,
  piDirectExecutorOperationStatusSchema,
  startPiDirectExecutorOperationRequestSchema,
  type DirectAgentResultRef,
  type AuthorizedDirectAgentProfile,
  type DirectPromptReviewCheckpoint,
  type DirectPromptReviewDecisionRef,
  type DirectPromptReviewRef,
  type PiDirectExecutorEvent,
  type PiDirectExecutorOperationSnapshot,
  type StartPiDirectExecutorOperationRequest,
} from "./direct-executor-service-contract.js";
import {
  piOperationIdSchema,
  piRuntimeSessionIdSchema,
  piToolNameSchema,
} from "./executor-service-contract.js";

const STORE_SCHEMA_VERSION = "pi-direct-executor-operation-store.v1";
const stableErrorCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/u)
  .max(80);

const activePromptReviewSchema = z
  .object({
    requestIndex: z.number().int().positive().max(DIRECT_AGENT_MAX_PROVIDER_REQUESTS),
    publishCommandId: z.string().regex(/^cmd_[A-Za-z0-9]+$/u),
    payloadSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    payloadEnvelopeSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    providerId: z.string().min(1).max(100),
    modelId: z.string().min(1).max(200),
    endpointHost: z.string().min(1).max(253),
    checkpoint: directPromptReviewCheckpointSchema,
    review: directPromptReviewRefSchema.optional(),
    decision: directPromptReviewDecisionRefSchema.optional(),
    permitConsumedAt: z.iso.datetime().optional(),
    providerCompletion: z
      .object({
        completionTokens: z.number().int().nonnegative().max(100_000_000),
        stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted", "deferred"]),
      })
      .strict()
      .optional(),
  })
  .strict();

export type DirectActivePromptReview = z.infer<typeof activePromptReviewSchema>;

const operationRecordSchema = z
  .object({
    schemaVersion: z.literal(STORE_SCHEMA_VERSION),
    operationId: piOperationIdSchema,
    requestSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    request: startPiDirectExecutorOperationRequestSchema,
    profile: authorizedDirectAgentProfileSchema,
    productRunRevision: z.number().int().positive(),
    status: piDirectExecutorOperationStatusSchema,
    sessionId: piRuntimeSessionIdSchema.optional(),
    activePromptReview: activePromptReviewSchema.optional(),
    providerRequestCount: z.number().int().nonnegative().max(DIRECT_AGENT_MAX_PROVIDER_REQUESTS),
    completionTokens: z.number().int().nonnegative().max(100_000_000),
    events: z.array(piDirectExecutorEventSchema).max(100_000),
    result: directAgentResultRefSchema.optional(),
    errorCode: stableErrorCodeSchema.optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

type OperationRecord = z.infer<typeof operationRecordSchema>;
export type PiDirectExecutorEventPayload = PiDirectExecutorEvent extends infer Event
  ? Event extends PiDirectExecutorEvent
    ? Omit<Event, "sequence" | "timestamp">
    : never
  : never;

export class PiDirectExecutorOperationConflictError extends Error {
  readonly code = "direct_executor.operation_conflict";

  constructor(message = "Direct Agent Operation状态或幂等身份冲突") {
    super(message);
    this.name = "PiDirectExecutorOperationConflictError";
  }
}

export class PiDirectExecutorOperationNotFoundError extends Error {
  readonly code = "direct_executor.operation_not_found";

  constructor() {
    super("Direct Agent Operation不存在");
    this.name = "PiDirectExecutorOperationNotFoundError";
  }
}

/**
 * Direct Operation正文外置：此Store只持久化引用、Hash、预算、一次性permit和安全事件。
 * preparing/waiting没有越过Provider边界，可跨进程恢复；dispatching无法证明是否已fetch，
 * 打开Store时必须保守收敛为outcome_unknown。
 */
export class PiDirectExecutorOperationStore {
  private readonly records = new Map<string, OperationRecord>();
  private readonly mutationTails = new Map<string, Promise<void>>();

  private constructor(
    private readonly directory: string,
    private readonly now: () => Date,
  ) {}

  static async open(
    directory: string,
    options: { readonly now?: () => Date } = {},
  ): Promise<PiDirectExecutorOperationStore> {
    const store = new PiDirectExecutorOperationStore(directory, options.now ?? (() => new Date()));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const raw = await readFile(join(directory, entry.name), "utf8");
      const record = operationRecordSchema.parse(JSON.parse(raw));
      if (`${record.operationId}.json` !== entry.name) {
        throw new Error("Direct Agent Operation文件名与内容身份不一致");
      }
      store.records.set(record.operationId, record);
    }
    await store.reconcileInterruptedOperations();
    return store;
  }

  async createOrGet(
    rawRequest: StartPiDirectExecutorOperationRequest,
    rawProfile?: AuthorizedDirectAgentProfile,
  ): Promise<{ readonly snapshot: PiDirectExecutorOperationSnapshot; readonly created: boolean }> {
    const request = startPiDirectExecutorOperationRequestSchema.parse(rawRequest);
    const requestSha256 = hashExecutorValue(request);
    return this.mutate<{
      readonly snapshot: PiDirectExecutorOperationSnapshot;
      readonly created: boolean;
    }>(request.operationId, async (existing) => {
      if (existing !== undefined) {
        if (existing.requestSha256 !== requestSha256) {
          throw new PiDirectExecutorOperationConflictError("Operation ID已绑定不同请求");
        }
        return {
          record: existing,
          value: { snapshot: this.snapshot(existing), created: false as boolean },
        };
      }
      const profile = authorizedDirectAgentProfileSchema.parse(rawProfile);
      const timestamp = this.now().toISOString();
      const record = operationRecordSchema.parse({
        schemaVersion: STORE_SCHEMA_VERSION,
        operationId: request.operationId,
        requestSha256,
        request,
        profile,
        productRunRevision: profile.runRevision,
        status: "queued",
        providerRequestCount: 0,
        completionTokens: 0,
        events: [
          piDirectExecutorEventSchema.parse({
            sequence: 1,
            timestamp,
            operationId: request.operationId,
            type: "operation.accepted",
            requestSha256,
          }),
        ],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return {
        record,
        value: { snapshot: this.snapshot(record), created: true as boolean },
      };
    });
  }

  getRequest(operationId: string): StartPiDirectExecutorOperationRequest {
    return structuredClone(this.requireRecord(operationId).request);
  }

  getExistingSnapshotForRequest(
    rawRequest: StartPiDirectExecutorOperationRequest,
  ): PiDirectExecutorOperationSnapshot | undefined {
    const request = startPiDirectExecutorOperationRequestSchema.parse(rawRequest);
    const existing = this.records.get(request.operationId);
    if (existing === undefined) return undefined;
    if (existing.requestSha256 !== hashExecutorValue(request)) {
      throw new PiDirectExecutorOperationConflictError("Operation ID已绑定不同请求");
    }
    return this.snapshot(existing);
  }

  getOperationIds(): readonly string[] {
    return [...this.records.keys()].sort();
  }

  getProfile(operationId: string): AuthorizedDirectAgentProfile {
    return structuredClone(this.requireRecord(operationId).profile);
  }

  getProductRunRevision(operationId: string): number {
    return this.requireRecord(operationId).productRunRevision;
  }

  getSnapshot(operationId: string): PiDirectExecutorOperationSnapshot {
    return this.snapshot(this.requireRecord(operationId));
  }

  getEvents(operationId: string, afterSequence = 0): readonly PiDirectExecutorEvent[] {
    return structuredClone(
      this.requireRecord(operationId).events.filter((event) => event.sequence > afterSequence),
    );
  }

  getRecoverableOperationIds(): readonly string[] {
    return [...this.records.values()]
      .filter((record) => record.status === "preparing_prompt_review")
      .map((record) => record.operationId);
  }

  getActivePromptReview(operationId: string): DirectActivePromptReview | undefined {
    const review = this.requireRecord(operationId).activePromptReview;
    return review === undefined ? undefined : structuredClone(review);
  }

  hasProviderCompletion(operationId: string): boolean {
    return this.requireRecord(operationId).activePromptReview?.providerCompletion !== undefined;
  }

  getNextPromptReviewIndex(operationId: string): number {
    const record = this.requireRecord(operationId);
    if (record.status === "preparing_prompt_review") {
      return this.requireActiveReview(record).requestIndex;
    }
    if (record.status !== "running") {
      throw new PiDirectExecutorOperationConflictError("当前状态不能计算下一次Prompt Review");
    }
    return record.providerRequestCount + 1;
  }

  async markRunning(operationId: string): Promise<void> {
    await this.mutate(operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      if (current.status === "running") return { record: current, value: undefined };
      if (current.status !== "queued") {
        throw new PiDirectExecutorOperationConflictError("只有queued Operation可以开始");
      }
      const next = this.appendToRecord(current, {
        operationId,
        type: "operation.started",
        requestSha256: current.requestSha256,
      });
      return { record: { ...next, status: "running" }, value: undefined };
    });
  }

  async setSession(input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly enabledTools: readonly string[];
    readonly resumedFromCheckpointSha256?: string;
  }): Promise<void> {
    await this.mutate(input.operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      if (
        current.status !== "running" &&
        current.status !== "preparing_prompt_review" &&
        current.status !== "waiting_prompt_review"
      ) {
        throw new PiDirectExecutorOperationConflictError("当前状态不能绑定Pi Session");
      }
      const sessionId = piRuntimeSessionIdSchema.parse(input.sessionId);
      const next = this.appendToRecord(
        current,
        input.resumedFromCheckpointSha256 === undefined
          ? {
              operationId: input.operationId,
              type: "session.started",
              sessionId,
              enabledTools: input.enabledTools as never,
            }
          : {
              operationId: input.operationId,
              type: "session.resumed",
              sessionId,
              checkpointSha256: input.resumedFromCheckpointSha256,
            },
      );
      return { record: { ...next, sessionId }, value: undefined };
    });
  }

  async beginPromptReview(input: {
    readonly operationId: string;
    readonly publishCommandId: string;
    readonly payloadSha256: string;
    readonly payloadEnvelopeSha256: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly endpointHost: string;
    readonly checkpoint: DirectPromptReviewCheckpoint;
  }): Promise<DirectActivePromptReview> {
    return this.mutate(input.operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      if (current.status === "preparing_prompt_review") {
        const existing = current.activePromptReview;
        if (
          existing === undefined ||
          existing.payloadSha256 !== input.payloadSha256 ||
          existing.payloadEnvelopeSha256 !== input.payloadEnvelopeSha256 ||
          existing.publishCommandId !== input.publishCommandId
        ) {
          throw new PiDirectExecutorOperationConflictError("恢复时Provider Payload发生漂移");
        }
        return { record: current, value: structuredClone(existing) };
      }
      if (current.status !== "running") {
        throw new PiDirectExecutorOperationConflictError("当前状态不能创建Prompt Review");
      }
      this.assertNoOpenToolIntentsInRecord(current);
      if (current.providerRequestCount >= current.profile.limits.maxProviderRequests) {
        throw new PiDirectExecutorOperationConflictError("Direct Agent已达到最大Provider请求数");
      }
      if (current.completionTokens >= current.profile.limits.tokenBudget) {
        throw new PiDirectExecutorOperationConflictError("Direct Agent已达到Completion Token预算");
      }
      const activePromptReview = activePromptReviewSchema.parse({
        requestIndex: current.providerRequestCount + 1,
        publishCommandId: input.publishCommandId,
        payloadSha256: input.payloadSha256,
        payloadEnvelopeSha256: input.payloadEnvelopeSha256,
        providerId: input.providerId,
        modelId: input.modelId,
        endpointHost: input.endpointHost,
        checkpoint: input.checkpoint,
      });
      const next = this.appendToRecord(current, {
        operationId: input.operationId,
        type: "prompt_review.preparing",
        requestIndex: activePromptReview.requestIndex,
        payloadSha256: activePromptReview.payloadSha256,
        payloadEnvelopeSha256: activePromptReview.payloadEnvelopeSha256,
        checkpointSha256: activePromptReview.checkpoint.fileSha256,
      });
      return {
        record: { ...next, status: "preparing_prompt_review", activePromptReview },
        value: structuredClone(activePromptReview),
      };
    });
  }

  async markPromptReviewWaiting(
    operationId: string,
    review: DirectPromptReviewRef,
    productRunRevision: number,
  ): Promise<void> {
    await this.mutate(operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      const active = this.requireActiveReview(current);
      const parsed = directPromptReviewRefSchema.parse(review);
      if (
        active.requestIndex !== parsed.requestIndex ||
        active.payloadSha256 !== parsed.payloadSha256
      ) {
        throw new PiDirectExecutorOperationConflictError("Product Review与准备中的Payload不一致");
      }
      if (current.status === "waiting_prompt_review" && active.review !== undefined) {
        if (
          JSON.stringify(active.review) !== JSON.stringify(parsed) ||
          current.productRunRevision !== productRunRevision
        ) {
          throw new PiDirectExecutorOperationConflictError("Prompt Review引用发生冲突");
        }
        return { record: current, value: undefined };
      }
      if (current.status !== "preparing_prompt_review") {
        throw new PiDirectExecutorOperationConflictError("当前状态不能进入Prompt Review等待");
      }
      if (productRunRevision <= current.productRunRevision) {
        throw new PiDirectExecutorOperationConflictError(
          "Prompt Review没有推进Product Run revision",
        );
      }
      const next = this.appendToRecord(current, {
        operationId,
        type: "prompt_review.waiting",
        review: parsed,
      });
      return {
        record: {
          ...next,
          status: "waiting_prompt_review",
          productRunRevision,
          activePromptReview: { ...active, review: parsed },
        },
        value: undefined,
      };
    });
  }

  async bindPromptReviewDecision(
    operationId: string,
    decision: DirectPromptReviewDecisionRef,
    productRunRevision: number,
  ): Promise<PiDirectExecutorOperationSnapshot> {
    return this.mutate(operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      const active = this.requireActiveReview(current);
      if (current.status !== "waiting_prompt_review" || active.review === undefined) {
        if (
          active.decision !== undefined &&
          JSON.stringify(active.decision) === JSON.stringify(decision) &&
          current.productRunRevision === productRunRevision
        ) {
          return { record: current, value: this.snapshot(current) };
        }
        throw new PiDirectExecutorOperationConflictError(
          "Operation当前不在对应Prompt Review等待态",
        );
      }
      const parsed = directPromptReviewDecisionRefSchema.parse(decision);
      if (active.decision !== undefined) {
        if (JSON.stringify(active.decision) !== JSON.stringify(parsed)) {
          throw new PiDirectExecutorOperationConflictError("Prompt Review已绑定不同Decision");
        }
        return { record: current, value: this.snapshot(current) };
      }
      if (productRunRevision < current.productRunRevision) {
        throw new PiDirectExecutorOperationConflictError(
          "Prompt Review Decision的Run revision发生回退",
        );
      }
      let next = this.appendToRecord(current, {
        operationId,
        type: "prompt_review.decided",
        review: active.review,
        decision: parsed,
      });
      if (parsed.kind === "reject") {
        next = this.appendToRecord(next, {
          operationId,
          type: "operation.cancelled",
          errorCode: "prompt_review.rejected",
        });
        const cancelled = operationRecordSchema.parse({
          ...next,
          status: "cancelled",
          productRunRevision,
          activePromptReview: { ...active, decision: parsed },
          errorCode: "prompt_review.rejected",
        });
        return { record: cancelled, value: this.snapshot(cancelled) };
      }
      const decided = operationRecordSchema.parse({
        ...next,
        productRunRevision,
        activePromptReview: { ...active, decision: parsed },
      });
      return { record: decided, value: this.snapshot(decided) };
    });
  }

  async markProviderDispatching(operationId: string): Promise<void> {
    await this.mutate(operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      const active = this.requireActiveReview(current);
      if (
        current.status !== "waiting_prompt_review" ||
        active.review === undefined ||
        active.decision?.kind !== "approve" ||
        active.permitConsumedAt !== undefined
      ) {
        throw new PiDirectExecutorOperationConflictError("Prompt Review没有可消费的批准permit");
      }
      const permitConsumedAt = this.now().toISOString();
      const next = this.appendToRecord(current, {
        operationId,
        type: "provider.started",
        requestIndex: active.requestIndex,
        payloadSha256: active.payloadSha256,
        endpointHost: active.endpointHost,
      });
      return {
        record: {
          ...next,
          status: "dispatching",
          providerRequestCount: current.providerRequestCount + 1,
          activePromptReview: { ...active, permitConsumedAt },
        },
        value: undefined,
      };
    });
  }

  async recordProviderCompleted(input: {
    readonly operationId: string;
    readonly completionTokens: number;
    readonly stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
  }): Promise<void> {
    await this.mutate(input.operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      if (current.status !== "dispatching") {
        throw new PiDirectExecutorOperationConflictError("只有dispatching Provider能闭合");
      }
      const active = this.requireActiveReview(current);
      const providerCompletion = {
        completionTokens: input.completionTokens,
        stopReason: input.stopReason,
      };
      if (active.providerCompletion !== undefined) {
        if (JSON.stringify(active.providerCompletion) !== JSON.stringify(providerCompletion)) {
          throw new PiDirectExecutorOperationConflictError("Provider完成证据发生冲突");
        }
        return { record: current, value: undefined };
      }
      const next = this.appendToRecord(current, {
        operationId: input.operationId,
        type: "provider.completed",
        requestIndex: active.requestIndex,
        payloadSha256: active.payloadSha256,
        completionTokens: input.completionTokens,
        stopReason: input.stopReason,
      });
      return {
        record: {
          ...next,
          activePromptReview: { ...active, providerCompletion },
        },
        value: undefined,
      };
    });
  }

  async finalizeProviderSettled(operationId: string): Promise<void> {
    await this.mutate(operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      if (current.status !== "dispatching") {
        throw new PiDirectExecutorOperationConflictError("只有dispatching Provider能完成结算");
      }
      const active = this.requireActiveReview(current);
      if (active.providerCompletion === undefined) {
        throw new PiDirectExecutorOperationConflictError("Provider完成结算缺少持久证据");
      }
      return {
        record: operationRecordSchema.parse({
          ...current,
          status: "running",
          activePromptReview: undefined,
          completionTokens: current.completionTokens + active.providerCompletion.completionTokens,
        }),
        value: undefined,
      };
    });
  }

  async appendToolIntent(input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly inputSha256: string;
  }): Promise<void> {
    await this.mutate(input.operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      if (current.status !== "running") {
        throw new PiDirectExecutorOperationConflictError("只有running Operation能执行Tool");
      }
      if (
        current.events.some(
          (event) =>
            event.type === "tool.intent_persisted" && event.toolCallId === input.toolCallId,
        )
      ) {
        throw new PiDirectExecutorOperationConflictError("Provider重复使用Tool Call ID");
      }
      const next = this.appendToRecord(current, {
        operationId: input.operationId,
        type: "tool.intent_persisted",
        sessionId: piRuntimeSessionIdSchema.parse(input.sessionId),
        toolCallId: input.toolCallId,
        toolName: piToolNameSchema.parse(input.toolName),
        inputSha256: input.inputSha256,
      });
      return { record: next, value: undefined };
    });
  }

  async closeToolIntent(input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly resultSha256: string;
    readonly failed: boolean;
  }): Promise<void> {
    await this.mutate(input.operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      const open = this.openToolIntents(current).find(
        (event) => event.toolCallId === input.toolCallId,
      );
      if (
        open === undefined ||
        open.toolName !== input.toolName ||
        open.sessionId !== input.sessionId
      ) {
        throw new PiDirectExecutorOperationConflictError("Tool Result缺少已持久化Intent");
      }
      const next = this.appendToRecord(current, {
        operationId: input.operationId,
        type: input.failed ? "tool.failed" : "tool.completed",
        sessionId: piRuntimeSessionIdSchema.parse(input.sessionId),
        toolCallId: input.toolCallId,
        toolName: piToolNameSchema.parse(input.toolName),
        resultSha256: input.resultSha256,
      });
      return { record: next, value: undefined };
    });
  }

  assertNoOpenSideEffects(operationId: string): void {
    const record = this.requireRecord(operationId);
    if (record.status === "dispatching") {
      throw new PiDirectExecutorOperationConflictError("Provider请求尚未闭合");
    }
    this.assertNoOpenToolIntentsInRecord(record);
  }

  async complete(operationId: string, result: DirectAgentResultRef): Promise<void> {
    await this.mutate(operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      if (current.status !== "running" || current.activePromptReview !== undefined) {
        throw new PiDirectExecutorOperationConflictError(
          "Operation仍有未闭合Prompt Review或Provider",
        );
      }
      this.assertNoOpenToolIntentsInRecord(current);
      const parsed = directAgentResultRefSchema.parse(result);
      const next = this.appendToRecord(current, {
        operationId,
        type: "operation.completed",
        result: parsed,
      });
      return {
        record: { ...next, status: "succeeded", result: parsed, errorCode: undefined },
        value: undefined,
      };
    });
  }

  async fail(operationId: string, errorCode: string): Promise<void> {
    await this.setTerminal(operationId, "failed", errorCode, "operation.failed");
  }

  async markOutcomeUnknown(operationId: string, errorCode: string): Promise<void> {
    await this.setTerminal(operationId, "outcome_unknown", errorCode, "operation.outcome_unknown");
  }

  private async reconcileInterruptedOperations(): Promise<void> {
    for (const record of [...this.records.values()]) {
      if (
        record.status === "preparing_prompt_review" ||
        record.status === "waiting_prompt_review" ||
        record.status === "succeeded" ||
        record.status === "cancelled" ||
        record.status === "failed" ||
        record.status === "outcome_unknown"
      ) {
        continue;
      }
      if (record.status === "dispatching") {
        await this.markOutcomeUnknown(
          record.operationId,
          record.activePromptReview?.providerCompletion === undefined
            ? "direct_executor.provider_outcome_unknown"
            : "direct_executor.session_continuation_outcome_unknown",
        );
        continue;
      }
      const openTools = this.openToolIntents(record);
      if (openTools.length > 0) {
        await this.mutate(record.operationId, async (loaded) => {
          let current = this.requireMutableRecord(loaded);
          for (const tool of this.openToolIntents(current)) {
            current = this.appendToRecord(current, {
              operationId: current.operationId,
              type: "tool.outcome_unknown",
              sessionId: tool.sessionId,
              toolCallId: tool.toolCallId,
              toolName: tool.toolName,
            });
          }
          current = this.appendToRecord(current, {
            operationId: current.operationId,
            type: "operation.outcome_unknown",
            errorCode: "direct_executor.tool_outcome_unknown",
          });
          return {
            record: {
              ...current,
              status: "outcome_unknown",
              errorCode: "direct_executor.tool_outcome_unknown",
            },
            value: undefined,
          };
        });
        continue;
      }
      await this.markOutcomeUnknown(record.operationId, "direct_executor.operation_interrupted");
    }
  }

  private async setTerminal(
    operationId: string,
    status: "failed" | "outcome_unknown",
    rawErrorCode: string,
    eventType: "operation.failed" | "operation.outcome_unknown",
  ): Promise<void> {
    await this.mutate(operationId, async (loaded) => {
      const current = this.requireMutableRecord(loaded);
      if (["succeeded", "cancelled", "failed", "outcome_unknown"].includes(current.status)) {
        return { record: current, value: undefined };
      }
      const errorCode = stableErrorCodeSchema.parse(rawErrorCode);
      const next = this.appendToRecord(current, {
        operationId,
        type: eventType,
        errorCode,
      });
      return { record: { ...next, status, errorCode }, value: undefined };
    });
  }

  private openToolIntents(
    record: OperationRecord,
  ): Array<Extract<PiDirectExecutorEvent, { type: "tool.intent_persisted" }>> {
    const closed = new Set(
      record.events.flatMap((event) =>
        event.type === "tool.completed" ||
        event.type === "tool.failed" ||
        event.type === "tool.outcome_unknown"
          ? [event.toolCallId]
          : [],
      ),
    );
    return record.events.filter(
      (event): event is Extract<PiDirectExecutorEvent, { type: "tool.intent_persisted" }> =>
        event.type === "tool.intent_persisted" && !closed.has(event.toolCallId),
    );
  }

  private assertNoOpenToolIntentsInRecord(record: OperationRecord): void {
    if (this.openToolIntents(record).length > 0) {
      throw new PiDirectExecutorOperationConflictError(
        "存在未闭合Tool Intent，禁止下一次Provider请求",
      );
    }
  }

  private requireActiveReview(record: OperationRecord): DirectActivePromptReview {
    if (record.activePromptReview === undefined) {
      throw new PiDirectExecutorOperationConflictError("Operation缺少活动Prompt Review");
    }
    return record.activePromptReview;
  }

  private appendToRecord(
    record: OperationRecord,
    payload: PiDirectExecutorEventPayload,
  ): OperationRecord {
    const timestamp = this.now().toISOString();
    const event = piDirectExecutorEventSchema.parse({
      ...payload,
      sequence: record.events.length + 1,
      timestamp,
    });
    return operationRecordSchema.parse({
      ...record,
      events: [...record.events, event],
      updatedAt: timestamp,
    });
  }

  private snapshot(record: OperationRecord): PiDirectExecutorOperationSnapshot {
    return piDirectExecutorOperationSnapshotSchema.parse({
      schemaVersion: PI_DIRECT_EXECUTOR_PROTOCOL_VERSION,
      operationId: record.operationId,
      requestSha256: record.requestSha256,
      status: record.status,
      ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
      ...(record.activePromptReview?.review !== undefined
        ? { activeReview: record.activePromptReview.review }
        : {}),
      ...(record.activePromptReview?.decision !== undefined
        ? { decision: record.activePromptReview.decision }
        : {}),
      ...(record.result !== undefined ? { result: record.result } : {}),
      ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
      lastEventSequence: record.events.at(-1)?.sequence ?? 0,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  private requireRecord(operationId: string): OperationRecord {
    piOperationIdSchema.parse(operationId);
    const record = this.records.get(operationId);
    if (record === undefined) throw new PiDirectExecutorOperationNotFoundError();
    return record;
  }

  private requireMutableRecord(record: OperationRecord | undefined): OperationRecord {
    if (record === undefined) throw new PiDirectExecutorOperationNotFoundError();
    return record;
  }

  private async persist(record: OperationRecord): Promise<void> {
    const parsed = operationRecordSchema.parse(record);
    const target = join(this.directory, `${parsed.operationId}.json`);
    const temporary = join(this.directory, `.${parsed.operationId}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(parsed)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, target);
    this.records.set(parsed.operationId, parsed);
  }

  private async mutate<T>(
    operationId: string,
    mutation: (
      record: OperationRecord | undefined,
    ) => Promise<{ readonly record: OperationRecord; readonly value: T }>,
  ): Promise<T> {
    const previous = this.mutationTails.get(operationId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => tail);
    this.mutationTails.set(operationId, queued);
    await previous;
    try {
      const output = await mutation(this.records.get(operationId));
      await this.persist(output.record);
      return output.value;
    } finally {
      release();
      if (this.mutationTails.get(operationId) === queued) this.mutationTails.delete(operationId);
    }
  }
}
