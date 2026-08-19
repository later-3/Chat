import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  canonicalJsonStringify,
  hashCanonical,
  parseCanonicalPromptReviewPayload,
} from "@chat/domain";
import { z } from "zod";
import {
  directPromptReviewDecisionRefSchema,
  directPromptReviewRefSchema,
  type DirectPromptReviewCheckpoint,
  type DirectPromptReviewDecisionRef,
  type DirectPromptReviewRef,
} from "./direct-executor-service-contract.js";
import {
  PiDirectExecutorOperationConflictError,
  type PiDirectExecutorOperationStore,
} from "./direct-executor-operation-store.js";
import { hashExecutorValue } from "./executor-operation-store.js";

const MAX_PROVIDER_PAYLOAD_BYTES = 1024 * 1024;

export class PromptReviewRejectedError extends Error {
  readonly code = "prompt_review.rejected";

  constructor() {
    super("Prompt Review已拒绝");
    this.name = "PromptReviewRejectedError";
  }
}

export class PromptReviewWaitInterruptedError extends Error {
  readonly code = "prompt_review.wait_interrupted";

  constructor() {
    super("Prompt Review等待因Executor进程停止而中断");
    this.name = "PromptReviewWaitInterruptedError";
  }
}

export class PromptReviewPayloadDriftError extends Error {
  readonly code = "prompt_review.payload_drift";

  constructor() {
    super("恢复后的Provider Payload与已审核版本不一致");
    this.name = "PromptReviewPayloadDriftError";
  }
}

export interface PublishDirectPromptReviewInput {
  readonly commandId: string;
  readonly productRunId: string;
  readonly directAgentAttemptId: string;
  readonly expectedRunRevision: number;
  readonly requestIndex: number;
  readonly requestKind: "agent_turn";
  readonly providerId: string;
  readonly modelId: string;
  readonly endpointHost: string;
  readonly payload: z.infer<ReturnType<typeof z.json>>;
  readonly canonicalPayloadJson: string;
  readonly payloadSha256: string;
}

export interface PublishedDirectPromptReview {
  readonly review: DirectPromptReviewRef;
  readonly productRunRevision: number;
}

export type LoadedDirectPromptReviewDecision = {
  readonly review: DirectPromptReviewRef;
  readonly decision: DirectPromptReviewDecisionRef;
  readonly productRunRevision: number;
} & (
  | { readonly status: "authorized"; readonly frozenPayload: unknown }
  | { readonly status: "rejected" | "already_claimed" }
);

export interface CommitDirectPromptReviewDispatchOutcomeInput {
  readonly commandId: string;
  readonly productRunId: string;
  readonly directAgentAttemptId: string;
  readonly promptReviewRequestId: string;
  readonly outcome: "dispatched" | "outcome_unknown";
  readonly errorCode?: string;
}

export interface DirectPromptReviewProductPort {
  publish(input: PublishDirectPromptReviewInput): Promise<PublishedDirectPromptReview>;
  consumeDecision(input: {
    readonly commandId: string;
    readonly operationId: string;
    readonly productRunId: string;
    readonly directAgentAttemptId: string;
    readonly review: DirectPromptReviewRef;
    readonly providerId: string;
    readonly modelId: string;
    readonly endpointHost: string;
    readonly promptReviewDecisionId: string;
  }): Promise<LoadedDirectPromptReviewDecision>;
  commitDispatchOutcome(input: CommitDirectPromptReviewDispatchOutcomeInput): Promise<void>;
}

interface PendingWaiter {
  readonly resolve: () => void;
}

function isOutcomeUnknownCallback(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "outcomeUnknown" in error &&
    error.outcomeUnknown === true
  );
}

export interface PromptReviewGateInterceptInput {
  readonly operationId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly endpointHost: string;
  readonly payload: unknown;
  readonly session: AgentSession;
  readonly signal: AbortSignal;
  readonly pauseExecutionTimeout?: () => void;
  readonly resumeExecutionTimeout?: () => void;
}

/** JSON规范化定义了审核与实际发送之间的语义身份；Headers和API Key不进入正文。 */
export function normalizeFinalProviderPayload(
  payload: unknown,
): z.infer<ReturnType<typeof z.json>> {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new Error("Provider Payload不是JSON值");
  if (Buffer.byteLength(serialized, "utf8") > MAX_PROVIDER_PAYLOAD_BYTES) {
    throw new Error("Provider Payload超过Prompt Review上限");
  }
  const normalized = z.json().parse(JSON.parse(serialized));
  if (typeof normalized !== "object" || normalized === null || Array.isArray(normalized)) {
    throw new Error("Provider Payload必须是JSON对象");
  }
  // 与Product Store使用同一canonical/credential/hidden-reasoning校验，边界本地fail closed。
  return parseCanonicalPromptReviewPayload(canonicalJsonStringify(normalized)) as z.infer<
    ReturnType<typeof z.json>
  >;
}

export function hashFinalProviderPayload(payload: unknown): string {
  return hashCanonical(
    "reviewable-provider-request-payload.v1",
    normalizeFinalProviderPayload(payload),
  );
}

export function hashPromptReviewEnvelope(input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly endpointHost: string;
  readonly payload: unknown;
}): string {
  return hashCanonical("direct-prompt-review-payload-envelope.v1", {
    providerId: input.providerId,
    modelId: input.modelId,
    endpointHost: input.endpointHost,
    payload: normalizeFinalProviderPayload(input.payload),
  });
}

/**
 * Extension链外的不可绕过Gate。它先冻结Pi最终Payload和Session checkpoint，再发布
 * Product Review；批准permit在Operation Store落为dispatching后才返回冻结Payload。
 */
export class DirectPromptReviewCoordinator {
  private readonly waiters = new Map<string, PendingWaiter>();
  private readonly approvedPayloads = new Map<string, unknown>();

  constructor(
    private readonly store: PiDirectExecutorOperationStore,
    private readonly product: DirectPromptReviewProductPort,
    private readonly checkpointDirectory: string,
  ) {}

  async intercept(input: PromptReviewGateInterceptInput): Promise<unknown> {
    const payload = normalizeFinalProviderPayload(input.payload);
    const payloadSha256 = hashFinalProviderPayload(payload);
    const payloadEnvelopeSha256 = hashPromptReviewEnvelope({
      providerId: input.providerId,
      modelId: input.modelId,
      endpointHost: input.endpointHost,
      payload,
    });
    this.store.assertNoOpenSideEffects(input.operationId);

    let active = this.store.getActivePromptReview(input.operationId);
    if (active === undefined) {
      const requestIndex = this.store.getNextPromptReviewIndex(input.operationId);
      const checkpoint = await this.exportCheckpoint(
        input.operationId,
        requestIndex,
        input.session,
      );
      const publishCommandId = `cmd_${hashExecutorValue({
        kind: "publish-direct-prompt-review",
        operationId: input.operationId,
        requestIndex,
      }).slice(0, 40)}`;
      active = await this.store.beginPromptReview({
        operationId: input.operationId,
        publishCommandId,
        payloadSha256,
        payloadEnvelopeSha256,
        providerId: input.providerId,
        modelId: input.modelId,
        endpointHost: input.endpointHost,
        checkpoint,
      });
    } else if (
      active.payloadSha256 !== payloadSha256 ||
      active.payloadEnvelopeSha256 !== payloadEnvelopeSha256 ||
      active.providerId !== input.providerId ||
      active.modelId !== input.modelId ||
      active.endpointHost !== input.endpointHost
    ) {
      throw new PromptReviewPayloadDriftError();
    }

    if (active.review === undefined) {
      const request = this.store.getRequest(input.operationId);
      let published: PublishedDirectPromptReview;
      try {
        published = await this.product.publish({
          commandId: active.publishCommandId,
          productRunId: request.productRunId,
          directAgentAttemptId: request.directAgentAttemptId,
          expectedRunRevision: this.store.getProductRunRevision(input.operationId),
          requestIndex: active.requestIndex,
          requestKind: "agent_turn",
          providerId: active.providerId,
          modelId: active.modelId,
          endpointHost: active.endpointHost,
          payload,
          canonicalPayloadJson: canonicalJsonStringify(payload),
          payloadSha256,
        });
      } catch (error) {
        if (!isOutcomeUnknownCallback(error)) {
          await this.store.fail(input.operationId, "direct_executor.prompt_review_publish_failed");
        }
        throw error;
      }
      const review = directPromptReviewRefSchema.parse(published.review);
      await this.store.markPromptReviewWaiting(
        input.operationId,
        review,
        published.productRunRevision,
      );
      active = this.store.getActivePromptReview(input.operationId);
      if (active === undefined) throw new Error("Prompt Review等待态提交失败");
    }

    input.pauseExecutionTimeout?.();
    try {
      await this.waitForDecision(input.operationId, input.signal);
      const current = this.store.getActivePromptReview(input.operationId);
      if (current?.decision?.kind === "reject") throw new PromptReviewRejectedError();
      if (current?.decision?.kind !== "approve" || current.review === undefined) {
        throw new Error("Prompt Review批准事实缺失");
      }
      const approvedPayload = this.loadApprovedPayload(input.operationId);
      const approvedPayloadSha256 = hashFinalProviderPayload(approvedPayload);
      const approvedEnvelopeSha256 = hashPromptReviewEnvelope({
        providerId: current.providerId,
        modelId: current.modelId,
        endpointHost: current.endpointHost,
        payload: approvedPayload,
      });
      if (
        approvedPayloadSha256 !== current.payloadSha256 ||
        approvedEnvelopeSha256 !== current.payloadEnvelopeSha256
      ) {
        throw new PromptReviewPayloadDriftError();
      }
      await this.store.markProviderDispatching(input.operationId);
      input.resumeExecutionTimeout?.();
      return structuredClone(normalizeFinalProviderPayload(approvedPayload));
    } catch (error) {
      if (error instanceof PromptReviewRejectedError) throw error;
      if (input.signal.aborted) throw new PromptReviewWaitInterruptedError();
      throw error;
    }
  }

  async submitDecision(
    operationId: string,
    loaded: LoadedDirectPromptReviewDecision,
  ): Promise<void> {
    const review = directPromptReviewRefSchema.parse(loaded.review);
    const decision = directPromptReviewDecisionRefSchema.parse(loaded.decision);
    const active = this.store.getActivePromptReview(operationId);
    if (active?.review === undefined || JSON.stringify(active.review) !== JSON.stringify(review)) {
      throw new PiDirectExecutorOperationConflictError("Decision没有绑定当前Prompt Review");
    }
    if (loaded.status === "already_claimed") {
      if (decision.kind !== "approve") {
        throw new PiDirectExecutorOperationConflictError(
          "already_claimed只能对应已经消费的批准Decision",
        );
      }
      await this.store.bindPromptReviewDecision(operationId, decision, loaded.productRunRevision);
      await this.markProviderOutcomeUnknown(
        operationId,
        "direct_executor.provider_permit_already_claimed",
      );
      return;
    }
    if (decision.kind === "approve") {
      if (loaded.status !== "authorized") {
        throw new PiDirectExecutorOperationConflictError("批准Decision缺少冻结Provider Payload");
      }
      const frozen = normalizeFinalProviderPayload(loaded.frozenPayload);
      if (
        hashFinalProviderPayload(frozen) !== review.payloadSha256 ||
        hashPromptReviewEnvelope({
          providerId: active.providerId,
          modelId: active.modelId,
          endpointHost: active.endpointHost,
          payload: frozen,
        }) !== active.payloadEnvelopeSha256
      ) {
        throw new PromptReviewPayloadDriftError();
      }
      this.approvedPayloads.set(operationId, frozen);
    } else if (loaded.status !== "rejected") {
      throw new PiDirectExecutorOperationConflictError("拒绝Decision返回了错误消费状态");
    }
    await this.store.bindPromptReviewDecision(operationId, decision, loaded.productRunRevision);
    this.waiters.get(operationId)?.resolve();
    this.waiters.delete(operationId);
  }

  async loadAndSubmitDecision(input: {
    readonly operationId: string;
    readonly promptReviewRequestId: string;
    readonly requestRevision: number;
    readonly reviewSha256: string;
    readonly payloadSha256: string;
    readonly promptReviewDecisionId: string;
  }): Promise<void> {
    const active = this.store.getActivePromptReview(input.operationId);
    if (
      active?.decision?.promptReviewDecisionId === input.promptReviewDecisionId &&
      (active.decision.kind === "reject" || this.approvedPayloads.has(input.operationId))
    ) {
      return;
    }
    const request = this.store.getRequest(input.operationId);
    if (active?.review === undefined) {
      throw new PiDirectExecutorOperationConflictError("Operation缺少当前Prompt Review引用");
    }
    const loaded = await this.product.consumeDecision({
      commandId: `cmd_${hashExecutorValue({
        kind: "consume-direct-prompt-review",
        operationId: input.operationId,
        promptReviewDecisionId: input.promptReviewDecisionId,
      }).slice(0, 40)}`,
      operationId: input.operationId,
      productRunId: request.productRunId,
      directAgentAttemptId: request.directAgentAttemptId,
      review: active.review,
      providerId: active.providerId,
      modelId: active.modelId,
      endpointHost: active.endpointHost,
      promptReviewDecisionId: input.promptReviewDecisionId,
    });
    try {
      await this.submitDecision(input.operationId, loaded);
    } catch (error) {
      if (loaded.status !== "authorized") throw error;
      // Product已交出且消费唯一permit；冻结正文校验或本地落盘失败后绝不能再次索取/发送。
      await this.markProviderOutcomeUnknown(
        input.operationId,
        "direct_executor.provider_permit_payload_drift",
      );
    }
  }

  async markProviderSettled(input: {
    readonly operationId: string;
    readonly completionTokens: number;
    readonly stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
  }): Promise<void> {
    await this.store.recordProviderCompleted(input);
    await this.commitProviderDispatched(input.operationId);
    await this.store.finalizeProviderSettled(input.operationId);
    this.approvedPayloads.delete(input.operationId);
  }

  /** 重启仅重放幂等Product结算，不会重发Provider请求。 */
  async reconcileCompletedProvider(operationId: string): Promise<void> {
    if (!this.store.hasProviderCompletion(operationId)) {
      throw new PiDirectExecutorOperationConflictError(
        "缺少Provider完成证据，不能按dispatched对账",
      );
    }
    await this.commitProviderDispatched(operationId);
  }

  private async commitProviderDispatched(operationId: string): Promise<void> {
    const request = this.store.getRequest(operationId);
    const active = this.store.getActivePromptReview(operationId);
    if (active?.review === undefined) {
      throw new PiDirectExecutorOperationConflictError("Provider派发缺少Prompt Review引用");
    }
    await this.product.commitDispatchOutcome({
      commandId: `cmd_${hashExecutorValue({
        kind: "commit-direct-provider-dispatched",
        operationId,
        promptReviewRequestId: active.review.promptReviewRequestId,
      }).slice(0, 40)}`,
      productRunId: request.productRunId,
      directAgentAttemptId: request.directAgentAttemptId,
      promptReviewRequestId: active.review.promptReviewRequestId,
      outcome: "dispatched",
    });
  }

  async markProviderOutcomeUnknown(operationId: string, errorCode: string): Promise<void> {
    const request = this.store.getRequest(operationId);
    const active = this.store.getActivePromptReview(operationId);
    if (active?.review !== undefined) {
      await this.product
        .commitDispatchOutcome({
          commandId: `cmd_${hashExecutorValue({
            kind: "commit-direct-provider-outcome-unknown",
            operationId,
            promptReviewRequestId: active.review.promptReviewRequestId,
          }).slice(0, 40)}`,
          productRunId: request.productRunId,
          directAgentAttemptId: request.directAgentAttemptId,
          promptReviewRequestId: active.review.promptReviewRequestId,
          outcome: "outcome_unknown",
          errorCode,
        })
        .catch(() => undefined);
    }
    await this.store.markOutcomeUnknown(operationId, errorCode);
    this.approvedPayloads.delete(operationId);
    this.waiters.get(operationId)?.resolve();
    this.waiters.delete(operationId);
  }

  async openCheckpoint(input: {
    readonly checkpoint: DirectPromptReviewCheckpoint;
    readonly cwd: string;
    readonly sessionsDirectory: string;
  }): Promise<SessionManager> {
    const path = join(this.checkpointDirectory, input.checkpoint.fileName);
    const bytes = await readFile(path);
    if (createHash("sha256").update(bytes).digest("hex") !== input.checkpoint.fileSha256) {
      throw new Error("Prompt Review Session Checkpoint Hash不一致");
    }
    const manager = SessionManager.open(path, input.sessionsDirectory, input.cwd);
    if (
      manager.getSessionId() !== input.checkpoint.sessionId ||
      manager.getLeafId() !== input.checkpoint.leafId
    ) {
      throw new Error("Prompt Review Session Checkpoint身份不一致");
    }
    return manager;
  }

  private async waitForDecision(operationId: string, signal: AbortSignal): Promise<void> {
    const existing = this.store.getActivePromptReview(operationId)?.decision;
    if (existing !== undefined) return;
    if (signal.aborted) throw new PromptReviewWaitInterruptedError();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.waiters.delete(operationId);
        reject(new PromptReviewWaitInterruptedError());
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiters.set(operationId, {
        resolve: () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
      });
    });
  }

  private loadApprovedPayload(operationId: string): unknown {
    const cached = this.approvedPayloads.get(operationId);
    if (cached !== undefined) return cached;
    throw new PiDirectExecutorOperationConflictError(
      "已消费的Provider permit没有可再次取得的冻结Payload",
    );
  }

  private async exportCheckpoint(
    operationId: string,
    requestIndex: number,
    session: AgentSession,
  ): Promise<DirectPromptReviewCheckpoint> {
    await mkdir(this.checkpointDirectory, { recursive: true, mode: 0o700 });
    const leafId = session.sessionManager.getLeafId();
    if (leafId === null) throw new Error("Provider Review边界前Pi Session没有可恢复leaf");
    const temporaryName = `.${operationId}.${randomUUID()}.tmp.jsonl`;
    const temporaryPath = join(this.checkpointDirectory, temporaryName);
    try {
      session.exportToJsonl(temporaryPath);
      await chmod(temporaryPath, 0o600);
      const bytes = await readFile(temporaryPath);
      const fileSha256 = createHash("sha256").update(bytes).digest("hex");
      const fileName = `${operationId}-review-${String(requestIndex)}-${fileSha256.slice(0, 16)}.jsonl`;
      await rename(temporaryPath, join(this.checkpointDirectory, fileName));
      return {
        fileName,
        fileSha256,
        sessionId: session.sessionId,
        leafId,
      };
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
