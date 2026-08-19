import {
  PRODUCT_API_SCHEMA_VERSION,
  DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
  directAgentPromptReviewDecisionRefSchema,
  promptReviewDecisionDtoSchema,
  promptReviewRequestDtoSchema,
  type CommandId,
  type ConsumePromptReviewDecisionRuntimeResponse,
  type PrincipalId,
  type ProductRunId,
  type PromptReviewDecision,
  type PromptReviewDecisionDto,
  type PromptReviewRequest,
  type PromptReviewRequestDto,
  type PromptReviewRequestId,
  type RunAttemptId,
  type SubmitPromptReviewDecisionPayload,
} from "@chat/contracts";
import {
  DomainInvariantError,
  assertPromptReviewDecisionBinding,
  assertPromptReviewRequestIndexes,
  assertSingleOpenPromptReview,
  computePromptReviewPayloadSha256,
  computePromptReviewDecisionSha256,
  computePromptReviewSha256,
  hashCanonical,
  renderPromptReviewReadable as renderPromptReviewReadableFromDomain,
  transitionDirectAgentRunLifecycle,
  transitionPromptReviewStatus,
} from "@chat/domain";
import type { ApplicationDeps, DirectAgentIdFactory } from "./deps.js";
import { ApplicationError, forbidden, notFound, revisionConflict } from "./errors.js";
import { requireDirectAgentRun } from "./product-run-kind.js";
import { toRunDto } from "./dto.js";

/**
 * Provider Payload正文只在PromptReviewRequest中保存一次。公开Query的可读版由这里
 * 确定性投影；它不调用模型，也不会删除或概括任何JSON字段。
 */
export function renderPromptReviewReadable(request: PromptReviewRequest): string {
  return renderPromptReviewReadableFromDomain(
    request.canonicalPayloadJson,
    request.rendererVersion,
  );
}

function requireDirectAgentIds(deps: ApplicationDeps): DirectAgentIdFactory {
  if (deps.directAgentIds === undefined) {
    throw new Error("DirectAgentIdFactory未配置，不能执行Prompt Review用例");
  }
  return deps.directAgentIds;
}

function toPromptReviewDto(request: PromptReviewRequest): PromptReviewRequestDto {
  return promptReviewRequestDtoSchema.parse({
    schemaVersion: PRODUCT_API_SCHEMA_VERSION,
    promptReviewRequestId: request.promptReviewRequestId,
    productRunId: request.productRunId,
    requestIndex: request.requestIndex,
    requestKind: request.requestKind,
    providerId: request.providerId,
    modelId: request.modelId,
    endpointHost: request.endpointHost,
    requestRevision: request.requestRevision,
    status: request.status,
    canonicalPayloadJson: request.canonicalPayloadJson,
    readablePrompt: renderPromptReviewReadable(request),
    rendererVersion: request.rendererVersion,
    payloadSha256: request.payloadSha256,
    reviewSha256: request.reviewSha256,
    allowedActions: request.status === "open" ? ["approve", "reject"] : [],
    revision: request.revision,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  });
}

function toPromptDecisionDto(decision: PromptReviewDecision): PromptReviewDecisionDto {
  return promptReviewDecisionDtoSchema.parse({
    schemaVersion: PRODUCT_API_SCHEMA_VERSION,
    promptReviewDecisionId: decision.promptReviewDecisionId,
    promptReviewRequestId: decision.promptReviewRequestId,
    productRunId: decision.productRunId,
    requestRevision: decision.requestRevision,
    reviewSha256: decision.reviewSha256,
    payloadSha256: decision.payloadSha256,
    kind: decision.kind,
    createdAt: decision.createdAt,
  });
}

function toPromptDecisionRuntimeRef(decision: PromptReviewDecision) {
  return directAgentPromptReviewDecisionRefSchema.parse({
    promptReviewDecisionId: decision.promptReviewDecisionId,
    promptReviewRequestId: decision.promptReviewRequestId,
    productRunId: decision.productRunId,
    requestRevision: decision.requestRevision,
    reviewSha256: decision.reviewSha256,
    payloadSha256: decision.payloadSha256,
    kind: decision.kind,
    revision: decision.revision,
    decisionSha256: computePromptReviewDecisionSha256({
      promptReviewDecisionId: decision.promptReviewDecisionId,
      promptReviewRequestId: decision.promptReviewRequestId,
      productRunId: decision.productRunId,
      requestRevision: decision.requestRevision,
      reviewSha256: decision.reviewSha256,
      payloadSha256: decision.payloadSha256,
      kind: decision.kind,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      principalId: decision.principalId,
      commandId: decision.commandId,
    }),
  });
}

export interface PublishPromptReviewRequestInput {
  readonly commandId: CommandId;
  readonly productRunId: ProductRunId;
  readonly directAgentAttemptId: RunAttemptId;
  readonly expectedRunRevision: number;
  readonly requestIndex: number;
  readonly requestKind: "agent_turn" | "compaction" | "retry";
  readonly providerId: string;
  readonly modelId: string;
  readonly endpointHost: string;
  readonly canonicalPayloadJson: string;
  readonly payloadSha256: string;
}

/** Executor Gate在任何Provider网络请求前调用；正文提交成功后Run才进入等待人工。 */
export async function publishPromptReviewRequest(
  deps: ApplicationDeps,
  input: PublishPromptReviewRequestInput,
): Promise<{ readonly promptReview: PromptReviewRequestDto; readonly runRevision: number }> {
  const ids = requireDirectAgentIds(deps);
  const now = deps.now();
  const promptReviewRequestId = ids.promptReviewRequest();
  const payloadSha256 = mapPromptInvariant(() =>
    computePromptReviewPayloadSha256(input.canonicalPayloadJson),
  );
  if (payloadSha256 !== input.payloadSha256) {
    throw revisionConflict("Executor提交的Provider Payload Hash不匹配");
  }
  const requestRevision = 1;
  const rendererVersion = "prompt-readable.v1" as const;
  const reviewSha256 = computePromptReviewSha256({
    promptReviewRequestId,
    productRunId: input.productRunId,
    directAgentAttemptId: input.directAgentAttemptId,
    requestIndex: input.requestIndex,
    requestKind: input.requestKind,
    providerId: input.providerId,
    modelId: input.modelId,
    endpointHost: input.endpointHost,
    requestRevision,
    payloadSha256,
    rendererVersion,
  });
  const requestSha256 = hashCanonical("command.publish-prompt-review-request.v1", {
    productRunId: input.productRunId,
    directAgentAttemptId: input.directAgentAttemptId,
    expectedRunRevision: input.expectedRunRevision,
    requestIndex: input.requestIndex,
    requestKind: input.requestKind,
    providerId: input.providerId,
    modelId: input.modelId,
    endpointHost: input.endpointHost,
    canonicalPayloadJson: input.canonicalPayloadJson,
  });

  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "PublishPromptReviewRequest",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const found = draft.entities.runs[input.productRunId];
      if (found === undefined) throw notFound("Product Run不存在");
      const run = requireDirectAgentRun(found);
      if (run.revision !== input.expectedRunRevision) {
        throw revisionConflict("Run revision已变化，不能发布旧Prompt Review");
      }
      if (run.status !== "running" || run.phase !== "executing") {
        throw revisionConflict("Direct Agent当前不允许发布Prompt Review");
      }
      const attempt = draft.entities.attempts[input.directAgentAttemptId];
      if (
        attempt === undefined ||
        attempt.productRunId !== input.productRunId ||
        attempt.kind !== "direct_agent" ||
        attempt.outcome !== "running"
      ) {
        throw revisionConflict("Direct Agent Attempt不存在或已经终结");
      }
      const reviews = Object.values(draft.entities.promptReviewRequests).filter(
        (candidate) => candidate.directAgentAttemptId === input.directAgentAttemptId,
      );
      mapPromptInvariant(() => {
        assertSingleOpenPromptReview(reviews);
        assertPromptReviewRequestIndexes(reviews);
      });
      if (reviews.some((candidate) => candidate.status === "open")) {
        throw revisionConflict("Direct Agent已有等待中的Prompt Review");
      }
      if (input.requestIndex !== reviews.length + 1) {
        throw revisionConflict("Prompt Review requestIndex不是下一连续序号");
      }
      const review: PromptReviewRequest = {
        schemaVersion: "prompt-review-request.v1",
        promptReviewRequestId,
        productRunId: input.productRunId,
        directAgentAttemptId: input.directAgentAttemptId,
        requestIndex: input.requestIndex,
        requestKind: input.requestKind,
        providerId: input.providerId,
        modelId: input.modelId,
        endpointHost: input.endpointHost,
        requestRevision,
        status: "open",
        canonicalPayloadJson: input.canonicalPayloadJson,
        payloadSha256,
        rendererVersion,
        reviewSha256,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const lifecycle = transitionDirectAgentRunLifecycle(
        { status: run.status, phase: run.phase },
        { status: "waiting_human", phase: "prompt_review" },
      );
      draft.entities.promptReviewRequests[promptReviewRequestId] = review;
      draft.entities.runs[input.productRunId] = {
        ...run,
        status: lifecycle.status,
        phase: lifecycle.phase,
        currentPromptReviewRequestId: promptReviewRequestId,
        revision: run.revision + 1,
        updatedAt: now,
      };
      return { resultRefs: { promptReviewRequestId, productRunId: input.productRunId } };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const review =
    snapshot.entities.promptReviewRequests[result.resultRefs["promptReviewRequestId"] ?? ""];
  const run = snapshot.entities.runs[input.productRunId];
  if (review === undefined || run === undefined) throw notFound("Prompt Review或Run不存在");
  return { promptReview: toPromptReviewDto(review), runRevision: run.revision };
}

export async function getCurrentPromptReview(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly productRunId: ProductRunId },
): Promise<{ readonly promptReview: PromptReviewRequestDto | null }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const found = snapshot.entities.runs[input.productRunId];
  if (found === undefined) throw notFound("Product Run不存在");
  const run = requireDirectAgentRun(found);
  const session = snapshot.entities.sessions[run.sessionId];
  if (session === undefined) throw notFound("Session不存在");
  if (session.ownerPrincipalId !== input.principalId) throw forbidden("无权访问该Prompt Review");
  if (run.currentPromptReviewRequestId === undefined) return { promptReview: null };
  const review = snapshot.entities.promptReviewRequests[run.currentPromptReviewRequestId];
  if (review === undefined || review.productRunId !== input.productRunId) {
    throw new ApplicationError({
      code: "store_corrupted",
      httpStatus: 500,
      message: "Run当前Prompt Review引用损坏",
      recoveryAction: "contact_support",
    });
  }
  return { promptReview: toPromptReviewDto(review) };
}

export interface SubmitPromptReviewDecisionInput {
  readonly principalId: PrincipalId;
  readonly productRunId: ProductRunId;
  readonly commandId: CommandId;
  readonly expectedRunRevision: number;
  readonly payload: SubmitPromptReviewDecisionPayload;
}

export async function submitPromptReviewDecision(
  deps: ApplicationDeps,
  input: SubmitPromptReviewDecisionInput,
): Promise<{
  readonly decision: PromptReviewDecisionDto;
  readonly run: ReturnType<typeof toRunDto>;
}> {
  const ids = requireDirectAgentIds(deps);
  const now = deps.now();
  const promptReviewDecisionId = ids.promptReviewDecision();
  const outboxId = deps.ids.outbox();
  const requestSha256 = hashCanonical("command.submit-prompt-review-decision.v1", {
    principalId: input.principalId,
    productRunId: input.productRunId,
    expectedRunRevision: input.expectedRunRevision,
    payload: input.payload,
  });
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "SubmitPromptReviewDecision",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const found = draft.entities.runs[input.productRunId];
      if (found === undefined) throw notFound("Product Run不存在");
      const run = requireDirectAgentRun(found);
      if (run.revision !== input.expectedRunRevision) {
        throw revisionConflict("Run revision已变化，请重新读取Prompt Review");
      }
      if (run.status !== "waiting_human" || run.phase !== "prompt_review") {
        throw revisionConflict("Direct Agent当前不在Prompt Review等待状态");
      }
      const session = draft.entities.sessions[run.sessionId];
      if (session === undefined) throw notFound("Session不存在");
      if (session.ownerPrincipalId !== input.principalId)
        throw forbidden("无权决定该Prompt Review");
      const review = draft.entities.promptReviewRequests[input.payload.promptReviewRequestId];
      if (
        review === undefined ||
        review.productRunId !== input.productRunId ||
        run.currentPromptReviewRequestId !== review.promptReviewRequestId
      ) {
        throw notFound("当前Prompt Review不存在");
      }
      mapPromptInvariant(() =>
        assertPromptReviewDecisionBinding(review, {
          promptReviewRequestId: input.payload.promptReviewRequestId,
          productRunId: input.productRunId,
          requestRevision: input.payload.requestRevision,
          reviewSha256: input.payload.reviewSha256,
          payloadSha256: input.payload.payloadSha256,
        }),
      );
      const nextReviewStatus = input.payload.kind === "approve" ? "approved" : "rejected";
      const nextLifecycle =
        input.payload.kind === "approve"
          ? transitionDirectAgentRunLifecycle(
              { status: run.status, phase: run.phase },
              { status: "running", phase: "executing" },
            )
          : transitionDirectAgentRunLifecycle(
              { status: run.status, phase: run.phase },
              { status: "cancelled", phase: "rejected" },
            );
      const decision: PromptReviewDecision = {
        schemaVersion: "prompt-review-decision.v1",
        promptReviewDecisionId,
        promptReviewRequestId: review.promptReviewRequestId,
        productRunId: input.productRunId,
        requestRevision: review.requestRevision,
        reviewSha256: review.reviewSha256,
        payloadSha256: review.payloadSha256,
        kind: input.payload.kind,
        ...(input.payload.reason !== undefined ? { reason: input.payload.reason } : {}),
        principalId: input.principalId,
        commandId: input.commandId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.promptReviewDecisions[promptReviewDecisionId] = decision;
      draft.entities.promptReviewRequests[review.promptReviewRequestId] = {
        ...review,
        status: transitionPromptReviewStatus(review.status, nextReviewStatus),
        decidedByPromptReviewDecisionId: promptReviewDecisionId,
        revision: review.revision + 1,
        updatedAt: now,
      };
      const decidedRun = {
        ...run,
        status: nextLifecycle.status,
        phase: nextLifecycle.phase,
        revision: run.revision + 1,
        updatedAt: now,
      };
      delete decidedRun.currentPromptReviewRequestId;
      draft.entities.runs[input.productRunId] = decidedRun;
      if (input.payload.kind === "reject") {
        const attempt = draft.entities.attempts[review.directAgentAttemptId];
        if (attempt !== undefined && attempt.outcome === "running") {
          draft.entities.attempts[attempt.attemptId] = {
            ...attempt,
            outcome: "failure",
            errorCode: "prompt_review.rejected",
            revision: attempt.revision + 1,
            updatedAt: now,
          };
        }
      }
      draft.outbox[outboxId] = {
        schemaVersion: "outbox-entry.v1",
        outboxId,
        kind: "workflow_resume",
        status: "pending",
        productRunId: input.productRunId,
        promptReviewRequestId: review.promptReviewRequestId,
        promptReviewDecisionId,
        dispatchAttempts: 0,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      return {
        resultRefs: {
          promptReviewDecisionId,
          promptReviewRequestId: review.promptReviewRequestId,
          productRunId: input.productRunId,
        },
      };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const decision =
    snapshot.entities.promptReviewDecisions[result.resultRefs["promptReviewDecisionId"] ?? ""];
  const found = snapshot.entities.runs[input.productRunId];
  if (decision === undefined || found === undefined) throw notFound("Prompt Review Decision不存在");
  const run = requireDirectAgentRun(found);
  return { decision: toPromptDecisionDto(decision), run: toRunDto(run, undefined, undefined) };
}

export async function loadCommittedPromptReviewDecision(
  deps: ApplicationDeps,
  input: {
    readonly productRunId: ProductRunId;
    readonly promptReviewRequestId: PromptReviewRequestId;
    readonly promptReviewDecisionId: PromptReviewDecision["promptReviewDecisionId"];
    readonly requestRevision: number;
    readonly reviewSha256: string;
    readonly payloadSha256: string;
  },
): Promise<PromptReviewDecisionDto> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const review = snapshot.entities.promptReviewRequests[input.promptReviewRequestId];
  const decision = snapshot.entities.promptReviewDecisions[input.promptReviewDecisionId];
  if (
    review === undefined ||
    decision === undefined ||
    review.productRunId !== input.productRunId ||
    decision.productRunId !== input.productRunId ||
    decision.promptReviewRequestId !== review.promptReviewRequestId
  ) {
    throw notFound("Prompt Review Decision不存在");
  }
  if (
    decision.requestRevision !== input.requestRevision ||
    decision.reviewSha256 !== input.reviewSha256 ||
    decision.payloadSha256 !== input.payloadSha256
  ) {
    throw revisionConflict("Prompt Review Decision绑定已变化");
  }
  return toPromptDecisionDto(decision);
}

/** Workflow恢复Hook时只读验证Decision；不消费Provider permit，也不返回Prompt正文。 */
export async function loadPromptReviewDecisionForRuntime(
  deps: ApplicationDeps,
  input: {
    readonly productRunId: ProductRunId;
    readonly promptReviewRequestId: PromptReviewRequestId;
    readonly promptReviewDecisionId: PromptReviewDecision["promptReviewDecisionId"];
    readonly requestRevision: number;
    readonly reviewSha256: string;
    readonly payloadSha256: string;
  },
) {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const review = snapshot.entities.promptReviewRequests[input.promptReviewRequestId];
  const decision = snapshot.entities.promptReviewDecisions[input.promptReviewDecisionId];
  if (
    review === undefined ||
    decision === undefined ||
    review.productRunId !== input.productRunId ||
    review.decidedByPromptReviewDecisionId !== decision.promptReviewDecisionId ||
    decision.productRunId !== input.productRunId ||
    decision.promptReviewRequestId !== review.promptReviewRequestId ||
    decision.requestRevision !== input.requestRevision ||
    decision.reviewSha256 !== input.reviewSha256 ||
    decision.payloadSha256 !== input.payloadSha256
  ) {
    throw revisionConflict("Prompt Review Decision绑定不完整或已变化");
  }
  return { decision: toPromptDecisionRuntimeRef(decision) };
}

/**
 * Executor恢复审核时的唯一产品入口。reject只返回不可变Decision引用；approve还必须
 * 用同一个稳定commandId原子消费一次Provider dispatch permit。响应丢失后的重放
 * 只能得到already_claimed，不会再次取得冻结正文。
 */
export async function consumePromptReviewDecision(
  deps: ApplicationDeps,
  input: MarkPromptReviewDispatchingInput,
): Promise<ConsumePromptReviewDecisionRuntimeResponse> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const found = snapshot.entities.runs[input.productRunId];
  if (found === undefined) throw notFound("Product Run不存在");
  const run = requireDirectAgentRun(found);
  const review = snapshot.entities.promptReviewRequests[input.promptReviewRequestId];
  const decision = snapshot.entities.promptReviewDecisions[input.promptReviewDecisionId];
  if (
    review === undefined ||
    decision === undefined ||
    review.productRunId !== input.productRunId ||
    review.directAgentAttemptId !== input.directAgentAttemptId ||
    review.decidedByPromptReviewDecisionId !== decision.promptReviewDecisionId ||
    decision.promptReviewRequestId !== review.promptReviewRequestId ||
    decision.productRunId !== input.productRunId ||
    decision.requestRevision !== input.requestRevision ||
    decision.reviewSha256 !== input.reviewSha256 ||
    decision.payloadSha256 !== input.payloadSha256
  ) {
    throw revisionConflict("Prompt Review Decision绑定不完整或已变化");
  }
  const decisionRef = toPromptDecisionRuntimeRef(decision);
  if (decision.kind === "reject") {
    return {
      schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
      status: "rejected",
      decision: decisionRef,
      runRevision: run.revision,
    };
  }
  const authorization = await markPromptReviewDispatching(deps, input);
  if (authorization.status === "already_claimed") {
    return {
      schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
      status: "already_claimed",
      decision: decisionRef,
      runRevision: run.revision,
    };
  }
  return {
    status: "authorized",
    schemaVersion: DIRECT_AGENT_INTERNAL_RUNTIME_SCHEMA_VERSION,
    decision: decisionRef,
    runRevision: run.revision,
    canonicalPayloadJson: authorization.canonicalPayloadJson,
    payloadSha256: authorization.payloadSha256,
    reviewSha256: authorization.reviewSha256,
    requestIndex: authorization.requestIndex,
    requestKind: authorization.requestKind,
    providerId: authorization.providerId,
    modelId: authorization.modelId,
    endpointHost: authorization.endpointHost,
  };
}

export interface MarkPromptReviewDispatchingInput {
  readonly commandId: CommandId;
  readonly productRunId: ProductRunId;
  readonly directAgentAttemptId: RunAttemptId;
  readonly promptReviewRequestId: PromptReviewRequestId;
  readonly promptReviewDecisionId: PromptReviewDecision["promptReviewDecisionId"];
  readonly requestRevision: number;
  readonly reviewSha256: string;
  readonly payloadSha256: string;
}

export type PromptDispatchAuthorization =
  | {
      readonly status: "authorized";
      readonly canonicalPayloadJson: string;
      readonly payloadSha256: string;
      readonly reviewSha256: string;
      readonly requestIndex: number;
      readonly requestKind: PromptReviewRequest["requestKind"];
      readonly providerId: string;
      readonly modelId: string;
      readonly endpointHost: string;
    }
  | { readonly status: "already_claimed" };

/**
 * 批准决定只是产品授权；Executor还必须用稳定commandId原子消费一次dispatch permit。
 * 若首次响应丢失，幂等重放只返回already_claimed，绝不再次交付可发送正文。
 */
export async function markPromptReviewDispatching(
  deps: ApplicationDeps,
  input: MarkPromptReviewDispatchingInput,
): Promise<PromptDispatchAuthorization> {
  const now = deps.now();
  const requestSha256 = hashCanonical("command.mark-prompt-review-dispatching.v1", input);
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "MarkPromptReviewDispatching",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const found = draft.entities.runs[input.productRunId];
      if (found === undefined) throw notFound("Product Run不存在");
      const run = requireDirectAgentRun(found);
      if (run.status !== "running" || run.phase !== "executing") {
        throw revisionConflict("Direct Agent当前不允许消费Provider dispatch permit");
      }
      const attempt = draft.entities.attempts[input.directAgentAttemptId];
      if (
        attempt === undefined ||
        attempt.productRunId !== input.productRunId ||
        attempt.kind !== "direct_agent" ||
        attempt.outcome !== "running"
      ) {
        throw revisionConflict("Direct Agent Attempt不存在或已终结");
      }
      const review = draft.entities.promptReviewRequests[input.promptReviewRequestId];
      const decision = draft.entities.promptReviewDecisions[input.promptReviewDecisionId];
      if (
        review === undefined ||
        decision === undefined ||
        review.productRunId !== input.productRunId ||
        review.directAgentAttemptId !== input.directAgentAttemptId ||
        review.decidedByPromptReviewDecisionId !== decision.promptReviewDecisionId ||
        decision.promptReviewRequestId !== review.promptReviewRequestId ||
        decision.kind !== "approve"
      ) {
        throw revisionConflict("Prompt Review批准事实不完整或不匹配");
      }
      if (
        review.requestRevision !== input.requestRevision ||
        review.reviewSha256 !== input.reviewSha256 ||
        review.payloadSha256 !== input.payloadSha256
      ) {
        throw revisionConflict("Prompt Review dispatch绑定已变化");
      }
      draft.entities.promptReviewRequests[review.promptReviewRequestId] = {
        ...review,
        status: transitionPromptReviewStatus(review.status, "dispatching"),
        revision: review.revision + 1,
        updatedAt: now,
      };
      return { resultRefs: { promptReviewRequestId: review.promptReviewRequestId } };
    },
  });
  if (result.replayed) return { status: "already_claimed" };
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const review = snapshot.entities.promptReviewRequests[input.promptReviewRequestId];
  if (review === undefined || review.status !== "dispatching") {
    throw new ApplicationError({
      code: "store_corrupted",
      httpStatus: 500,
      message: "Prompt Review dispatch permit提交后状态不一致",
      recoveryAction: "contact_support",
    });
  }
  return {
    status: "authorized",
    canonicalPayloadJson: review.canonicalPayloadJson,
    payloadSha256: review.payloadSha256,
    reviewSha256: review.reviewSha256,
    requestIndex: review.requestIndex,
    requestKind: review.requestKind,
    providerId: review.providerId,
    modelId: review.modelId,
    endpointHost: review.endpointHost,
  };
}

export async function commitPromptReviewDispatchOutcome(
  deps: ApplicationDeps,
  input: {
    readonly commandId: CommandId;
    readonly productRunId: ProductRunId;
    readonly directAgentAttemptId: RunAttemptId;
    readonly promptReviewRequestId: PromptReviewRequestId;
    readonly outcome: "dispatched" | "outcome_unknown";
    readonly errorCode?: string | undefined;
  },
): Promise<{ readonly promptReview: PromptReviewRequestDto }> {
  const now = deps.now();
  const commandType =
    input.outcome === "dispatched"
      ? "CommitPromptReviewDispatched"
      : "CommitPromptReviewOutcomeUnknown";
  const requestSha256 = hashCanonical(
    input.outcome === "dispatched"
      ? "command.commit-prompt-review-dispatched.v1"
      : "command.commit-prompt-review-outcome-unknown.v1",
    input,
  );
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType,
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const review = draft.entities.promptReviewRequests[input.promptReviewRequestId];
      if (
        review === undefined ||
        review.productRunId !== input.productRunId ||
        review.directAgentAttemptId !== input.directAgentAttemptId
      ) {
        throw notFound("Prompt Review不存在");
      }
      const found = draft.entities.runs[input.productRunId];
      if (found === undefined) throw notFound("Product Run不存在");
      const run = requireDirectAgentRun(found);
      draft.entities.promptReviewRequests[review.promptReviewRequestId] = {
        ...review,
        status: transitionPromptReviewStatus(review.status, input.outcome),
        revision: review.revision + 1,
        updatedAt: now,
      };
      if (input.outcome === "outcome_unknown") {
        if (run.status !== "running" || run.phase !== "executing") {
          throw revisionConflict("Direct Agent不在可收敛结果未知的执行状态");
        }
        const lifecycle = transitionDirectAgentRunLifecycle(
          { status: run.status, phase: run.phase },
          { status: "outcome_unknown", phase: "executing" },
        );
        draft.entities.runs[input.productRunId] = {
          ...run,
          status: lifecycle.status,
          phase: lifecycle.phase,
          failure: {
            code: input.errorCode ?? "provider.dispatch_outcome_unknown",
            summary: "Provider请求可能已经发送，结果无法确认，系统不会自动重试",
          },
          revision: run.revision + 1,
          updatedAt: now,
        };
        const attempt = draft.entities.attempts[input.directAgentAttemptId];
        if (attempt !== undefined && attempt.outcome === "running") {
          draft.entities.attempts[attempt.attemptId] = {
            ...attempt,
            outcome: "failure",
            errorCode: input.errorCode ?? "provider.dispatch_outcome_unknown",
            revision: attempt.revision + 1,
            updatedAt: now,
          };
        }
      }
      return { resultRefs: { promptReviewRequestId: review.promptReviewRequestId } };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const review =
    snapshot.entities.promptReviewRequests[result.resultRefs["promptReviewRequestId"] ?? ""];
  if (review === undefined) throw notFound("Prompt Review不存在");
  return { promptReview: toPromptReviewDto(review) };
}

function mapPromptInvariant<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof DomainInvariantError) {
      throw new ApplicationError({
        code: "revision_conflict",
        httpStatus: 409,
        message: error.message,
        recoveryAction: "rehydrate_and_retry",
      });
    }
    throw error;
  }
}
