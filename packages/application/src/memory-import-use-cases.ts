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
  type OutboxEntryId,
  type PrincipalId,
  type Sha256,
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
  readonly backendKind: MemoryImportIntent["backendDescriptor"]["kind"];
  readonly content: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly turnId: string;
}): MemoryImportRequestShape {
  if (input.backendKind === "tencent_memorycore") {
    return {
      kind: "tencent_conversation_capture",
      content: input.content,
      layer: "L0",
      turnId: input.turnId,
    };
  }
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

/**
 * 创建导入的唯一产品事务：冻结来源选区、后端能力、请求Hash、初始Result与Outbox。
 * 外部Memory调用不在本事务内；commandId与语义Hash共同保证刷新/重复点击不会制造
 * 第二个Intent，真正的副作用由Workflow在dispatching栅栏之后执行。
 */
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
        if (!descriptor.capabilities.tags && input.payload.tags.length > 0) {
          throw new MemoryImportInvariantError(
            "memory.import.tags_unsupported",
            "所选Memory后端不支持标签",
          );
        }
        const tags = descriptor.capabilities.tags
          ? normalizeMemoryImportTags(input.payload.tags)
          : [];
        const normalizedRequest = requestShape({
          backendKind: descriptor.kind,
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
          memoryLayer: descriptor.capabilities.layers[0],
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
    memoryLayer: intent.memoryLayer,
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
    backendKind: intent.backendDescriptor.kind,
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
      content: source.content,
      layer: shape.layer,
      title: intent.title,
      tags: intent.tags,
      turnId: source.turnId,
      source: "chat.explicit_import",
      sessionId: source.sessionId as never,
    },
  };
}

interface ResultCommandBase {
  readonly commandId: CommandId;
  readonly memoryImportIntentId: MemoryImportIntentId;
  readonly memoryImportResultId: MemoryImportResultId;
  readonly requestSha256: Sha256;
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
      if (current.memoryImportIntentId !== input.memoryImportIntentId) {
        throw revisionConflict("Memory Import Result与Intent不匹配");
      }
      const intent = draft.entities.memoryImportIntents[input.memoryImportIntentId];
      if (intent === undefined || intent.requestSha256 !== input.requestSha256) {
        throw revisionConflict("Memory Import Intent请求Hash不匹配");
      }
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

/**
 * 提交“外部已接收”事实。重复对账可增加reconcileAttempts，但外部对象身份一经接受
 * 就不可改写；accepted不是materialized，也不会被终态监督器降级成结果未知。
 */
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
    if (
      current.status === "accepted" &&
      current.externalObjectId !== input.accepted.externalObjectId
    ) {
      throw revisionConflict("Memory Import外部对象身份不可改写");
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

/** 只有Adapter提供可重建的验证类型与Hash后，Application才允许进入materialized。 */
export function commitMemoryImportMaterialized(
  deps: ApplicationDeps,
  input: ResultCommandBase & {
    readonly accepted: MemoryImportAccepted;
    readonly verificationKind: "read_by_id_and_search" | "l0_and_session_l1";
    readonly verificationSha256: string;
    readonly reconciled?: boolean;
  },
): Promise<MemoryImportResult> {
  return updateResult(deps, "CommitMemoryImportMaterialized", input, (current, now) => {
    assertMemoryImportTransition(current, "materialized");
    if (
      current.status === "accepted" &&
      current.externalObjectId !== input.accepted.externalObjectId
    ) {
      throw revisionConflict("Memory Import外部对象身份不可改写");
    }
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
      verificationKind: input.verificationKind,
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
    return toMemoryImportOutcomeUnknown(current, now, input.errorCode, input.reconciled === true);
  });
}

function toMemoryImportOutcomeUnknown(
  current: MemoryImportResult,
  now: string,
  errorCode: string,
  reconciled: boolean,
): MemoryImportResult {
  if (current.status !== "outcome_unknown") {
    assertMemoryImportTransition(current, "outcome_unknown");
  }
  return {
    schemaVersion: current.schemaVersion,
    memoryImportResultId: current.memoryImportResultId,
    memoryImportIntentId: current.memoryImportIntentId,
    status: "outcome_unknown",
    dispatchAttempts: current.dispatchAttempts,
    reconcileAttempts: current.reconcileAttempts + (reconciled ? 1 : 0),
    errorCode,
    unknownSince: current.status === "outcome_unknown" ? current.unknownSince : now,
    ...(reconciled ? { lastReconciledAt: now } : {}),
    revision: current.revision + 1,
    createdAt: current.createdAt,
    updatedAt: now,
  };
}

/**
 * Runtime已证明某个Import Workflow终止，但产品结果仍未收敛时的恢复事务。
 * queued说明尚未越过mark栅栏，可重新启动普通import；其余非终态只能转为
 * outcome_unknown并创建reconcile，禁止再次执行普通add。
 */
export async function recoverMemoryImportAfterTerminalWorkflow(
  deps: ApplicationDeps,
  input: {
    readonly commandId: CommandId;
    readonly outboxId: OutboxEntryId;
    readonly errorCode: string;
  },
): Promise<void> {
  const now = deps.now();
  const recoveryOutboxId = deps.ids.outbox();
  let recoveredUnknown:
    | {
        intent: MemoryImportIntent;
        result: MemoryImportResult;
        sourceOutboxId: OutboxEntryId;
      }
    | undefined;
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "RecoverMemoryImportAfterTerminalWorkflow",
    requestSha256: hashCanonical("command.recover-memory-import-after-terminal-workflow.v1", input),
    mutate: (draft) => {
      const entry = draft.outbox[input.outboxId];
      if (
        entry === undefined ||
        (entry.kind !== "memory_import_start" && entry.kind !== "memory_import_reconcile")
      ) {
        throw notFound("Memory Import Outbox不存在");
      }
      const intent = draft.entities.memoryImportIntents[entry.memoryImportIntentId];
      const current = draft.entities.memoryImportResults[entry.memoryImportResultId];
      if (
        intent === undefined ||
        current === undefined ||
        current.memoryImportIntentId !== intent.memoryImportIntentId
      ) {
        throw revisionConflict("Memory Import Outbox绑定不完整");
      }
      if (entry.status !== "acknowledged") {
        return {
          resultRefs: {
            outboxId: entry.outboxId,
            memoryImportResultId: current.memoryImportResultId,
            recoveryOutboxId: entry.outboxId,
          },
        };
      }
      if (current.status === "materialized" || current.status === "failed") {
        return {
          resultRefs: {
            outboxId: entry.outboxId,
            memoryImportResultId: current.memoryImportResultId,
            recoveryOutboxId: entry.outboxId,
          },
        };
      }

      const nextResult =
        current.status === "queued" || current.status === "outcome_unknown"
          ? current
          : toMemoryImportOutcomeUnknown(current, now, input.errorCode, false);
      if (nextResult !== current) {
        draft.entities.memoryImportResults[nextResult.memoryImportResultId] = nextResult;
        recoveredUnknown = {
          intent,
          result: nextResult,
          sourceOutboxId: entry.outboxId,
        };
      }
      draft.outbox[entry.outboxId] = {
        ...entry,
        status: "failed_terminal",
        lastErrorCode: input.errorCode,
        revision: entry.revision + 1,
        updatedAt: now,
      };

      const recoveryKind =
        current.status === "queued" ? "memory_import_start" : "memory_import_reconcile";
      const existingRecovery = Object.values(draft.outbox).find(
        (candidate) =>
          candidate.outboxId !== entry.outboxId &&
          (candidate.kind === "memory_import_start" ||
            candidate.kind === "memory_import_reconcile") &&
          candidate.memoryImportResultId === current.memoryImportResultId &&
          candidate.expectedResultRevision === nextResult.revision &&
          ["pending", "dispatched", "acknowledged", "outcome_unknown"].includes(candidate.status),
      );
      if (existingRecovery === undefined) {
        draft.outbox[recoveryOutboxId] = {
          schemaVersion: "outbox-entry.v1",
          outboxId: recoveryOutboxId,
          kind: recoveryKind,
          status: "pending",
          memoryImportIntentId: intent.memoryImportIntentId,
          memoryImportResultId: current.memoryImportResultId,
          expectedResultRevision: nextResult.revision,
          dispatchAttempts: 0,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
      }
      return {
        resultRefs: {
          outboxId: entry.outboxId,
          memoryImportResultId: current.memoryImportResultId,
          recoveryOutboxId: existingRecovery?.outboxId ?? recoveryOutboxId,
        },
      };
    },
  });
  if (!transaction.replayed && recoveredUnknown !== undefined) {
    const { intent, result, sourceOutboxId } = recoveredUnknown;
    emitMemoryImportEvent(deps, intent.memoryImportIntentId, {
      level: "warn",
      eventName: "memory.import.outcome_unknown",
      outcome: "unknown",
      memoryImportIntentId: intent.memoryImportIntentId,
      memoryImportResultId: result.memoryImportResultId,
      outboxId: sourceOutboxId,
      operationId: intent.operationId,
      backendId: intent.backendId,
      requestSha256: intent.requestSha256,
      intentRevision: intent.revision,
      resultRevision: result.revision,
      origin: "recovery",
      attempt: Math.max(1, result.dispatchAttempts),
      error: { code: input.errorCode, type: "WorkflowTerminalError" },
      durationMs: 0,
    });
  }
}

/**
 * 用户主动对账只创建memory_import_reconcile Outbox；相同revision已有待处理Outbox时
 * 不重复创建。该命令永远不会创建普通import Outbox，因此不能绕过副作用幂等边界。
 */
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
          (entry.status === "pending" ||
            entry.status === "dispatched" ||
            entry.status === "outcome_unknown" ||
            (entry.status === "acknowledged" &&
              Date.parse(now) - Date.parse(entry.updatedAt) < 30_000)),
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
