import type { ExecutionContextItemDto, ExecutionContract } from "@chat/contracts";
import type { ExecutorDependencyResult, ExecutorStepCandidate } from "./executor.js";
import {
  PiExecutorJournalIntegrityError,
  hashExecutorValue,
  validatePiExecutorOperationJournal,
} from "./executor-operation-store.js";
import {
  PI_EXECUTOR_PROTOCOL_VERSION,
  PI_EXECUTOR_RUNTIME_HEADER,
  piExecutorEventsResponseSchema,
  piExecutorOperationSnapshotSchema,
  startPiExecutorOperationRequestSchema,
  type PiExecutorEvent,
} from "./executor-service-contract.js";

export interface RunPiExecutorServiceInput {
  readonly contract: ExecutionContract;
  readonly stepId: string;
  readonly executionAttemptId: string;
  readonly inputManifestSha256: string;
  readonly contextItems: readonly ExecutionContextItemDto[];
  readonly dependencyResults: readonly (ExecutorDependencyResult & {
    readonly executionAttemptId: string;
  })[];
  readonly onEvent?: (event: PiExecutorEvent) => void;
}

export class PiExecutorRemoteError extends Error {
  constructor(
    readonly code: string,
    readonly outcomeUnknown: boolean,
  ) {
    super(code);
    this.name = "PiExecutorRemoteError";
  }
}

export interface PiExecutorServiceClientOptions {
  readonly baseUrl: string;
  readonly credential: string;
  readonly fetchFn?: typeof fetch;
  readonly pollIntervalMs?: number;
}

function operationIdForAttempt(executionAttemptId: string): string {
  return `pio_${hashExecutorValue({ executionAttemptId }).slice(0, 32)}`;
}

export function createPiExecutorServiceClient(options: PiExecutorServiceClientOptions) {
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/u, "");
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const headers = {
    "content-type": "application/json",
    [PI_EXECUTOR_RUNTIME_HEADER]: options.credential,
  };

  return async function run(input: RunPiExecutorServiceInput): Promise<ExecutorStepCandidate> {
    const request = startPiExecutorOperationRequestSchema.parse({
      schemaVersion: PI_EXECUTOR_PROTOCOL_VERSION,
      operationId: operationIdForAttempt(input.executionAttemptId),
      executionAttemptId: input.executionAttemptId,
      inputManifestSha256: input.inputManifestSha256,
      contract: input.contract,
      stepId: input.stepId,
      contextItems: input.contextItems,
      dependencyResults: input.dependencyResults,
    });
    const requestSha256 = hashExecutorValue(request);
    const startResponse = await fetchFn(`${baseUrl}/internal/pi-executor/v1/operations`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    if (!startResponse.ok) throw await remoteProblem(startResponse);
    const startSnapshot = piExecutorOperationSnapshotSchema.parse(await startResponse.json());
    // 首次Snapshot声明的Journal代际是本次Client消费的不可降级身份；后续状态不能
    // 通过删除v2标记或request转入legacy宽松矩阵。
    const initialIntegrityVersion = startSnapshot.integrityVersion;
    const requiresFullOperationV2 = initialIntegrityVersion === "full-operation.v2";
    const journalRequest = startSnapshot.request ?? request;
    const { nodePrompt: _authorizedNodePrompt, ...journalSubmittedRequest } = journalRequest;
    void _authorizedNodePrompt;
    if (
      startSnapshot.operationId !== request.operationId ||
      (requiresFullOperationV2 && startSnapshot.request === undefined) ||
      hashExecutorValue(journalSubmittedRequest) !== requestSha256 ||
      hashExecutorValue(journalRequest) !== startSnapshot.requestSha256
    ) {
      throw new PiExecutorRemoteError("executor.journal_integrity_invalid", true);
    }

    let lastEventSequence = 0;
    let serverLastEventSequence = startSnapshot.lastEventSequence;
    const events: PiExecutorEvent[] = [];
    const deadline = Date.now() + input.contract.limits.timeoutMsPerStep + 30_000;
    while (true) {
      const eventsResponse = await fetchFn(
        `${baseUrl}/internal/pi-executor/v1/operations/${request.operationId}/events?afterSequence=${String(lastEventSequence)}`,
        { headers },
      );
      if (!eventsResponse.ok) throw await remoteProblem(eventsResponse);
      const eventPage = piExecutorEventsResponseSchema.parse(await eventsResponse.json());
      if (
        eventPage.operationId !== request.operationId ||
        eventPage.lastEventSequence < lastEventSequence
      ) {
        throw new PiExecutorRemoteError("executor.journal_integrity_invalid", true);
      }
      serverLastEventSequence = Math.max(serverLastEventSequence, eventPage.lastEventSequence);
      for (const event of eventPage.events) {
        if (event.sequence !== lastEventSequence + 1) {
          throw new PiExecutorRemoteError("executor.event_sequence_gap", true);
        }
        lastEventSequence = event.sequence;
        events.push(event);
        input.onEvent?.(event);
      }

      const statusResponse = await fetchFn(
        `${baseUrl}/internal/pi-executor/v1/operations/${request.operationId}`,
        { headers },
      );
      if (!statusResponse.ok) throw await remoteProblem(statusResponse);
      const snapshot = piExecutorOperationSnapshotSchema.parse(await statusResponse.json());
      if (
        snapshot.operationId !== request.operationId ||
        snapshot.requestSha256 !== startSnapshot.requestSha256 ||
        snapshot.integrityVersion !== initialIntegrityVersion ||
        (requiresFullOperationV2 && snapshot.request === undefined) ||
        (snapshot.request !== undefined &&
          hashExecutorValue(snapshot.request) !== startSnapshot.requestSha256) ||
        snapshot.lastEventSequence < lastEventSequence
      ) {
        throw new PiExecutorRemoteError("executor.journal_integrity_invalid", true);
      }
      serverLastEventSequence = Math.max(serverLastEventSequence, snapshot.lastEventSequence);
      if (
        (snapshot.status === "succeeded" ||
          snapshot.status === "failed" ||
          snapshot.status === "outcome_unknown") &&
        lastEventSequence < serverLastEventSequence
      ) {
        continue;
      }
      if (
        snapshot.status === "succeeded" ||
        snapshot.status === "failed" ||
        snapshot.status === "outcome_unknown"
      ) {
        try {
          validatePiExecutorOperationJournal({ request: journalRequest, snapshot, events });
        } catch (error) {
          if (error instanceof PiExecutorJournalIntegrityError) {
            throw new PiExecutorRemoteError(error.code, true);
          }
          throw error;
        }
      }
      if (snapshot.status === "succeeded") {
        if (snapshot.result === undefined) {
          throw new PiExecutorRemoteError("executor.result_missing", true);
        }
        return snapshot.result;
      }
      if (snapshot.status === "failed") {
        throw new PiExecutorRemoteError(snapshot.errorCode ?? "executor.failed", false);
      }
      if (snapshot.status === "outcome_unknown") {
        throw new PiExecutorRemoteError(
          snapshot.errorCode ?? "executor.operation_interrupted",
          true,
        );
      }
      if (Date.now() >= deadline) {
        throw new PiExecutorRemoteError("executor.poll_timeout", true);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  };
}

async function remoteProblem(response: Response): Promise<PiExecutorRemoteError> {
  let code = "executor.service_unavailable";
  try {
    const body = (await response.json()) as unknown;
    if (
      typeof body === "object" &&
      body !== null &&
      "errorCode" in body &&
      typeof body.errorCode === "string" &&
      /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/u.test(body.errorCode)
    ) {
      code = body.errorCode;
    }
  } catch {
    // 响应正文不符合私有协议时只保留稳定错误码，不把原文带入日志或Trace。
  }
  return new PiExecutorRemoteError(code, response.status >= 500);
}
