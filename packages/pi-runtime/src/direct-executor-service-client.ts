import { DIRECT_AGENT_ACTIVE_TIMEOUT_MS } from "@chat/contracts";
import { operationIdForDirectAgentAttempt } from "./direct-executor-identity.js";
import {
  PI_DIRECT_EXECUTOR_PROTOCOL_VERSION,
  piDirectExecutorEventsResponseSchema,
  piDirectExecutorOperationSnapshotSchema,
  startPiDirectExecutorOperationRequestSchema,
  submitDirectPromptReviewDecisionRequestSchema,
  type DirectPromptReviewRef,
  type PiDirectExecutorEvent,
  type PiDirectExecutorOperationSnapshot,
} from "./direct-executor-service-contract.js";
import { PI_EXECUTOR_RUNTIME_HEADER } from "./executor-service-contract.js";
import { hashExecutorValue } from "./executor-operation-store.js";
import { validatePiDirectExecutorOperationJournal } from "./direct-executor-operation-store.js";

export type PiDirectExecutorClientOutcome =
  | {
      readonly kind: "waiting_prompt_review";
      readonly operationId: string;
      readonly requestSha256: string;
      readonly review: DirectPromptReviewRef;
    }
  | {
      readonly kind: "succeeded";
      readonly operationId: string;
      readonly requestSha256: string;
      readonly result: NonNullable<PiDirectExecutorOperationSnapshot["result"]>;
    }
  | {
      readonly kind: "cancelled" | "failed" | "outcome_unknown";
      readonly operationId: string;
      readonly requestSha256: string;
      readonly errorCode: string;
    };

export interface StartPiDirectExecutorClientInput {
  readonly productRunId: string;
  readonly directAgentAttemptId: string;
  readonly workflowRunSpecId: string;
  readonly workflowRunSpecSha256: string;
  readonly inputManifestSha256: string;
  readonly onEvent?: (event: PiDirectExecutorEvent) => unknown;
}

export interface SubmitPiDirectPromptReviewDecisionInput {
  readonly operationId: string;
  readonly requestSha256: string;
  readonly review: DirectPromptReviewRef;
  readonly promptReviewDecisionId: string;
  readonly onEvent?: (event: PiDirectExecutorEvent) => unknown;
}

export class PiDirectExecutorRemoteError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PiDirectExecutorRemoteError";
  }
}

export interface PiDirectExecutorServiceClientOptions {
  readonly baseUrl: string;
  readonly credential: string;
  readonly fetchFn?: typeof fetch;
  readonly pollIntervalMs?: number;
}

export function createPiDirectExecutorServiceClient(options: PiDirectExecutorServiceClientOptions) {
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/u, "");
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const headers = {
    "content-type": "application/json",
    [PI_EXECUTOR_RUNTIME_HEADER]: options.credential,
  };

  const poll = async (input: {
    readonly operationId: string;
    readonly requestSha256: string;
    readonly timeoutMs: number;
    readonly afterPromptReviewRequestId?: string;
    readonly onEvent?: (event: PiDirectExecutorEvent) => unknown;
  }): Promise<PiDirectExecutorClientOutcome> => {
    let lastEventSequence = 0;
    const journalEvents: PiDirectExecutorEvent[] = [];
    const pendingProjection: PiDirectExecutorEvent[] = [];
    const flushProjection = () => {
      while (pendingProjection.length > 0) {
        const event = pendingProjection[0];
        if (event === undefined) return;
        try {
          if (input.onEvent?.(event) === false) return;
        } catch {
          return;
        }
        pendingProjection.shift();
      }
    };
    const deadline = Date.now() + input.timeoutMs + 30_000;
    while (true) {
      const eventsResponse = await fetchFn(
        `${baseUrl}/internal/pi-direct-executor/v2/operations/${input.operationId}/events?afterSequence=${String(lastEventSequence)}`,
        { headers },
      );
      if (!eventsResponse.ok) throw await remoteProblem(eventsResponse);
      const page = piDirectExecutorEventsResponseSchema.parse(await eventsResponse.json());
      if (
        page.operationId !== input.operationId ||
        page.lastEventSequence < lastEventSequence ||
        page.events.some((event) => event.operationId !== input.operationId)
      ) {
        throw new PiDirectExecutorRemoteError("direct_executor.response_identity_mismatch");
      }
      for (const event of page.events) {
        if (event.sequence !== lastEventSequence + 1) {
          throw new PiDirectExecutorRemoteError("direct_executor.event_sequence_gap");
        }
        lastEventSequence = event.sequence;
        journalEvents.push(event);
        pendingProjection.push(event);
      }
      // Activity只是Operation Journal的可重放投影。一次写失败会保留该source sequence，
      // 下一轮先重放；持续失败也不能改变Executor终态或诱发Tool再次执行。
      flushProjection();
      const statusResponse = await fetchFn(
        `${baseUrl}/internal/pi-direct-executor/v2/operations/${input.operationId}`,
        { headers },
      );
      if (!statusResponse.ok) throw await remoteProblem(statusResponse);
      const snapshot = piDirectExecutorOperationSnapshotSchema.parse(await statusResponse.json());
      if (
        snapshot.operationId !== input.operationId ||
        snapshot.requestSha256 !== input.requestSha256
      ) {
        throw new PiDirectExecutorRemoteError("direct_executor.response_identity_mismatch");
      }
      // events与snapshot是两次GET；任一状态返回前都必须把两者之间新增的Journal事件
      // drain完。否则waiting_prompt_review可能永久漏掉preparing/waiting活动。
      if (lastEventSequence < snapshot.lastEventSequence) continue;
      if (lastEventSequence > snapshot.lastEventSequence) {
        throw new PiDirectExecutorRemoteError("direct_executor.event_sequence_rewind");
      }
      try {
        validatePiDirectExecutorOperationJournal({
          snapshot,
          events: journalEvents,
          expectedOperationId: input.operationId,
          expectedRequestSha256: input.requestSha256,
          requireCapabilitySnapshot: true,
        });
      } catch {
        if (snapshot.status === "succeeded") {
          return {
            kind: "outcome_unknown",
            operationId: input.operationId,
            requestSha256: input.requestSha256,
            errorCode: "direct_executor.journal_integrity_invalid",
          };
        }
        throw new PiDirectExecutorRemoteError("direct_executor.journal_integrity_invalid");
      }
      flushProjection();
      if (snapshot.status === "waiting_prompt_review") {
        if (snapshot.activeReview === undefined) {
          throw new PiDirectExecutorRemoteError("direct_executor.prompt_review_ref_missing");
        }
        if (
          input.afterPromptReviewRequestId !== undefined &&
          snapshot.activeReview.promptReviewRequestId === input.afterPromptReviewRequestId
        ) {
          if (Date.now() >= deadline) {
            throw new PiDirectExecutorRemoteError("direct_executor.poll_timeout");
          }
          await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
          continue;
        }
        return {
          kind: "waiting_prompt_review",
          operationId: input.operationId,
          requestSha256: input.requestSha256,
          review: snapshot.activeReview,
        };
      }
      if (snapshot.status === "succeeded") {
        if (snapshot.result === undefined) {
          throw new PiDirectExecutorRemoteError("direct_executor.result_ref_missing");
        }
        return {
          kind: "succeeded",
          operationId: input.operationId,
          requestSha256: input.requestSha256,
          result: snapshot.result,
        };
      }
      if (
        snapshot.status === "cancelled" ||
        snapshot.status === "failed" ||
        snapshot.status === "outcome_unknown"
      ) {
        return {
          kind: snapshot.status,
          operationId: input.operationId,
          requestSha256: input.requestSha256,
          errorCode: snapshot.errorCode ?? `direct_executor.${snapshot.status}`,
        };
      }
      if (Date.now() >= deadline) {
        throw new PiDirectExecutorRemoteError("direct_executor.poll_timeout");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  };

  const start = async (
    input: StartPiDirectExecutorClientInput,
  ): Promise<PiDirectExecutorClientOutcome> => {
    const operationId = operationIdForDirectAgentAttempt(input.directAgentAttemptId);
    const request = startPiDirectExecutorOperationRequestSchema.parse({
      schemaVersion: PI_DIRECT_EXECUTOR_PROTOCOL_VERSION,
      operationId,
      productRunId: input.productRunId,
      directAgentAttemptId: input.directAgentAttemptId,
      workflowRunSpecId: input.workflowRunSpecId,
      workflowRunSpecSha256: input.workflowRunSpecSha256,
      inputManifestSha256: input.inputManifestSha256,
    });
    const response = await fetchFn(`${baseUrl}/internal/pi-direct-executor/v2/operations`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    if (!response.ok) throw await remoteProblem(response);
    const startSnapshot = piDirectExecutorOperationSnapshotSchema.parse(await response.json());
    const requestSha256 = hashExecutorValue(request);
    if (
      startSnapshot.operationId !== operationId ||
      startSnapshot.requestSha256 !== requestSha256
    ) {
      throw new PiDirectExecutorRemoteError("direct_executor.response_identity_mismatch");
    }
    return poll({
      operationId,
      requestSha256,
      timeoutMs: DIRECT_AGENT_ACTIVE_TIMEOUT_MS,
      ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
    });
  };

  const submitDecision = async (
    input: SubmitPiDirectPromptReviewDecisionInput,
  ): Promise<PiDirectExecutorClientOutcome> => {
    const request = submitDirectPromptReviewDecisionRequestSchema.parse({
      schemaVersion: PI_DIRECT_EXECUTOR_PROTOCOL_VERSION,
      promptReviewRequestId: input.review.promptReviewRequestId,
      requestRevision: input.review.requestRevision,
      reviewSha256: input.review.reviewSha256,
      payloadSha256: input.review.payloadSha256,
      promptReviewDecisionId: input.promptReviewDecisionId,
    });
    const response = await fetchFn(
      `${baseUrl}/internal/pi-direct-executor/v2/operations/${input.operationId}/prompt-review-decisions`,
      { method: "POST", headers, body: JSON.stringify(request) },
    );
    if (!response.ok) throw await remoteProblem(response);
    const decisionSnapshot = piDirectExecutorOperationSnapshotSchema.parse(await response.json());
    if (
      decisionSnapshot.operationId !== input.operationId ||
      decisionSnapshot.requestSha256 !== input.requestSha256
    ) {
      throw new PiDirectExecutorRemoteError("direct_executor.response_identity_mismatch");
    }
    return poll({
      operationId: input.operationId,
      requestSha256: input.requestSha256,
      timeoutMs: DIRECT_AGENT_ACTIVE_TIMEOUT_MS,
      afterPromptReviewRequestId: input.review.promptReviewRequestId,
      ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
    });
  };

  return { start, submitDecision };
}

async function remoteProblem(response: Response): Promise<PiDirectExecutorRemoteError> {
  let code = "direct_executor.service_unavailable";
  try {
    const body = (await response.json()) as unknown;
    if (
      typeof body === "object" &&
      body !== null &&
      "errorCode" in body &&
      typeof body.errorCode === "string"
    ) {
      code = body.errorCode;
    }
  } catch {
    // 私有协议正文损坏时不把原始响应带入Trace或错误。
  }
  return new PiDirectExecutorRemoteError(code);
}
