import {
  INTERNAL_RUNTIME_SCHEMA_VERSION,
  beginWorkflowMemoryWriteResponseSchema,
  memoryWriteIntentIdSchema,
  memoryWriteIntentSchema,
  memoryWriteResultIdSchema,
  memoryWriteResultSchema,
  workflowMemoryWriteNodeConfigSchema,
  workflowMemoryWriteNodeConfigV2Schema,
  type BeginWorkflowMemoryWriteRequest,
  type BeginWorkflowMemoryWriteResponse,
  type CommandId,
  type CreateMemoryWritePayload,
  type MemoryWriteDto,
  type MemoryWriteIntent,
  type MemoryWriteIntentId,
  type MemoryWriteResult,
  type MemoryWriteResultId,
  type MessageId,
  type OutboxEntryId,
  type PrincipalId,
  type ProductSessionId,
} from "@chat/contracts";
import {
  assertMemoryWriteTransition,
  computeMemoryProviderDescriptorSha256,
  computeMemoryWriteRequestSha256,
  computeMemoryWriteSemanticDedupeSha256,
  computeMemoryWriteImportRequestSha256,
  computeMemoryWriteAgentCandidateRequestSha256,
  computeWorkflowMemoryMessageSha256,
  hashCanonical,
  resolveMemoryWriteContent,
  resolveMemoryWriteImportContent,
  resolveMemoryWriteAgentCandidateContent,
  sha256Hex,
  WorkflowMemoryInvariantError,
} from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { ApplicationError, forbidden, notFound, revisionConflict } from "./errors.js";
import { requireWorkflowMemoryRun } from "./product-run-kind.js";
import { validateWorkflowRunSpecIntegrity } from "./workflow-run-spec-compiler.js";
import type {
  WorkflowMemoryWriteAccepted,
  WorkflowMemoryWriteInput,
} from "./workflow-memory-ports.js";

export interface CreateMemoryWriteInput {
  readonly principalId: PrincipalId;
  readonly commandId: CommandId;
  readonly payload: CreateMemoryWritePayload;
  /** 公开Write Command由Outbox启动独立Workflow；Planning节点由当前Workflow唯一执行。 */
  readonly dispatchOwner?: "outbox" | "current_workflow";
}

function derivedIntentId(commandId: CommandId): MemoryWriteIntentId {
  return memoryWriteIntentIdSchema.parse(
    `mwi_${hashCanonical("id.memory-write-intent.v1", { commandId }).slice(0, 32)}`,
  );
}

function derivedResultId(intentId: MemoryWriteIntentId): MemoryWriteResultId {
  return memoryWriteResultIdSchema.parse(
    `mwr_${hashCanonical("id.memory-write-result.v1", { intentId }).slice(0, 32)}`,
  );
}

function mapInvariant(error: unknown): never {
  if (error instanceof WorkflowMemoryInvariantError) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 422,
      message: error.message,
      recoveryAction: "rehydrate_and_retry",
    });
  }
  throw error;
}

function toDto(
  snapshot: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"],
  intent: MemoryWriteIntent,
  result: MemoryWriteResult,
): MemoryWriteDto {
  if (result.memoryWriteIntentId !== intent.memoryWriteIntentId) {
    throw revisionConflict("Memory Write Intent/Result绑定无效");
  }
  const base = {
    memoryWriteIntentId: intent.memoryWriteIntentId,
    memoryWriteResultId: result.memoryWriteResultId,
    providerId: intent.providerId,
    result,
    canReconcile:
      intent.providerDescriptor.capabilities.reconcile &&
      ["dispatching", "accepted", "outcome_unknown"].includes(result.status) &&
      !Object.values(snapshot.outbox).some(
        (entry) =>
          entry.kind === "memory_write_reconcile" &&
          entry.memoryWriteIntentId === intent.memoryWriteIntentId &&
          ["pending", "dispatched", "outcome_unknown"].includes(entry.status),
      ),
  };
  return intent.schemaVersion === "memory-write-intent.v1"
    ? {
        ...base,
        productSessionId: intent.productSessionId,
        sourceSelection: intent.sourceSelection,
      }
    : intent.schemaVersion === "memory-write-intent.v2"
      ? { ...base, sourceSelection: intent.sourceSelection }
      : {
          ...base,
          productSessionId: intent.productSessionId,
          sourceSelection: intent.sourceSelection,
        };
}

/** 创建写入意图、初始Result与Outbox的唯一产品事务；此处绝不调用Provider。 */
export async function createMemoryWrite(
  deps: ApplicationDeps,
  input: CreateMemoryWriteInput,
): Promise<{ readonly memoryWrite: MemoryWriteDto }> {
  const dispatchOwner = input.dispatchOwner ?? "outbox";
  const provider = deps.workflowMemoryProviders?.getWrite(input.payload.providerId);
  if (provider === undefined) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 409,
      message: "Memory Provider未配置或不支持写入",
      recoveryAction: "rehydrate_and_retry",
    });
  }
  const descriptor = provider.describeProvider();
  const capability = descriptor.capabilities.write;
  if (
    descriptor.providerId !== input.payload.providerId ||
    !descriptor.configured ||
    capability === null
  ) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 409,
      message: "Memory Provider尚未就绪",
      recoveryAction: "rehydrate_and_retry",
    });
  }
  const candidateIntentId = derivedIntentId(input.commandId);
  const candidateResultId = derivedResultId(candidateIntentId);
  const outboxId = dispatchOwner === "outbox" ? deps.ids.outbox() : undefined;
  const now = deps.now();
  const transaction = await deps.store
    .transact({
      commandId: input.commandId,
      commandType: "CreateMemoryWrite",
      requestSha256: hashCanonical("command.create-memory-write.v1", {
        principalId: input.principalId,
        payload: input.payload,
        dispatchOwner,
      }),
      mutate: (draft) => {
        const session = draft.entities.sessions[input.payload.productSessionId];
        const message = draft.entities.messages[input.payload.sourceSelection.sourceMessageId];
        if (session === undefined || message === undefined) {
          throw notFound("Memory写入来源Session或Message不存在");
        }
        if (
          session.ownerPrincipalId !== input.principalId ||
          message.sessionId !== session.sessionId
        ) {
          throw forbidden("无权写入该Message");
        }
        if (session.revision !== input.payload.expectedSessionRevision) {
          throw revisionConflict("Session revision已变化，请刷新后重试");
        }
        const content = resolveMemoryWriteContent({
          message,
          selection: input.payload.sourceSelection,
          maxContentCharacters: capability.maxContentCharacters,
        });
        const semanticDedupeSha256 = computeMemoryWriteSemanticDedupeSha256({
          requestedByPrincipalId: input.principalId,
          productSessionId: session.sessionId,
          providerId: input.payload.providerId,
          sourceSelection: input.payload.sourceSelection,
        });
        const existingIntent = Object.values(draft.entities.memoryWriteIntents).find(
          (candidate) => candidate.semanticDedupeSha256 === semanticDedupeSha256,
        );
        if (existingIntent !== undefined) {
          const existingResult = Object.values(draft.entities.memoryWriteResults).find(
            (candidate) => candidate.memoryWriteIntentId === existingIntent.memoryWriteIntentId,
          );
          if (existingResult === undefined) throw notFound("Memory Write Result不存在");
          return {
            resultRefs: {
              memoryWriteIntentId: existingIntent.memoryWriteIntentId,
              memoryWriteResultId: existingResult.memoryWriteResultId,
            },
          };
        }
        const providerDescriptorSha256 = computeMemoryProviderDescriptorSha256(descriptor);
        const intent = memoryWriteIntentSchema.parse({
          schemaVersion: "memory-write-intent.v1",
          memoryWriteIntentId: candidateIntentId,
          operationId: candidateIntentId,
          requestedByPrincipalId: input.principalId,
          productSessionId: session.sessionId,
          sourceSelection: input.payload.sourceSelection,
          contentType: "conversation_turn",
          providerId: input.payload.providerId,
          providerDescriptor: descriptor,
          providerDescriptorSha256,
          requestSha256: computeMemoryWriteRequestSha256({
            operationId: candidateIntentId,
            providerDescriptorSha256,
            contentType: "conversation_turn",
            sourceSelection: input.payload.sourceSelection,
            contentSha256: sha256Hex(content),
          }),
          semanticDedupeSha256,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
        const result = memoryWriteResultSchema.parse({
          schemaVersion: "memory-write-result.v1",
          memoryWriteResultId: candidateResultId,
          memoryWriteIntentId: candidateIntentId,
          status: "queued",
          dispatchAttempts: 0,
          reconcileAttempts: 0,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
        draft.entities.memoryWriteIntents[candidateIntentId] = intent;
        draft.entities.memoryWriteResults[candidateResultId] = result;
        if (outboxId !== undefined) {
          draft.outbox[outboxId] = {
            schemaVersion: "outbox-entry.v1",
            outboxId,
            kind: "memory_write_start",
            status: "pending",
            memoryWriteIntentId: candidateIntentId,
            memoryWriteResultId: candidateResultId,
            expectedResultRevision: result.revision,
            dispatchAttempts: 0,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          };
        }
        return {
          resultRefs: {
            memoryWriteIntentId: candidateIntentId,
            memoryWriteResultId: candidateResultId,
          },
        };
      },
    })
    .catch(mapInvariant);
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const intent =
    snapshot.entities.memoryWriteIntents[transaction.resultRefs["memoryWriteIntentId"] ?? ""];
  const result =
    snapshot.entities.memoryWriteResults[transaction.resultRefs["memoryWriteResultId"] ?? ""];
  if (intent === undefined || result === undefined) throw notFound("Memory Write不存在");
  return { memoryWrite: toDto(snapshot, intent, result) };
}

/**
 * 独立Memory Planning中的write节点只从冻结RunSpec和来源Message派生写入意图。
 * 普通Planning没有该节点，因此不会隐式产生任何Memory外部副作用。
 */
export async function beginWorkflowMemoryWrite(
  deps: ApplicationDeps,
  input: Omit<BeginWorkflowMemoryWriteRequest, "schemaVersion">,
): Promise<BeginWorkflowMemoryWriteResponse> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const run = snapshot.entities.runs[input.productRunId];
  if (run === undefined) throw notFound("Product Run不存在");
  const memoryRun = requireWorkflowMemoryRun(run);
  const runSpec = snapshot.entities.workflowRunSpecs[input.workflowRunSpecId];
  const validated = runSpec === undefined ? undefined : validateWorkflowRunSpecIntegrity(runSpec);
  if (
    memoryRun.workflowRunSpecId !== input.workflowRunSpecId ||
    validated === undefined ||
    !validated.success
  ) {
    throw revisionConflict("Workflow Memory Write的Run/RunSpec绑定无效");
  }
  const node = validated.runSpec.nodeResolutions.find(
    (candidate) => candidate.definitionNodeId === input.definitionNodeId,
  );
  if (node?.nodeType !== "memory.write" || node.activation === "skipped") {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 422,
      message: "指定节点不是可执行的memory.write节点",
    });
  }
  const configSchema =
    node.schemaVersion === 1
      ? workflowMemoryWriteNodeConfigSchema
      : node.schemaVersion === 2
        ? workflowMemoryWriteNodeConfigV2Schema
        : undefined;
  const config = configSchema?.safeParse(node.config);
  if (config === undefined || !config.success) {
    throw new ApplicationError({
      code: "store_corrupted",
      httpStatus: 500,
      message: "memory.write冻结配置损坏",
      recoveryAction: "contact_support",
    });
  }
  const session = snapshot.entities.sessions[memoryRun.sessionId];
  const message = snapshot.entities.messages[memoryRun.sourceMessageId];
  if (session === undefined || message === undefined) {
    throw revisionConflict("Workflow Memory Write来源消息不存在");
  }
  const created = await createMemoryWrite(deps, {
    principalId: session.ownerPrincipalId,
    commandId: input.commandId,
    dispatchOwner: "current_workflow",
    payload: {
      productSessionId: session.sessionId,
      providerId: config.data.providerId,
      sourceSelection: {
        kind: "full_message",
        sourceMessageId: message.messageId,
        sourceMessageSha256: computeWorkflowMemoryMessageSha256(message),
      },
      expectedSessionRevision: session.revision,
    },
  });
  const loaded = await loadMemoryWriteForRuntime(deps, {
    memoryWriteIntentId: created.memoryWrite.memoryWriteIntentId,
    memoryWriteResultId: created.memoryWrite.memoryWriteResultId,
  });
  const { snapshot: afterCreate } = await deps.store.read({ kind: "committedSnapshot" });
  const competingOutbox = memoryWriteOutboxForIntent(
    afterCreate,
    created.memoryWrite.memoryWriteIntentId,
  ).find(({ entry }) => ["pending", "dispatched", "outcome_unknown"].includes(entry.status));
  if (competingOutbox !== undefined && loaded.result.status === "queued") {
    throw revisionConflict("该Memory写入已由独立Workflow接管，当前Planning节点不能重复派发");
  }
  return beginWorkflowMemoryWriteResponseSchema.parse({
    schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
    ...loaded,
  });
}

export async function getMemoryWrite(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly memoryWriteIntentId: MemoryWriteIntentId },
): Promise<{ readonly memoryWrite: MemoryWriteDto }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const intent = snapshot.entities.memoryWriteIntents[input.memoryWriteIntentId];
  const result = Object.values(snapshot.entities.memoryWriteResults).find(
    (candidate) => candidate.memoryWriteIntentId === input.memoryWriteIntentId,
  );
  if (intent === undefined || result === undefined) throw notFound("Memory Write不存在");
  if (intent.requestedByPrincipalId !== input.principalId) throw forbidden("无权读取Memory Write");
  return { memoryWrite: toDto(snapshot, intent, result) };
}

export async function listMemoryWrites(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly productSessionId: string;
    readonly limit: number;
    readonly cursor?: MemoryWriteIntentId;
  },
): Promise<{ readonly memoryWrites: MemoryWriteDto[]; readonly nextCursor?: MemoryWriteIntentId }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const session = snapshot.entities.sessions[input.productSessionId];
  if (session === undefined) throw notFound("Session不存在");
  if (session.ownerPrincipalId !== input.principalId) throw forbidden("无权读取该Session");
  const ordered = Object.values(snapshot.entities.memoryWriteIntents)
    .filter(
      (intent) =>
        intent.schemaVersion === "memory-write-intent.v1" &&
        intent.productSessionId === input.productSessionId,
    )
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.memoryWriteIntentId.localeCompare(left.memoryWriteIntentId),
    );
  const cursorIndex =
    input.cursor === undefined
      ? -1
      : ordered.findIndex((intent) => intent.memoryWriteIntentId === input.cursor);
  if (input.cursor !== undefined && cursorIndex < 0) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: "Memory Write分页cursor无效",
    });
  }
  const intents = ordered.slice(cursorIndex + 1, cursorIndex + 1 + input.limit);
  const memoryWrites = intents.map((intent) => {
    const result = Object.values(snapshot.entities.memoryWriteResults).find(
      (candidate) => candidate.memoryWriteIntentId === intent.memoryWriteIntentId,
    );
    if (result === undefined) throw notFound("Memory Write Result不存在");
    return toDto(snapshot, intent, result);
  });
  const hasMore = cursorIndex + 1 + intents.length < ordered.length;
  return {
    memoryWrites,
    ...(hasMore && intents.at(-1) !== undefined
      ? { nextCursor: intents.at(-1)!.memoryWriteIntentId }
      : {}),
  };
}

export interface LoadedMemoryWrite {
  readonly intent: MemoryWriteIntent;
  readonly result: MemoryWriteResult;
  readonly adapterInput: WorkflowMemoryWriteInput;
}

export async function loadMemoryWriteForRuntime(
  deps: ApplicationDeps,
  input: {
    readonly memoryWriteIntentId: MemoryWriteIntentId;
    readonly memoryWriteResultId: MemoryWriteResultId;
  },
): Promise<LoadedMemoryWrite> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const intent = snapshot.entities.memoryWriteIntents[input.memoryWriteIntentId];
  const result = snapshot.entities.memoryWriteResults[input.memoryWriteResultId];
  if (intent === undefined || result === undefined) throw notFound("Memory Write不存在");
  if (result.memoryWriteIntentId !== intent.memoryWriteIntentId) {
    throw revisionConflict("Memory Write Intent/Result不一致");
  }
  const capability = intent.providerDescriptor.capabilities.write;
  if (capability === null) throw revisionConflict("Memory Write来源损坏");
  let content: string;
  let requestSha256: string;
  let adapterSource:
    | { readonly productSessionId: ProductSessionId; readonly sourceMessageId: MessageId }
    | { readonly sessionKey: string; readonly turnKey: string };
  if (intent.schemaVersion === "memory-write-intent.v1") {
    const message = snapshot.entities.messages[intent.sourceSelection.sourceMessageId];
    if (message === undefined) throw revisionConflict("Memory Write来源损坏");
    content = resolveMemoryWriteContent({
      message,
      selection: intent.sourceSelection,
      maxContentCharacters: capability.maxContentCharacters,
    });
    requestSha256 = computeMemoryWriteRequestSha256({
      operationId: intent.operationId,
      providerDescriptorSha256: intent.providerDescriptorSha256,
      contentType: intent.contentType,
      sourceSelection: intent.sourceSelection,
      contentSha256: sha256Hex(content),
    });
    adapterSource = {
      productSessionId: intent.productSessionId,
      sourceMessageId: message.messageId,
    };
  } else if (intent.schemaVersion === "memory-write-intent.v2") {
    content = resolveMemoryWriteImportContent({
      contentSnapshot: intent.contentSnapshot,
      selection: intent.sourceSelection,
      maxContentCharacters: capability.maxContentCharacters,
    });
    requestSha256 = computeMemoryWriteImportRequestSha256({
      operationId: intent.operationId,
      providerDescriptorSha256: intent.providerDescriptorSha256,
      contentType: intent.contentType,
      sourceSelection: intent.sourceSelection,
      sourceSessionKey: intent.sourceSessionKey,
      sourceTurnKey: intent.sourceTurnKey,
      contentSha256: sha256Hex(content),
    });
    adapterSource = { sessionKey: intent.sourceSessionKey, turnKey: intent.sourceTurnKey };
  } else {
    const candidate =
      snapshot.entities.memoryAgentWriteCandidates[
        intent.sourceSelection.memoryAgentWriteCandidateId
      ];
    const item = candidate?.items.find(
      (candidateItem) => candidateItem.itemKey === intent.sourceSelection.itemKey,
    );
    if (
      candidate === undefined ||
      candidate.status !== "approved" ||
      candidate.sha256 !== intent.sourceSelection.candidateSha256 ||
      item === undefined ||
      item.sha256 !== intent.sourceSelection.itemSha256 ||
      !candidate.memoryWriteIntentIds.includes(intent.memoryWriteIntentId)
    ) {
      throw revisionConflict("Memory Agent写入候选来源损坏或尚未批准");
    }
    content = resolveMemoryWriteAgentCandidateContent({
      contentSnapshot: intent.contentSnapshot,
      selection: intent.sourceSelection,
      maxContentCharacters: capability.maxContentCharacters,
    });
    requestSha256 = computeMemoryWriteAgentCandidateRequestSha256({
      operationId: intent.operationId,
      providerDescriptorSha256: intent.providerDescriptorSha256,
      contentType: intent.contentType,
      sourceSelection: intent.sourceSelection,
      sourceSessionKey: intent.sourceSessionKey,
      sourceTurnKey: intent.sourceTurnKey,
      contentSha256: sha256Hex(content),
    });
    adapterSource = { sessionKey: intent.sourceSessionKey, turnKey: intent.sourceTurnKey };
  }
  if (requestSha256 !== intent.requestSha256) throw revisionConflict("Memory Write请求Hash不一致");
  return {
    intent,
    result,
    adapterInput: {
      operationId: intent.operationId,
      requestSha256: intent.requestSha256,
      content,
      contentType: intent.contentType,
      principalId: intent.requestedByPrincipalId,
      ...adapterSource,
    },
  };
}

interface ResultCommandBase {
  readonly commandId: CommandId;
  readonly memoryWriteIntentId: MemoryWriteIntentId;
  readonly memoryWriteResultId: MemoryWriteResultId;
  readonly requestSha256: string;
  readonly expectedRevision: number;
}

async function updateResult(
  deps: ApplicationDeps,
  commandType: string,
  input: ResultCommandBase,
  update: (current: MemoryWriteResult, now: string) => MemoryWriteResult,
): Promise<MemoryWriteResult> {
  const now = deps.now();
  await deps.store.transact({
    commandId: input.commandId,
    commandType,
    requestSha256: hashCanonical(
      `command.${commandType.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").toLowerCase()}.v1`,
      input,
    ),
    mutate: (draft) => {
      const intent = draft.entities.memoryWriteIntents[input.memoryWriteIntentId];
      const current = draft.entities.memoryWriteResults[input.memoryWriteResultId];
      if (intent === undefined || current === undefined) throw notFound("Memory Write不存在");
      if (
        current.memoryWriteIntentId !== intent.memoryWriteIntentId ||
        intent.requestSha256 !== input.requestSha256 ||
        current.revision !== input.expectedRevision
      ) {
        throw revisionConflict("Memory Write Result CAS或请求Hash不一致");
      }
      const next = memoryWriteResultSchema.parse(update(current, now));
      draft.entities.memoryWriteResults[next.memoryWriteResultId] = next;
      return { resultRefs: { memoryWriteResultId: next.memoryWriteResultId } };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const result = snapshot.entities.memoryWriteResults[input.memoryWriteResultId];
  if (result === undefined) throw notFound("Memory Write Result不存在");
  return result;
}

export function markMemoryWriteDispatching(
  deps: ApplicationDeps,
  input: ResultCommandBase,
): Promise<MemoryWriteResult> {
  return updateResult(deps, "MarkMemoryWriteDispatching", input, (current, now) => {
    assertMemoryWriteTransition(current, "dispatching");
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

export function commitMemoryWriteAccepted(
  deps: ApplicationDeps,
  input: ResultCommandBase & {
    readonly accepted: WorkflowMemoryWriteAccepted;
    readonly reconciled?: boolean;
  },
): Promise<MemoryWriteResult> {
  return updateResult(deps, "CommitMemoryWriteAccepted", input, (current, now) => {
    if (!(current.status === "accepted" && input.reconciled === true)) {
      assertMemoryWriteTransition(current, "accepted");
    }
    if (
      current.status === "accepted" &&
      current.externalObjectId !== input.accepted.externalObjectId
    ) {
      throw revisionConflict("Memory Write外部对象身份不可改写");
    }
    return {
      schemaVersion: current.schemaVersion,
      memoryWriteResultId: current.memoryWriteResultId,
      memoryWriteIntentId: current.memoryWriteIntentId,
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

export function commitMemoryWriteMaterialized(
  deps: ApplicationDeps,
  input: ResultCommandBase & {
    readonly accepted: WorkflowMemoryWriteAccepted;
    readonly verificationKind: string;
    readonly verificationSha256: string;
    readonly reconciled?: boolean;
  },
): Promise<MemoryWriteResult> {
  return updateResult(deps, "CommitMemoryWriteMaterialized", input, (current, now) => {
    assertMemoryWriteTransition(current, "materialized");
    if (
      current.status === "accepted" &&
      current.externalObjectId !== input.accepted.externalObjectId
    ) {
      throw revisionConflict("Memory Write外部对象身份不可改写");
    }
    return {
      schemaVersion: current.schemaVersion,
      memoryWriteResultId: current.memoryWriteResultId,
      memoryWriteIntentId: current.memoryWriteIntentId,
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

export function commitMemoryWriteFailed(
  deps: ApplicationDeps,
  input: ResultCommandBase & {
    readonly errorCode: string;
    readonly summary: string;
    readonly reconciled?: boolean;
  },
): Promise<MemoryWriteResult> {
  return updateResult(deps, "CommitMemoryWriteFailed", input, (current, now) => {
    assertMemoryWriteTransition(current, "failed");
    return {
      schemaVersion: current.schemaVersion,
      memoryWriteResultId: current.memoryWriteResultId,
      memoryWriteIntentId: current.memoryWriteIntentId,
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

export function commitMemoryWriteOutcomeUnknown(
  deps: ApplicationDeps,
  input: ResultCommandBase & { readonly errorCode: string; readonly reconciled?: boolean },
): Promise<MemoryWriteResult> {
  return updateResult(deps, "CommitMemoryWriteOutcomeUnknown", input, (current, now) => {
    if (current.status !== "outcome_unknown")
      assertMemoryWriteTransition(current, "outcome_unknown");
    return {
      schemaVersion: current.schemaVersion,
      memoryWriteResultId: current.memoryWriteResultId,
      memoryWriteIntentId: current.memoryWriteIntentId,
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

export async function requestMemoryWriteReconciliation(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly memoryWriteIntentId: MemoryWriteIntentId;
    readonly expectedResultRevision: number;
  },
): Promise<{ readonly memoryWrite: MemoryWriteDto }> {
  const now = deps.now();
  const outboxId = deps.ids.outbox();
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "RequestMemoryWriteReconciliation",
    requestSha256: hashCanonical("command.request-memory-write-reconciliation.v1", input),
    mutate: (draft) => {
      const intent = draft.entities.memoryWriteIntents[input.memoryWriteIntentId];
      const result = Object.values(draft.entities.memoryWriteResults).find(
        (candidate) => candidate.memoryWriteIntentId === input.memoryWriteIntentId,
      );
      if (intent === undefined || result === undefined) throw notFound("Memory Write不存在");
      if (intent.requestedByPrincipalId !== input.principalId)
        throw forbidden("无权对账该Memory Write");
      if (
        result.revision !== input.expectedResultRevision ||
        !["dispatching", "accepted", "outcome_unknown"].includes(result.status) ||
        !intent.providerDescriptor.capabilities.reconcile
      ) {
        throw revisionConflict("Memory Write当前状态不允许对账");
      }
      const existing = Object.values(draft.outbox).find(
        (entry) =>
          entry.kind === "memory_write_reconcile" &&
          entry.memoryWriteIntentId === intent.memoryWriteIntentId &&
          ["pending", "dispatched", "outcome_unknown"].includes(entry.status),
      );
      if (existing === undefined) {
        draft.outbox[outboxId] = {
          schemaVersion: "outbox-entry.v1",
          outboxId,
          kind: "memory_write_reconcile",
          status: "pending",
          memoryWriteIntentId: intent.memoryWriteIntentId,
          memoryWriteResultId: result.memoryWriteResultId,
          expectedResultRevision: result.revision,
          dispatchAttempts: 0,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
      }
      return {
        resultRefs: {
          memoryWriteIntentId: intent.memoryWriteIntentId,
          memoryWriteResultId: result.memoryWriteResultId,
        },
      };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const intent =
    snapshot.entities.memoryWriteIntents[transaction.resultRefs["memoryWriteIntentId"] ?? ""];
  const result =
    snapshot.entities.memoryWriteResults[transaction.resultRefs["memoryWriteResultId"] ?? ""];
  if (intent === undefined || result === undefined) throw notFound("Memory Write不存在");
  return { memoryWrite: toDto(snapshot, intent, result) };
}

export type MemoryWriteOutboxEntry = Extract<
  Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"]["outbox"][string],
  { readonly kind: "memory_write_start" | "memory_write_reconcile" }
>;

export function memoryWriteOutboxForIntent(
  snapshot: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"],
  intentId: MemoryWriteIntentId,
): readonly { readonly outboxId: OutboxEntryId; readonly entry: MemoryWriteOutboxEntry }[] {
  return Object.values(snapshot.outbox).flatMap((entry) =>
    (entry.kind === "memory_write_start" || entry.kind === "memory_write_reconcile") &&
    entry.memoryWriteIntentId === intentId
      ? [{ outboxId: entry.outboxId, entry }]
      : [],
  );
}
