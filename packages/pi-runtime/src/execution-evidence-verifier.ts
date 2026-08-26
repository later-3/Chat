import {
  executionEvidenceVerificationReceiptSchema,
  type ExecutionEvidenceRef,
  type ExecutionEvidenceVerificationReceipt,
} from "@chat/contracts";
import { hashCanonical } from "@chat/domain";
import {
  PI_EXECUTOR_PROTOCOL_VERSION,
  PI_EXECUTOR_RUNTIME_HEADER,
  piExecutorEventsResponseSchema,
  piExecutorOperationSnapshotSchema,
} from "./executor-service-contract.js";
import {
  executionEvidenceRefsFromPiJournal,
  validatePiExecutorOperationJournal,
} from "./executor-operation-store.js";
import { operationIdForExecutionAttempt } from "./executor-service-client.js";

export interface PiExecutionEvidenceVerifierOptions {
  readonly baseUrl: string;
  readonly credential: string;
  readonly fetchFn?: typeof fetch;
}

/** Product Application只读取经完整Journal Validator证明的窄Receipt，不复制Pi Journal。 */
export function createPiExecutionEvidenceVerifier(options: PiExecutionEvidenceVerifierOptions) {
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/u, "");
  const headers = { [PI_EXECUTOR_RUNTIME_HEADER]: options.credential };
  return {
    async verify(input: {
      readonly executionAttemptId: string;
      readonly evidenceRefs: readonly ExecutionEvidenceRef[];
    }): Promise<ExecutionEvidenceVerificationReceipt> {
      if (input.evidenceRefs.some((ref) => ref.outcome !== "completed")) {
        throw new Error("executor.evidence_receipt_mismatch");
      }
      const operationId = operationIdForExecutionAttempt(input.executionAttemptId);
      const [snapshotResponse, eventsResponse] = await Promise.all([
        fetchFn(`${baseUrl}/internal/pi-executor/v1/operations/${operationId}`, { headers }),
        fetchFn(
          `${baseUrl}/internal/pi-executor/v1/operations/${operationId}/events?afterSequence=0`,
          { headers },
        ),
      ]);
      if (!snapshotResponse.ok || !eventsResponse.ok) {
        throw new Error("executor.evidence_receipt_unavailable");
      }
      const snapshot = piExecutorOperationSnapshotSchema.parse(await snapshotResponse.json());
      const page = piExecutorEventsResponseSchema.parse(await eventsResponse.json());
      const request = snapshot.request;
      if (
        snapshot.schemaVersion !== PI_EXECUTOR_PROTOCOL_VERSION ||
        snapshot.integrityVersion !== "full-operation.v3" ||
        snapshot.operationId !== operationId ||
        snapshot.status !== "succeeded" ||
        request === undefined ||
        request.executionAttemptId !== input.executionAttemptId ||
        page.operationId !== operationId ||
        page.lastEventSequence !== snapshot.lastEventSequence
      ) {
        throw new Error("executor.evidence_receipt_identity_mismatch");
      }
      validatePiExecutorOperationJournal({ request, snapshot, events: page.events });
      const expected = executionEvidenceRefsFromPiJournal({
        executionAttemptId: input.executionAttemptId,
        events: page.events,
      });
      if (JSON.stringify(input.evidenceRefs) !== JSON.stringify(expected)) {
        throw new Error("executor.evidence_receipt_mismatch");
      }
      return executionEvidenceVerificationReceiptSchema.parse({
        schemaVersion: "execution-evidence-verification-receipt.v1",
        executionAttemptId: input.executionAttemptId,
        evidenceRefsSha256: hashCanonical("execution-evidence-refs.v1", input.evidenceRefs),
        journalSha256: hashCanonical("pi-executor-evidence-journal.v1", {
          operationId,
          request,
          snapshot,
          events: page.events,
        }),
      });
    },
  };
}
