import {
  memoryImportIntentIdSchema,
  memoryImportResultIdSchema,
  type CommandId,
  type CreateMemoryImportPayload,
  type MemoryImportDto,
  type MemoryImportIntent,
  type MemoryImportIntentId,
  type MemoryImportResult,
  type MemoryImportResultId,
  type PrincipalId,
} from "@chat/contracts";
import {
  assertMemoryImportTransition,
  computeMemoryImportBackendDescriptorSha256,
  computeMemoryImportRequestSha256,
  computeMemoryImportSemanticDedupeSha256,
  hashCanonical,
  MemoryImportInvariantError,
  normalizeMemoryImportTags,
  normalizeMemoryImportTitle,
  resolveMemoryImportContent,
  type MemoryImportRequestShape,
} from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { ApplicationError, forbidden, notFound, revisionConflict } from "./errors.js";
import type { MemoryImportAccepted, MemoryImportInput } from "./memory-import-ports.js";
import { emitMemoryImportEvent } from "./trace-helpers.js";

export interface CreateMemoryImportInput {
  readonly principalId: PrincipalId;
  readonly commandId: CommandId;
  readonly payload: CreateMemoryImportPayload;
}

function derivedIntentId(commandId: CommandId): MemoryImportIntentId {
  return memoryImportIntentIdSchema.parse(
    `mii_${hashCanonical("id.memory-import-intent.v1", { commandId }).slice(0, 32)}`,
  );
}

function derivedResultId(intentId: MemoryImportIntentId): MemoryImportResultId {
  return memoryImportResultIdSchema.parse(
    `mir_${hashCanonical("id.memory-import-result.v1", { intentId }).slice(0, 32)}`,
  );
}

function sourceContent(
  snapshot: Parameters<Parameters<ApplicationDeps["store"]["transact"]>[0]["mutate"]>[0],
  intent: MemoryImportIntent,
): { content: string; sessionId: string; turnId: string } {
  const message = snapshot.entities.messages[intent.sourceSelection.sourceMessageId];
  if (message === undefined) throw notFound("导入来源Message不存在");
  const content = resolveMemoryImportContent({
    message,
    selection: intent.sourceSelection,
    maxContentChars: intent.backendDescriptor.capabilities.maxContentChars,
  });
  return { content, sessionId: message.sessionId, turnId: message.messageId };
}

function requestShape(input: {
  readonly content: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly turnId: string;
}): MemoryImportRequestShape {
  return {
    content: input.content,
    layer: "L2",
    title: input.title,
    tags: input.tags,
    turnId: input.turnId,
  };
}

function mapInvariantError(error: unknown): never {
  if (error instanceof MemoryImportInvariantError) {
    throw new ApplicationError({
      code: "memory_import_source_invalid",
      httpStatus: 422,
      message: error.message,
      recoveryAction: "rehydrate_and_retry",
    });
  }
  throw error;
}

export async function createMemoryImport(
  deps: ApplicationDeps,
  input: CreateMemoryImportInput,
): Promise<{ memoryImport: MemoryImportDto }> {
  const backend = deps.memoryImportBackends?.get(input.payload.backendId);
  if (backend === undefined) {
    throw new ApplicationError({
      code: "memory_import_backend_unavailable",
      httpStatus: 409,
      message: "Memory后端未配置或不支持导入",
      recoveryAction: "rehydrate_and_retry",
    });
  }
  const descriptor = backend.describeImport().descriptor;
  if (!descriptor.configured) {
    throw new ApplicationError({
      code: "memory_import_backend_unavailable",
      httpStatus: 409,
      message: "Memory后端尚未配置",
      recoveryAction: "rehydrate_and_retry",
    });
  }

  const now = deps.now();
  const candidateIntentId = derivedIntentId(input.commandId);
  const candidateResultId = derivedResultId(candidateIntentId);
  const outboxId = deps.ids.outbox();
  const requestSha256 = hashCanonical("command.create-memory-import.v1", {
    principalId: input.principalId,
    payload: input.payload,
  });

  const transaction = deps.store
    .transact({
      commandId: input.commandId,
      commandType: "CreateMemoryImport",
      requestSha256,
      mutate: (draft) => {
        const message = draft.entities.messages[input.payload.sourceSelection.sourceMessageId];
        if (message === undefined) throw notFound("导入来源Message不存在");
        const session = draft.entities.sessions[message.sessionId];
        if (session === undefined) throw notFound("导入来源Session不存在");
        if (session.ownerPrincipalId !== input.principalId) {
          throw forbidden("无权导入该Message");
        }
        const content = resolveMemoryImportContent({
          message,
          selection: input.payload.sourceSelection,
          maxContentChars: descriptor.capabilities.maxContentChars,
        });
        const title = normalizeMemoryImportTitle(input.payload.title);
        const tags = normalizeMemoryImportTags(input.payload.tags);
        const normalizedRequest = requestShape({
          content,
          title,
          tags,
          turnId: message.messageId,
        });
        const semanticDedupeSha256 = computeMemoryImportSemanticDedupeSha256({
          requestedByPrincipalId: input.principalId,
          sourceSelection: input.payload.sourceSelection,
          backendId: input.payload.backendId,
          title,
          tags,
        });
        const existingIntent = Object.values(draft.entities.memoryImportIntents).find(
          (candidate) => {
            if (candidate.semanticDedupeSha256 !== semanticDedupeSha256) return false;
            const result = Object.values(draft.entities.memoryImportResults).find(
              (item) => item.memoryImportIntentId === candidate.memoryImportIntentId,
            );
            return result?.status !== "failed";
          },
        );
        if (existingIntent !== undefined) {
          const existingResult = Object.values(draft.entities.memoryImportResults).find(
            (candidate) => candidate.memoryImportIntentId === existingIntent.memoryImportIntentId,
          );
          if (existingResult === undefined) throw notFound("Memory Import Result不存在");
          return {
            resultRefs: {
              memoryImportIntentId: existingIntent.memoryImportIntentId,
              memoryImportResultId: existingResult.memoryImportResultId,
            },
          };
        }

        const intent: MemoryImportIntent = {
          schemaVersion: "memory-import-intent.v1",
          memoryImportIntentId: candidateIntentId,
          requestedByPrincipalId: input.principalId,
          sourceSelection: input.payload.sourceSelection,
          backendId: input.payload.backendId,
          backendDescriptor: descriptor,
          backendDescriptorSha256: computeMemoryImportBackendDescriptorSha256(descriptor),
          memoryLayer: "L2",
          title,
          tags,
          operationId: candidateIntentId,
          requestSha256: computeMemoryImportRequestSha256(normalizedRequest),
          semanticDedupeSha256,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        const result: MemoryImportResult = {
          schemaVersion: "memory-import-result.v1",
          memoryImportResultId: candidateResultId,
          memoryImportIntentId: candidateIntentId,
          status: "queued",
          dispatchAttempts: 0,
          reconcileAttempts: 0,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        draft.entities.memoryImportIntents[candidateIntentId] = intent;
        draft.entities.memoryImportResults[candidateResultId] = result;
        draft.outbox[outboxId] = {
          schemaVersion: "outbox-entry.v1",
          outboxId,
          kind: "memory_import_start",
          status: "pending",
          memoryImportIntentId: candidateIntentId,
          memoryImportResultId: candidateResultId,
          expectedResultRevision: 1,
          dispatchAttempts: 0,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        return {
          resultRefs: {
            memoryImportIntentId: candidateIntentId,
            memoryImportResultId: candidateResultId,
          },
        };
      },
    })
    .catch(mapInvariantError);
  const result = await transaction;
  if (!result.replayed && result.resultRefs["memoryImportIntentId"] === candidateIntentId) {
    const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    const intent = snapshot.entities.memoryImportIntents[candidateIntentId];
    const importResult = snapshot.entities.memoryImportResults[candidateResultId];
    if (intent !== undefined && importResult !== undefined) {
      emitMemoryImportEvent(deps, intent.memoryImportIntentId, {
        level: "info",
        eventName: "memory.import.intent_created",
        outcome: "success",
        memoryImportIntentId: intent.memoryImportIntentId,
        memoryImportResultId: importResult.memoryImportResultId,
        outboxId,
        operationId: intent.operationId,
        backendId: intent.backendId,
        requestSha256: intent.requestSha256,
        intentRevision: intent.revision,
        resultRevision: importResult.revision,
        backendDescriptorSha256: intent.backendDescriptorSha256,
      });
    }
  }
  return {
    memoryImport: await getMemoryImport(deps, {
      principalId: input.principalId,
      memoryImportIntentId: memoryImportIntentIdSchema.parse(
        result.resultRefs["memoryImportIntentId"],
      ),
    }),
  };
}

function preview(content: string): string {
  return content.length <= 500 ? content : `${content.slice(0, 499)}…`;
}

function toMemoryImportDto(
  snapshot: Parameters<Parameters<ApplicationDeps["store"]["transact"]>[0]["mutate"]>[0],
  intent: MemoryImportIntent,
  result: MemoryImportResult,
  now: string,
): MemoryImportDto {
  const source = sourceContent(snapshot, intent);
  const base = {
    schemaVersion: "chat-product-api.v1" as const,
    memoryImportIntentId: intent.memoryImportIntentId,
    memoryImportResultId: result.memoryImportResultId,
    sessionId: source.sessionId as never,
    sourceMessageId: intent.sourceSelection.sourceMessageId,
    selectionKind: intent.sourceSelection.kind,
    sourcePreview: preview(source.content),
    backendId: intent.backendId,
    backendDisplayName: intent.backendDescriptor.displayName,
    memoryLayer: "L2" as const,
    title: intent.title,
    tags: intent.tags,
    resultRevision: result.revision,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
  };
  switch (result.status) {
    case "queued":
      return { ...base, status: result.status, allowedActions: [] };
    case "dispatching": {
      const stale = Date.parse(now) - Date.parse(result.dispatchStartedAt) >= 30_000;
      return {
        ...base,
        status: result.status,
        allowedActions: stale ? ["reconcile"] : [],
      };
    }
    case "accepted":
      return {
        ...base,
        status: result.status,
        externalObjectId: result.externalObjectId,
        allowedActions: ["reconcile"],
      };
    case "materialized":
      return {
        ...base,
        status: result.status,
        externalObjectId: result.externalObjectId,
        allowedActions: [],
      };
    case "failed":
      return {
        ...base,
        status: result.status,
        errorCode: result.errorCode,
        summary: result.summary,
        allowedActions: [],
      };
    case "outcome_unknown":
      return {
        ...base,
        status: result.status,
        errorCode: result.errorCode,
        allowedActions: ["reconcile"],
      };
  }
}

export async function getMemoryImport(
  deps: ApplicationDeps,
  input: { principalId: PrincipalId; memoryImportIntentId: MemoryImportIntentId },
): Promise<MemoryImportDto> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const intent = snapshot.entities.memoryImportIntents[input.memoryImportIntentId];
  if (intent === undefined) throw notFound("Memory Import不存在");
  if (intent.requestedByPrincipalId !== input.principalId)
    throw forbidden("无权读取该Memory Import");
  const result = Object.values(snapshot.entities.memoryImportResults).find(
    (candidate) => candidate.memoryImportIntentId === intent.memoryImportIntentId,
  );
  if (result === undefined) throw notFound("Memory Import Result不存在");
  return toMemoryImportDto(snapshot, intent, result, deps.now());
}

export async function listSessionMemoryImports(
  deps: ApplicationDeps,
  input: {
    principalId: PrincipalId;
    sessionId: string;
    limit?: number;
    cursor?: MemoryImportIntentId;
  },
): Promise<{ memoryImports: MemoryImportDto[]; nextCursor?: MemoryImportIntentId }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const session = snapshot.entities.sessions[input.sessionId];
  if (session === undefined) throw notFound("Session不存在");
  if (session.ownerPrincipalId !== input.principalId) throw forbidden("无权读取该Session");
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: "Memory Import列表limit必须是1到100的整数",
    });
  }
  const ordered = Object.values(snapshot.entities.memoryImportIntents)
    .filter((intent) => {
      const message = snapshot.entities.messages[intent.sourceSelection.sourceMessageId];
      return message?.sessionId === session.sessionId;
    })
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) ||
        b.memoryImportIntentId.localeCompare(a.memoryImportIntentId),
    );
  const cursorIndex =
    input.cursor === undefined
      ? -1
      : ordered.findIndex((intent) => intent.memoryImportIntentId === input.cursor);
  if (input.cursor !== undefined && cursorIndex < 0) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: "Memory Import分页cursor无效",
    });
  }
  const intents = ordered.slice(cursorIndex + 1, cursorIndex + 1 + limit);
  const hasMore = cursorIndex + 1 + intents.length < ordered.length;
  return {
    memoryImports: intents.map((intent) => {
      const result = Object.values(snapshot.entities.memoryImportResults).find(
        (candidate) => candidate.memoryImportIntentId === intent.memoryImportIntentId,
      );
      if (result === undefined) throw notFound("Memory Import Result不存在");
      return toMemoryImportDto(snapshot, intent, result, deps.now());
    }),
    ...(hasMore && intents.at(-1) !== undefined
      ? { nextCursor: intents.at(-1)!.memoryImportIntentId }
      : {}),
  };
}

export interface LoadedMemoryImport {
  readonly intent: MemoryImportIntent;
  readonly result: MemoryImportResult;
  readonly adapterInput: MemoryImportInput;
}

export async function loadMemoryImportForRuntime(
  deps: ApplicationDeps,
  input: {
    memoryImportIntentId: MemoryImportIntentId;
    memoryImportResultId: MemoryImportResultId;
  },
): Promise<LoadedMemoryImport> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const intent = snapshot.entities.memoryImportIntents[input.memoryImportIntentId];
  const result = snapshot.entities.memoryImportResults[input.memoryImportResultId];
  if (intent === undefined || result === undefined) throw notFound("Memory Import不存在");
  if (result.memoryImportIntentId !== intent.memoryImportIntentId) {
    throw revisionConflict("Memory Import Intent/Result不一致");
  }
  const source = sourceContent(snapshot, intent);
  const shape = requestShape({
    content: source.content,
    title: intent.title,
    tags: intent.tags,
    turnId: source.turnId,
  });
  if (computeMemoryImportRequestSha256(shape) !== intent.requestSha256) {
    throw revisionConflict("Memory Import请求Hash不一致");
  }
  return {
    intent,
    result,
    adapterInput: {
      operationId: intent.operationId,
      requestSha256: intent.requestSha256,
      ...shape,
      source: "chat.explicit_import",
      sessionId: source.sessionId as never,
    },
  };
}

interface ResultCommandBase {
  readonly commandId: CommandId;
  readonly memoryImportResultId: MemoryImportResultId;
  readonly expectedRevision: number;
}

async function updateResult(
  deps: ApplicationDeps,
  commandType: string,
  input: ResultCommandBase,
  update: (current: MemoryImportResult, now: string) => MemoryImportResult,
): Promise<MemoryImportResult> {
  const now = deps.now();
  const commandDomain = commandType.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").toLowerCase();
  const requestSha256 = hashCanonical(`command.${commandDomain}.v1`, input);
  await deps.store.transact({
    commandId: input.commandId,
    commandType,
    requestSha256,
    mutate: (draft) => {
      const current = draft.entities.memoryImportResults[input.memoryImportResultId];
      if (current === undefined) throw notFound("Memory Import Result不存在");
      if (current.revision !== input.expectedRevision) {
        throw revisionConflict("Memory Import Result revision已变化");
      }
      const next = update(current, now);
      draft.entities.memoryImportResults[input.memoryImportResultId] = next;
      return { resultRefs: { memoryImportResultId: next.memoryImportResultId } };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const result = snapshot.entities.memoryImportResults[input.memoryImportResultId];
  if (result === undefined) throw notFound("Memory Import Result不存在");
  return result;
}

export function markMemoryImportDispatching(
  deps: ApplicationDeps,
  input: ResultCommandBase,
): Promise<MemoryImportResult> {
  return updateResult(deps, "MarkMemoryImportDispatching", input, (current, now) => {
    assertMemoryImportTransition(current, "dispatching");
    return {
      ...current,
      status: "dispatching",
      dispatchStartedAt: now,
      dispatchAttempts: current.dispatchAttempts + 1,
      revision: current.revision + 1,
      updatedAt: now,
    };
  });
}

export function commitMemoryImportAccepted(
  deps: ApplicationDeps,
  input: ResultCommandBase & {
    readonly accepted: MemoryImportAccepted;
    readonly reconciled?: boolean;
  },
): Promise<MemoryImportResult> {
  return updateResult(deps, "CommitMemoryImportAccepted", input, (current, now) => {
    if (!(current.status === "accepted" && input.reconciled === true)) {
      assertMemoryImportTransition(current, "accepted");
    }
    return {
      schemaVersion: current.schemaVersion,
      memoryImportResultId: current.memoryImportResultId,
      memoryImportIntentId: current.memoryImportIntentId,
      status: "accepted",
      dispatchAttempts: current.dispatchAttempts,
      reconcileAttempts: current.reconcileAttempts + (input.reconciled === true ? 1 : 0),
      ...input.accepted,
      acceptedAt: current.status === "accepted" ? current.acceptedAt : now,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: now,
    };
  });
}

export function commitMemoryImportMaterialized(
  deps: ApplicationDeps,
  input: ResultCommandBase & {
    readonly accepted: MemoryImportAccepted;
    readonly verificationSha256: string;
    readonly reconciled?: boolean;
  },
): Promise<MemoryImportResult> {
  return updateResult(deps, "CommitMemoryImportMaterialized", input, (current, now) => {
    assertMemoryImportTransition(current, "materialized");
    return {
      schemaVersion: current.schemaVersion,
      memoryImportResultId: current.memoryImportResultId,
      memoryImportIntentId: current.memoryImportIntentId,
      status: "materialized",
      dispatchAttempts: current.dispatchAttempts,
      reconcileAttempts: current.reconcileAttempts + (input.reconciled === true ? 1 : 0),
      ...input.accepted,
      acceptedAt: current.status === "accepted" ? current.acceptedAt : now,
      materializedAt: now,
      verificationKind: "read_by_id_and_search",
      verificationSha256: input.verificationSha256 as never,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: now,
    };
  });
}

export function commitMemoryImportFailed(
  deps: ApplicationDeps,
  input: ResultCommandBase & {
    readonly errorCode: string;
    readonly summary: string;
    readonly reconciled?: boolean;
  },
): Promise<MemoryImportResult> {
  return updateResult(deps, "CommitMemoryImportFailed", input, (current, now) => {
    assertMemoryImportTransition(current, "failed");
    return {
      schemaVersion: current.schemaVersion,
      memoryImportResultId: current.memoryImportResultId,
      memoryImportIntentId: current.memoryImportIntentId,
      status: "failed",
      dispatchAttempts: current.dispatchAttempts,
      reconcileAttempts: current.reconcileAttempts + (input.reconciled === true ? 1 : 0),
      errorCode: input.errorCode,
      summary: input.summary,
      failedAt: now,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: now,
    };
  });
}

export function commitMemoryImportOutcomeUnknown(
  deps: ApplicationDeps,
  input: ResultCommandBase & { readonly errorCode: string; readonly reconciled?: boolean },
): Promise<MemoryImportResult> {
  return updateResult(deps, "CommitMemoryImportOutcomeUnknown", input, (current, now) => {
    if (current.status !== "outcome_unknown") {
      assertMemoryImportTransition(current, "outcome_unknown");
    }
    return {
      schemaVersion: current.schemaVersion,
      memoryImportResultId: current.memoryImportResultId,
      memoryImportIntentId: current.memoryImportIntentId,
      status: "outcome_unknown",
      dispatchAttempts: current.dispatchAttempts,
      reconcileAttempts: current.reconcileAttempts + (input.reconciled === true ? 1 : 0),
      errorCode: input.errorCode,
      unknownSince: current.status === "outcome_unknown" ? current.unknownSince : now,
      ...(input.reconciled === true ? { lastReconciledAt: now } : {}),
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: now,
    };
  });
}

export async function requestMemoryImportReconciliation(
  deps: ApplicationDeps,
  input: {
    principalId: PrincipalId;
    commandId: CommandId;
    memoryImportIntentId: MemoryImportIntentId;
    expectedResultRevision: number;
  },
): Promise<{ memoryImport: MemoryImportDto }> {
  const now = deps.now();
  const outboxId = deps.ids.outbox();
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "RequestMemoryImportReconciliation",
    requestSha256: hashCanonical("command.request-memory-import-reconciliation.v1", input),
    mutate: (draft) => {
      const intent = draft.entities.memoryImportIntents[input.memoryImportIntentId];
      if (intent === undefined) throw notFound("Memory Import不存在");
      if (intent.requestedByPrincipalId !== input.principalId) throw forbidden("无权对账");
      const result = Object.values(draft.entities.memoryImportResults).find(
        (candidate) => candidate.memoryImportIntentId === intent.memoryImportIntentId,
      );
      if (result === undefined) throw notFound("Memory Import Result不存在");
      if (result.revision !== input.expectedResultRevision) {
        throw revisionConflict("Memory Import Result revision已变化");
      }
      if (!["dispatching", "accepted", "outcome_unknown"].includes(result.status)) {
        throw revisionConflict("只有待确认结果的Memory Import可以人工对账");
      }
      if (
        result.status === "dispatching" &&
        Date.parse(now) - Date.parse(result.dispatchStartedAt) < 30_000
      ) {
        throw revisionConflict("Memory Import仍在执行，请稍后再对账");
      }
      const pending = Object.values(draft.outbox).some(
        (entry) =>
          entry.kind === "memory_import_reconcile" &&
          entry.memoryImportIntentId === intent.memoryImportIntentId &&
          entry.expectedResultRevision === result.revision &&
          entry.status !== "failed_terminal",
      );
      if (!pending) {
        draft.outbox[outboxId] = {
          schemaVersion: "outbox-entry.v1",
          outboxId,
          kind: "memory_import_reconcile",
          status: "pending",
          memoryImportIntentId: intent.memoryImportIntentId,
          memoryImportResultId: result.memoryImportResultId,
          expectedResultRevision: result.revision,
          dispatchAttempts: 0,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
      }
      return {
        resultRefs: {
          memoryImportIntentId: intent.memoryImportIntentId,
          memoryImportResultId: result.memoryImportResultId,
        },
      };
    },
  });
  return {
    memoryImport: await getMemoryImport(deps, {
      principalId: input.principalId,
      memoryImportIntentId: input.memoryImportIntentId,
    }),
  };
}
