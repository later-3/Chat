import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createEmptySnapshot,
  memoryBackendIdSchema,
  memoryImportIntentIdSchema,
  memoryImportResultIdSchema,
  messageIdSchema,
  outboxEntryIdSchema,
  productSessionIdSchema,
  productSnapshotSchema,
  type MemoryImportResult,
  type ProductSnapshot,
  type TraceEventInput,
} from "@chat/contracts";
import {
  computeMemoryImportBackendDescriptorSha256,
  computeMemoryImportRequestSha256,
  computeMemoryImportSemanticDedupeSha256,
  computeMessageSha256,
  sha256Hex,
} from "@chat/domain";
import { assembleMemoryImportReplay } from "./replay.js";
import { createTraceSink } from "./trace-sink.js";

const NOW = "2026-08-08T00:00:00.000Z";
const SESSION_ID = productSessionIdSchema.parse("psn_importreplay1");
const MESSAGE_ID = messageIdSchema.parse("msg_importreplay1");
const INTENT_ID = memoryImportIntentIdSchema.parse("mii_importreplay1");
const RESULT_ID = memoryImportResultIdSchema.parse("mir_importreplay1");
const BACKEND_ID = memoryBackendIdSchema.parse("mbk_memmy");
const OUTBOX_START = outboxEntryIdSchema.parse("obx_importreplay1");
const CONTENT = "REPLAY-CONTENT-MUST-COME-FROM-PRODUCT-STORE";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "chat-import-replay-"));
}

function fixture(result: MemoryImportResult, reconcileOutboxes: string[] = []): ProductSnapshot {
  const snapshot = createEmptySnapshot(NOW);
  const message = {
    schemaVersion: "message.v1" as const,
    messageId: MESSAGE_ID,
    sessionId: SESSION_ID,
    sessionSequence: 1,
    role: "user" as const,
    content: { format: "markdown" as const, text: CONTENT },
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const sourceMessageSha256 = computeMessageSha256(message);
  const descriptor = {
    backendId: BACKEND_ID,
    displayName: "memmy 本地记忆",
    kind: "memmy" as const,
    adapterContractVersion: "memmy-http-import.v1" as const,
    configured: true,
    configurationFingerprint: "a".repeat(64),
    capabilities: {
      mode: "explicit_fact" as const,
      layers: ["L2"] as ["L2"],
      title: true as const,
      tags: true as const,
      maxContentChars: 50_000,
    },
    authMode: "none" as const,
    credentialRevision: "none" as const,
  };
  const sourceSelection = {
    kind: "full_message" as const,
    sourceMessageId: MESSAGE_ID,
    sourceMessageSha256,
  };
  const title = "Replay事实";
  const tags = ["replay"];
  const requestSha256 = computeMemoryImportRequestSha256({
    content: CONTENT,
    layer: "L2",
    title,
    tags,
    turnId: MESSAGE_ID,
  });
  snapshot.storeRevision = 1;
  snapshot.entities.sessions[SESSION_ID] = {
    schemaVersion: "product-session.v1",
    sessionId: SESSION_ID,
    ownerPrincipalId: "usr_importreplay1" as never,
    status: "active",
    lastMessageSequence: 1,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.messages[MESSAGE_ID] = message;
  snapshot.entities.memoryImportIntents[INTENT_ID] = {
    schemaVersion: "memory-import-intent.v1",
    memoryImportIntentId: INTENT_ID,
    requestedByPrincipalId: "usr_importreplay1" as never,
    sourceSelection,
    backendId: BACKEND_ID,
    backendDescriptor: descriptor,
    backendDescriptorSha256: computeMemoryImportBackendDescriptorSha256(descriptor),
    memoryLayer: "L2",
    title,
    tags,
    operationId: INTENT_ID,
    requestSha256,
    semanticDedupeSha256: computeMemoryImportSemanticDedupeSha256({
      requestedByPrincipalId: "usr_importreplay1",
      sourceSelection,
      backendId: BACKEND_ID,
      title,
      tags,
    }),
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.memoryImportResults[RESULT_ID] = result;
  snapshot.outbox[OUTBOX_START] = {
    schemaVersion: "outbox-entry.v1",
    outboxId: OUTBOX_START,
    kind: "memory_import_start",
    status: "acknowledged",
    memoryImportIntentId: INTENT_ID,
    memoryImportResultId: RESULT_ID,
    expectedResultRevision: 1,
    dispatchAttempts: 1,
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  };
  reconcileOutboxes.forEach((id, index) => {
    const outboxId = outboxEntryIdSchema.parse(id);
    snapshot.outbox[outboxId] = {
      schemaVersion: "outbox-entry.v1",
      outboxId,
      kind: "memory_import_reconcile",
      status: "acknowledged",
      memoryImportIntentId: INTENT_ID,
      memoryImportResultId: RESULT_ID,
      expectedResultRevision: 3 + index,
      dispatchAttempts: 1,
      revision: 2,
      createdAt: NOW,
      updatedAt: NOW,
    };
  });
  return productSnapshotSchema.parse(snapshot);
}

function writeInputs(dir: string, snapshot: ProductSnapshot) {
  const storePath = join(dir, "store.json");
  writeFileSync(storePath, JSON.stringify(snapshot), "utf8");
  const runtimeBindingsPath = join(dir, "bindings.json");
  const entries = Object.values(snapshot.outbox).filter(
    (entry) => entry.kind === "memory_import_start" || entry.kind === "memory_import_reconcile",
  );
  writeFileSync(
    runtimeBindingsPath,
    JSON.stringify({
      schemaVersion: "runtime-bindings.v2",
      startIntents: {},
      workflows: {},
      hooks: {},
      memoryImportStartIntents: {},
      memoryImportWorkflows: Object.fromEntries(
        entries.map((entry) => [
          entry.outboxId,
          {
            memoryImportIntentId: INTENT_ID,
            memoryImportResultId: RESULT_ID,
            mode: entry.kind === "memory_import_start" ? "import" : "reconcile",
            workflowRunId: `private-${entry.outboxId}`,
            workflowDefinitionVersion: "memory-import-workflow.v1",
            startDispatchState: "started",
            createdAt: NOW,
          },
        ]),
      ),
    }),
    "utf8",
  );
  return { storePath, runtimeBindingsPath, traceDir: join(dir, "traces") };
}

function traceBase(outboxId: string, revision: number) {
  const intent = fixtureBaseIntent();
  return {
    level: "info" as const,
    traceId: "tr_importreplay1",
    spanId: `sp_${outboxId.replaceAll("_", "")}${String(revision)}`,
    memoryImportIntentId: INTENT_ID,
    memoryImportResultId: RESULT_ID,
    outboxId: outboxEntryIdSchema.parse(outboxId),
    operationId: INTENT_ID,
    backendId: BACKEND_ID,
    requestSha256: intent.requestSha256,
    intentRevision: 1,
    resultRevision: revision,
  };
}

function fixtureBaseIntent() {
  const snapshot = fixture({
    schemaVersion: "memory-import-result.v1",
    memoryImportResultId: RESULT_ID,
    memoryImportIntentId: INTENT_ID,
    status: "queued",
    dispatchAttempts: 0,
    reconcileAttempts: 0,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return snapshot.entities.memoryImportIntents[INTENT_ID]!;
}

function emitCommon(traceDir: string) {
  const sink = createTraceSink({ dir: traceDir, now: () => new Date(NOW) });
  const intent = fixtureBaseIntent();
  sink.emit({
    ...traceBase(OUTBOX_START, 1),
    eventName: "memory.import.intent_created",
    outcome: "success",
    backendDescriptorSha256: intent.backendDescriptorSha256,
  } as TraceEventInput);
  sink.emit({
    ...traceBase(OUTBOX_START, 2),
    eventName: "memory.import.started",
    outcome: "unknown",
    dispatchAttempt: 1,
  } as TraceEventInput);
  return sink;
}

const readRuntimeEvidence = (input: {
  outbox: readonly {
    outboxId: string;
    kind: "memory_import_start" | "memory_import_reconcile";
  }[];
}) => ({
  status: "ok" as const,
  entries: input.outbox.map((entry) => ({
    outboxId: entry.outboxId,
    mode: entry.kind === "memory_import_start" ? ("import" as const) : ("reconcile" as const),
    state: "started" as const,
    workflowDefinitionVersion: "memory-import-workflow.v1",
  })),
});

describe("Memory Import Replay", () => {
  it("unknown经过第2次对账仍unknown时按attempt精确配对且默认不复制正文", () => {
    const dir = tempDir();
    const outboxes = ["obx_reconcile1", "obx_reconcile2"];
    const result: MemoryImportResult = {
      schemaVersion: "memory-import-result.v1",
      memoryImportResultId: RESULT_ID,
      memoryImportIntentId: INTENT_ID,
      status: "outcome_unknown",
      dispatchAttempts: 1,
      reconcileAttempts: 2,
      errorCode: "memory.import.verify_unavailable",
      unknownSince: NOW,
      lastReconciledAt: NOW,
      revision: 5,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const snapshot = fixture(result, outboxes);
    const files = writeInputs(dir, snapshot);
    const sink = emitCommon(files.traceDir);
    sink.emit({
      ...traceBase(OUTBOX_START, 3),
      eventName: "memory.import.outcome_unknown",
      outcome: "unknown",
      origin: "dispatch",
      attempt: 1,
      error: { code: "memory.import.connection_lost", type: "MemoryImportBackendError" },
      durationMs: 10,
    } as TraceEventInput);
    outboxes.forEach((outboxId, index) => {
      const attempt = index + 1;
      const revision = 3 + index;
      sink.emit({
        ...traceBase(outboxId, revision),
        eventName: "memory.import.reconcile.started",
        outcome: "unknown",
        reconcileAttempt: attempt,
      } as TraceEventInput);
      sink.emit({
        ...traceBase(outboxId, revision),
        level: "warn",
        eventName: "memory.import.reconcile.failed",
        outcome: "failure",
        reconcileAttempt: attempt,
        error: { code: "memory.import.verify_unavailable", type: "MemoryImportBackendError" },
        durationMs: 5,
      } as TraceEventInput);
      sink.emit({
        ...traceBase(outboxId, revision + 1),
        level: "warn",
        eventName: "memory.import.outcome_unknown",
        outcome: "unknown",
        origin: "reconcile",
        attempt,
        error: { code: "memory.import.verify_unavailable", type: "MemoryImportBackendError" },
        durationMs: 5,
      } as TraceEventInput);
    });
    const view = assembleMemoryImportReplay(
      { memoryImportIntentId: INTENT_ID, ...files },
      {
        snapshotIntegrityCheck: () => undefined,
        readMemoryImportRuntimeEvidence: readRuntimeEvidence,
      },
    );
    expect(view.failures).toEqual([]);
    expect(view.content).toEqual({ included: false });
    expect(JSON.stringify(view)).not.toContain(CONTENT);
  });

  it("unknown经对账accepted不要求伪造第二个write accepted事件", () => {
    const dir = tempDir();
    const outboxId = "obx_reconcile3";
    const externalObjectId = "memory-replay-accepted";
    const result: MemoryImportResult = {
      schemaVersion: "memory-import-result.v1",
      memoryImportResultId: RESULT_ID,
      memoryImportIntentId: INTENT_ID,
      status: "accepted",
      dispatchAttempts: 1,
      reconcileAttempts: 1,
      externalObjectId,
      responseSha256: "b".repeat(64),
      acceptedAt: NOW,
      revision: 4,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const files = writeInputs(dir, fixture(result, [outboxId]));
    const sink = emitCommon(files.traceDir);
    sink.emit({
      ...traceBase(OUTBOX_START, 3),
      level: "warn",
      eventName: "memory.import.outcome_unknown",
      outcome: "unknown",
      origin: "dispatch",
      attempt: 1,
      error: { code: "memory.import.connection_lost", type: "MemoryImportBackendError" },
      durationMs: 10,
    } as TraceEventInput);
    sink.emit({
      ...traceBase(outboxId, 3),
      eventName: "memory.import.reconcile.started",
      outcome: "unknown",
      reconcileAttempt: 1,
    } as TraceEventInput);
    sink.emit({
      ...traceBase(outboxId, 3),
      eventName: "memory.import.reconcile.completed",
      outcome: "success",
      resolution: "accepted",
      reconcileAttempt: 1,
      externalObjectIdSha256: sha256Hex(externalObjectId),
      durationMs: 5,
    } as TraceEventInput);
    const view = assembleMemoryImportReplay(
      { memoryImportIntentId: INTENT_ID, ...files },
      {
        snapshotIntegrityCheck: () => undefined,
        readMemoryImportRuntimeEvidence: readRuntimeEvidence,
      },
    );
    expect(view.failures).toEqual([]);
    expect(view.result.externalObjectIdSha256).toBe(sha256Hex(externalObjectId));
  });

  it("accepted经对账materialized并在授权后从Product Store组装正文", () => {
    const dir = tempDir();
    const outboxId = "obx_reconcile4";
    const externalObjectId = "memory-replay-materialized";
    const result: MemoryImportResult = {
      schemaVersion: "memory-import-result.v1",
      memoryImportResultId: RESULT_ID,
      memoryImportIntentId: INTENT_ID,
      status: "materialized",
      dispatchAttempts: 1,
      reconcileAttempts: 1,
      externalObjectId,
      responseSha256: "b".repeat(64),
      acceptedAt: NOW,
      materializedAt: NOW,
      verificationKind: "read_by_id_and_search",
      verificationSha256: "c".repeat(64),
      revision: 4,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const files = writeInputs(dir, fixture(result, [outboxId]));
    const sink = emitCommon(files.traceDir);
    sink.emit({
      ...traceBase(OUTBOX_START, 3),
      eventName: "memory.import.accepted",
      outcome: "success",
      dispatchAttempt: 1,
      externalObjectIdSha256: sha256Hex(externalObjectId),
      responseSha256: "b".repeat(64),
      durationMs: 10,
    } as TraceEventInput);
    sink.emit({
      ...traceBase(outboxId, 3),
      eventName: "memory.import.reconcile.started",
      outcome: "unknown",
      reconcileAttempt: 1,
    } as TraceEventInput);
    sink.emit({
      ...traceBase(outboxId, 3),
      eventName: "memory.import.reconcile.completed",
      outcome: "success",
      resolution: "materialized",
      reconcileAttempt: 1,
      externalObjectIdSha256: sha256Hex(externalObjectId),
      durationMs: 5,
    } as TraceEventInput);
    sink.emit({
      ...traceBase(outboxId, 4),
      eventName: "memory.import.materialized",
      outcome: "success",
      reconcileAttempt: 1,
      externalObjectIdSha256: sha256Hex(externalObjectId),
      verificationSha256: "c".repeat(64),
      durationMs: 1,
    } as TraceEventInput);
    const view = assembleMemoryImportReplay(
      {
        memoryImportIntentId: INTENT_ID,
        ...files,
        contentAccess: { mode: "authorized", principalId: "usr_importreplay1", purpose: "debug" },
      },
      {
        snapshotIntegrityCheck: () => undefined,
        authorizeContentAccess: () => true,
        readMemoryImportRuntimeEvidence: readRuntimeEvidence,
      },
    );
    expect(view.failures).toEqual([]);
    expect(view.content.included).toBe(true);
    if (view.content.included) expect(view.content.facts.selectedContent).toBe(CONTENT);
  });
});
