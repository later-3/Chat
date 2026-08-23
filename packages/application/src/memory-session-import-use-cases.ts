import {
  memorySessionImportIdSchema,
  memorySessionImportSchema,
  memoryWriteIntentIdSchema,
  memoryWriteIntentV2Schema,
  memoryWriteResultIdSchema,
  memoryWriteResultSchema,
  type CommandId,
  type CreateMemorySessionImportPayload,
  type MemorySessionImport,
  type MemorySessionImportDto,
  type MemorySessionImportId,
  type MemorySessionImportPreview,
  type MemorySessionSourceRef,
  type MemoryWriteIntent,
  type PrincipalId,
  type ProductSnapshot,
} from "@chat/contracts";
import {
  MEMORY_SESSION_CONVERSION_VERSION,
  computeMemoryProviderDescriptorSha256,
  computeMemorySessionSnapshotSha256,
  computeMemoryWriteImportRequestSha256,
  computeMemoryWriteImportSemanticDedupeSha256,
  convertMemorySessionToItems,
  hashCanonical,
  MemorySessionConversionError,
  type ConvertedMemorySessionItem,
  type NormalizedMemorySessionSnapshot,
} from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import {
  ApplicationError,
  CommandIdReusedError,
  forbidden,
  notFound,
  revisionConflict,
} from "./errors.js";

interface PreparedSessionImport {
  readonly source: MemorySessionSourceRef;
  readonly snapshot: NormalizedMemorySessionSnapshot;
  readonly sourceSnapshotSha256: string;
  readonly providerDescriptor: ReturnType<
    NonNullable<ApplicationDeps["workflowMemoryProviders"]>["list"]
  >[number];
  readonly providerDescriptorSha256: string;
  readonly items: readonly ConvertedMemorySessionItem[];
  readonly previewSha256: string;
}

export function memorySessionSourceId(source: MemorySessionSourceRef): string {
  return source.kind === "chat" ? source.productSessionId : source.codexSessionId;
}

export function memorySessionSourceKey(source: MemorySessionSourceRef): string {
  return source.kind === "chat"
    ? source.productSessionId
    : `codex-session:${source.codexSessionId}`;
}

function boundedTitle(value: string): string {
  const normalized = value.trim();
  return (normalized.length === 0 ? "未命名会话" : normalized).slice(0, 200);
}

function chatSnapshot(
  snapshot: Readonly<ProductSnapshot>,
  source: Extract<MemorySessionSourceRef, { kind: "chat" }>,
  principalId: PrincipalId,
): NormalizedMemorySessionSnapshot {
  const session = snapshot.entities.sessions[source.productSessionId];
  if (session === undefined) throw notFound("Chat Session不存在");
  if (session.ownerPrincipalId !== principalId) throw forbidden("无权读取该Chat Session");
  const messages = Object.values(snapshot.entities.messages)
    .filter((message) => message.sessionId === session.sessionId)
    .sort((left, right) => left.sessionSequence - right.sessionSequence)
    .map((message) => ({
      sourceMessageKey: message.messageId,
      role: message.role,
      text: message.content.text,
      createdAt: message.createdAt,
    }));
  return {
    sourceKind: "chat",
    sourceSessionId: session.sessionId,
    title: boundedTitle(
      session.title ?? messages.find((message) => message.role === "user")?.text ?? "Chat Session",
    ),
    updatedAt: session.updatedAt,
    messages,
  };
}

export async function loadMemorySessionSourceSnapshot(
  deps: ApplicationDeps,
  principalId: PrincipalId,
  source: MemorySessionSourceRef,
): Promise<NormalizedMemorySessionSnapshot> {
  if (source.kind === "chat") {
    return chatSnapshot(
      (await deps.store.read({ kind: "committedSnapshot" })).snapshot,
      source,
      principalId,
    );
  }
  const adapter = deps.memorySessionSources?.get("codex");
  if (adapter === undefined) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 409,
      message: "Codex Session来源未配置",
      recoveryAction: "rehydrate_and_retry",
    });
  }
  const loaded = await adapter.load(source.codexSessionId);
  if (
    loaded === undefined ||
    loaded.sourceKind !== "codex" ||
    loaded.sourceSessionId !== source.codexSessionId
  ) {
    throw notFound("Codex Session不存在");
  }
  return { ...loaded, title: boundedTitle(loaded.title) };
}

async function prepareSessionImport(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly source: MemorySessionSourceRef;
    readonly providerId: string;
  },
): Promise<PreparedSessionImport> {
  const provider = deps.workflowMemoryProviders?.getWrite(input.providerId);
  const providerDescriptor = provider?.describeProvider();
  const writeCapability = providerDescriptor?.capabilities.write;
  if (
    provider === undefined ||
    providerDescriptor === undefined ||
    providerDescriptor.providerId !== input.providerId ||
    !providerDescriptor.configured ||
    writeCapability === null ||
    writeCapability === undefined
  ) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 409,
      message: "Memory Provider未配置或不支持写入",
      recoveryAction: "rehydrate_and_retry",
    });
  }
  const snapshot = await loadMemorySessionSourceSnapshot(deps, input.principalId, input.source);
  const sourceSnapshotSha256 = computeMemorySessionSnapshotSha256(snapshot);
  let items: readonly ConvertedMemorySessionItem[];
  try {
    items = convertMemorySessionToItems({
      snapshot,
      maxContentCharacters: Math.min(writeCapability.maxContentCharacters, 50_000),
    });
  } catch (error) {
    if (error instanceof MemorySessionConversionError) {
      throw new ApplicationError({
        code: "validation_failed",
        httpStatus: 422,
        message: error.message,
        recoveryAction: "rehydrate_and_retry",
      });
    }
    throw error;
  }
  const providerDescriptorSha256 = computeMemoryProviderDescriptorSha256(providerDescriptor);
  const previewSha256 = hashCanonical("memory-session-import-preview.v1", {
    source: input.source,
    sourceSnapshotSha256,
    conversionVersion: MEMORY_SESSION_CONVERSION_VERSION,
    providerId: input.providerId,
    providerDescriptorSha256,
    items: items.map((item) => ({
      sourceItemKey: item.sourceItemKey,
      sourceItemSha256: item.sourceItemSha256,
      title: item.title,
      contentSha256: item.contentSha256,
      contentCharacters: item.content.length,
    })),
  });
  return {
    source: input.source,
    snapshot,
    sourceSnapshotSha256,
    providerDescriptor,
    providerDescriptorSha256,
    items,
    previewSha256,
  };
}

function itemSemanticDedupe(
  principalId: PrincipalId,
  providerId: string,
  prepared: PreparedSessionImport,
  item: ConvertedMemorySessionItem,
): string {
  return computeMemoryWriteImportSemanticDedupeSha256({
    requestedByPrincipalId: principalId,
    providerId,
    sourceKind: prepared.source.kind,
    sourceSessionId: memorySessionSourceId(prepared.source),
    sourceItemKey: item.sourceItemKey,
    sourceItemSha256: item.sourceItemSha256,
  });
}

function existingIntentBySemantic(
  snapshot: Readonly<ProductSnapshot>,
  semanticDedupeSha256: string,
): MemoryWriteIntent | undefined {
  return Object.values(snapshot.entities.memoryWriteIntents).find(
    (intent) =>
      intent.schemaVersion === "memory-write-intent.v2" &&
      intent.semanticDedupeSha256 === semanticDedupeSha256,
  );
}

export async function listMemorySessionSources(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly kind: "chat" | "codex";
    readonly limit: number;
  },
) {
  if (input.kind === "chat") {
    const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    return {
      sources: Object.values(snapshot.entities.sessions)
        .filter((session) => session.ownerPrincipalId === input.principalId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, input.limit)
        .map((session) => ({
          source: { kind: "chat" as const, productSessionId: session.sessionId },
          title: boundedTitle(session.title ?? "Chat Session"),
          updatedAt: session.updatedAt,
        })),
    };
  }
  const adapter = deps.memorySessionSources?.get("codex");
  if (adapter === undefined) return { sources: [] };
  return {
    sources: (await adapter.list({ limit: input.limit })).map((session) => ({
      source: { kind: "codex" as const, codexSessionId: session.sourceSessionId as never },
      title: boundedTitle(session.title),
      updatedAt: session.updatedAt,
    })),
  };
}

export async function previewMemorySessionImport(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly source: MemorySessionSourceRef;
    readonly providerId: string;
  },
): Promise<{ readonly preview: MemorySessionImportPreview }> {
  const prepared = await prepareSessionImport(deps, input);
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const items = prepared.items.map((item) => {
    const semanticDedupeSha256 = itemSemanticDedupe(
      input.principalId,
      input.providerId,
      prepared,
      item,
    );
    const existing = existingIntentBySemantic(snapshot, semanticDedupeSha256);
    return {
      sourceItemKey: item.sourceItemKey,
      sourceItemSha256: item.sourceItemSha256 as never,
      title: item.title,
      contentPreview:
        item.content.length <= 1_000 ? item.content : `${item.content.slice(0, 999)}…`,
      contentCharacters: item.content.length,
      alreadyImported: existing !== undefined,
      ...(existing === undefined
        ? {}
        : { existingMemoryWriteIntentId: existing.memoryWriteIntentId }),
    };
  });
  const existingItemCount = items.filter((item) => item.alreadyImported).length;
  return {
    preview: {
      schemaVersion: "memory-session-import-preview.v1",
      source: prepared.source,
      sourceTitle: prepared.snapshot.title,
      sourceUpdatedAt: prepared.snapshot.updatedAt,
      sourceSnapshotSha256: prepared.sourceSnapshotSha256 as never,
      conversionVersion: MEMORY_SESSION_CONVERSION_VERSION,
      previewSha256: prepared.previewSha256 as never,
      providerId: prepared.providerDescriptor.providerId,
      providerDisplayName: prepared.providerDescriptor.displayName,
      items,
      newItemCount: items.length - existingItemCount,
      existingItemCount,
    },
  };
}

function derivedImportId(commandId: CommandId): MemorySessionImportId {
  return memorySessionImportIdSchema.parse(
    `msi_${hashCanonical("id.memory-session-import.v1", { commandId }).slice(0, 32)}`,
  );
}

function derivedWriteIntentId(semanticDedupeSha256: string) {
  return memoryWriteIntentIdSchema.parse(`mwi_${semanticDedupeSha256.slice(0, 32)}`);
}

function derivedWriteResultId(memoryWriteIntentId: string) {
  return memoryWriteResultIdSchema.parse(
    `mwr_${hashCanonical("id.memory-write-result.v2", { memoryWriteIntentId }).slice(0, 32)}`,
  );
}

function toImportDto(
  snapshot: Readonly<ProductSnapshot>,
  entity: MemorySessionImport,
): MemorySessionImportDto {
  const counts = {
    queued: 0,
    dispatching: 0,
    accepted: 0,
    materialized: 0,
    failed: 0,
    outcomeUnknown: 0,
  };
  let latestUpdatedAt = entity.updatedAt;
  const items = entity.items.map((ref) => {
    const result = Object.values(snapshot.entities.memoryWriteResults).find(
      (candidate) => candidate.memoryWriteIntentId === ref.memoryWriteIntentId,
    );
    if (result === undefined) throw revisionConflict("Session Import写入Result缺失");
    if (result.updatedAt > latestUpdatedAt) latestUpdatedAt = result.updatedAt;
    if (result.status === "outcome_unknown") counts.outcomeUnknown += 1;
    else counts[result.status] += 1;
    const intent = snapshot.entities.memoryWriteIntents[ref.memoryWriteIntentId];
    if (intent === undefined) throw revisionConflict("Session Import写入Intent缺失");
    const canReconcile =
      intent.providerDescriptor.capabilities.reconcile &&
      ["dispatching", "accepted", "outcome_unknown"].includes(result.status) &&
      !Object.values(snapshot.outbox).some(
        (entry) =>
          entry.kind === "memory_write_reconcile" &&
          entry.memoryWriteIntentId === intent.memoryWriteIntentId &&
          ["pending", "dispatched", "outcome_unknown"].includes(entry.status),
      );
    return { ...ref, result, canReconcile };
  });
  const status =
    entity.createdItemCount === 0
      ? "no_changes"
      : counts.failed > 0 || counts.outcomeUnknown > 0
        ? "needs_attention"
        : counts.queued > 0 || counts.dispatching > 0
          ? "processing"
          : "completed";
  return {
    memorySessionImportId: entity.memorySessionImportId,
    source: entity.source,
    sourceTitle: entity.sourceTitle,
    sourceUpdatedAt: entity.sourceUpdatedAt,
    sourceSnapshotSha256: entity.sourceSnapshotSha256,
    conversionVersion: entity.conversionVersion,
    previewSha256: entity.previewSha256,
    providerId: entity.providerId,
    providerDisplayName: entity.providerDescriptor.displayName,
    status,
    createdItemCount: entity.createdItemCount,
    existingItemCount: entity.existingItemCount,
    resultCounts: counts,
    items,
    createdAt: entity.createdAt,
    updatedAt: latestUpdatedAt,
  };
}

export async function createMemorySessionImport(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly payload: CreateMemorySessionImportPayload;
  },
): Promise<{ readonly memorySessionImport: MemorySessionImportDto }> {
  const commandType = "CreateMemorySessionImport";
  const requestSha256 = hashCanonical("command.create-memory-session-import.v1", {
    principalId: input.principalId,
    payload: input.payload,
  });
  // 响应丢失后的同命令重放必须先命中Receipt，不能因外部Session后来变化而重新读取。
  const before = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
  const priorReceipt = before.commandReceipts[input.commandId];
  if (priorReceipt !== undefined) {
    if (priorReceipt.commandType !== commandType || priorReceipt.requestSha256 !== requestSha256) {
      throw new CommandIdReusedError(input.commandId);
    }
    return getMemorySessionImport(deps, {
      principalId: input.principalId,
      memorySessionImportId: memorySessionImportIdSchema.parse(
        priorReceipt.resultRefs["memorySessionImportId"],
      ),
    });
  }
  const prepared = await prepareSessionImport(deps, {
    principalId: input.principalId,
    source: input.payload.source,
    providerId: input.payload.providerId,
  });
  if (
    prepared.sourceSnapshotSha256 !== input.payload.sourceSnapshotSha256 ||
    prepared.previewSha256 !== input.payload.previewSha256
  ) {
    throw revisionConflict("Session已变化或Preview不再匹配，请重新预览");
  }
  // 外部Codex文件在事务外读取；提交前再读一次，防止预览与冻结之间静默漂移。
  if (prepared.source.kind === "codex") {
    const confirmed = await loadMemorySessionSourceSnapshot(
      deps,
      input.principalId,
      prepared.source,
    );
    if (computeMemorySessionSnapshotSha256(confirmed) !== prepared.sourceSnapshotSha256) {
      throw revisionConflict("Codex Session在导入前发生变化，请重新预览");
    }
  }
  const semanticDedupeSha256 = hashCanonical("memory-session-import-semantic-dedupe.v1", {
    principalId: input.principalId,
    source: prepared.source,
    sourceSnapshotSha256: prepared.sourceSnapshotSha256,
    conversionVersion: MEMORY_SESSION_CONVERSION_VERSION,
    providerId: input.payload.providerId,
    providerDescriptorSha256: prepared.providerDescriptorSha256,
    previewSha256: prepared.previewSha256,
  });
  const candidateImportId = derivedImportId(input.commandId);
  const outboxIds = prepared.items.map(() => deps.ids.outbox());
  const now = deps.now();
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType,
    requestSha256,
    mutate: (draft) => {
      if (prepared.source.kind === "chat") {
        const current = chatSnapshot(draft, prepared.source, input.principalId);
        if (computeMemorySessionSnapshotSha256(current) !== prepared.sourceSnapshotSha256) {
          throw revisionConflict("Chat Session在导入前发生变化，请重新预览");
        }
      }
      const existingImport = Object.values(draft.entities.memorySessionImports).find(
        (candidate) => candidate.semanticDedupeSha256 === semanticDedupeSha256,
      );
      if (existingImport !== undefined) {
        return { resultRefs: { memorySessionImportId: existingImport.memorySessionImportId } };
      }
      const refs: MemorySessionImport["items"][number][] = [];
      let createdItemCount = 0;
      for (const [index, item] of prepared.items.entries()) {
        const itemDedupe = itemSemanticDedupe(
          input.principalId,
          input.payload.providerId,
          prepared,
          item,
        );
        const existing = existingIntentBySemantic(draft, itemDedupe);
        if (existing !== undefined) {
          refs.push({
            memoryWriteIntentId: existing.memoryWriteIntentId,
            disposition: "existing",
            sourceItemKey: item.sourceItemKey,
            sourceItemSha256: item.sourceItemSha256 as never,
            title: item.title,
            contentCharacters: item.content.length,
          });
          continue;
        }
        const memoryWriteIntentId = derivedWriteIntentId(itemDedupe);
        const memoryWriteResultId = derivedWriteResultId(memoryWriteIntentId);
        const sourceSelection = {
          kind: "session_import_item" as const,
          memorySessionImportId: candidateImportId,
          sourceKind: prepared.source.kind,
          sourceSessionId: memorySessionSourceId(prepared.source),
          sourceSnapshotSha256: prepared.sourceSnapshotSha256,
          sourceItemKey: item.sourceItemKey,
          sourceItemSha256: item.sourceItemSha256,
          contentSha256: item.contentSha256,
        };
        const requestSha256 = computeMemoryWriteImportRequestSha256({
          operationId: memoryWriteIntentId,
          providerDescriptorSha256: prepared.providerDescriptorSha256,
          contentType: "conversation_turn",
          sourceSelection,
          sourceSessionKey: memorySessionSourceKey(prepared.source),
          sourceTurnKey: item.sourceTurnKey,
          contentSha256: item.contentSha256,
        });
        const intent = memoryWriteIntentV2Schema.parse({
          schemaVersion: "memory-write-intent.v2",
          memoryWriteIntentId,
          operationId: memoryWriteIntentId,
          requestedByPrincipalId: input.principalId,
          sourceSelection,
          sourceSessionKey: memorySessionSourceKey(prepared.source),
          sourceTurnKey: item.sourceTurnKey,
          contentSnapshot: item.content,
          contentType: "conversation_turn",
          providerId: input.payload.providerId,
          providerDescriptor: prepared.providerDescriptor,
          providerDescriptorSha256: prepared.providerDescriptorSha256,
          requestSha256,
          semanticDedupeSha256: itemDedupe,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
        const result = memoryWriteResultSchema.parse({
          schemaVersion: "memory-write-result.v1",
          memoryWriteResultId,
          memoryWriteIntentId,
          status: "queued",
          dispatchAttempts: 0,
          reconcileAttempts: 0,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
        draft.entities.memoryWriteIntents[memoryWriteIntentId] = intent;
        draft.entities.memoryWriteResults[memoryWriteResultId] = result;
        const outboxId = outboxIds[index]!;
        draft.outbox[outboxId] = {
          schemaVersion: "outbox-entry.v1",
          outboxId,
          kind: "memory_write_start",
          status: "pending",
          memoryWriteIntentId,
          memoryWriteResultId,
          expectedResultRevision: 1,
          dispatchAttempts: 0,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        createdItemCount += 1;
        refs.push({
          memoryWriteIntentId,
          disposition: "created",
          sourceItemKey: item.sourceItemKey,
          sourceItemSha256: item.sourceItemSha256 as never,
          title: item.title,
          contentCharacters: item.content.length,
        });
      }
      const entity = memorySessionImportSchema.parse({
        schemaVersion: "memory-session-import.v1",
        memorySessionImportId: candidateImportId,
        requestedByPrincipalId: input.principalId,
        source: prepared.source,
        sourceTitle: prepared.snapshot.title,
        sourceUpdatedAt: prepared.snapshot.updatedAt,
        sourceSnapshotSha256: prepared.sourceSnapshotSha256,
        conversionVersion: MEMORY_SESSION_CONVERSION_VERSION,
        previewSha256: prepared.previewSha256,
        providerId: input.payload.providerId,
        providerDescriptor: prepared.providerDescriptor,
        providerDescriptorSha256: prepared.providerDescriptorSha256,
        items: refs,
        createdItemCount,
        existingItemCount: refs.length - createdItemCount,
        semanticDedupeSha256,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      draft.entities.memorySessionImports[candidateImportId] = entity;
      return { resultRefs: { memorySessionImportId: candidateImportId } };
    },
  });
  return getMemorySessionImport(deps, {
    principalId: input.principalId,
    memorySessionImportId: memorySessionImportIdSchema.parse(
      transaction.resultRefs["memorySessionImportId"],
    ),
  });
}

export async function getMemorySessionImport(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly memorySessionImportId: MemorySessionImportId;
  },
): Promise<{ readonly memorySessionImport: MemorySessionImportDto }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const entity = snapshot.entities.memorySessionImports[input.memorySessionImportId];
  if (entity === undefined) throw notFound("Memory Session Import不存在");
  if (entity.requestedByPrincipalId !== input.principalId)
    throw forbidden("无权读取该Session Import");
  return { memorySessionImport: toImportDto(snapshot, entity) };
}

export async function listMemorySessionImports(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly limit: number },
): Promise<{ readonly memorySessionImports: readonly MemorySessionImportDto[] }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  return {
    memorySessionImports: Object.values(snapshot.entities.memorySessionImports)
      .filter((entity) => entity.requestedByPrincipalId === input.principalId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, input.limit)
      .map((entity) => toImportDto(snapshot, entity)),
  };
}
