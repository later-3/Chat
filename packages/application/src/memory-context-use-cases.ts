import {
  contextPackageIdSchema,
  memoryAdoptionIdSchema,
  memoryQueryIdSchema,
  memoryResultSnapshotIdSchema,
  type BeginPlanningContextResponse,
  type CommandId,
  type ContextPackage,
  type ContextPackageId,
  type MemoryAdoptionId,
  type MemoryQuery,
  type MemoryQueryDispatchDto,
  type MemoryQueryExecutionResult,
  type MemoryQueryId,
  type MemoryResultSnapshotId,
  type PreparePlanningContextResponse,
  type ProductRunId,
  type RunAttemptId,
} from "@chat/contracts";
import {
  computeContextPackageSha256,
  computeMemoryBackendDescriptorSha256,
  computeMemoryQueryResultSha256,
  computeMemoryResultSnapshotSha256,
  estimateMemorySectionTokens,
  hashCanonical,
} from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { notFound, revisionConflict } from "./errors.js";
import {
  freezeMemoryBackendDescriptor,
  MemoryBackendError,
  type MemoryBackendProfile,
  type MemoryQueryOutput,
} from "./memory-ports.js";
import { emitRunEvent } from "./trace-helpers.js";

export interface BeginPlanningContextCommand {
  readonly commandId: CommandId;
  readonly productRunId: ProductRunId;
  readonly attemptId: RunAttemptId;
  readonly planRevision: number;
}

export interface PersistPlanningContextResultCommand {
  readonly commandId: CommandId;
  readonly productRunId: ProductRunId;
  readonly attemptId: RunAttemptId;
  readonly memoryQueryId: MemoryQueryId;
  readonly result: MemoryQueryExecutionResult;
}

function derivedId(prefix: "mqy", domain: string, input: unknown): MemoryQueryId;
function derivedId(prefix: "mrs", domain: string, input: unknown): MemoryResultSnapshotId;
function derivedId(prefix: "mad", domain: string, input: unknown): MemoryAdoptionId;
function derivedId(prefix: "ctxp", domain: string, input: unknown): ContextPackageId;
function derivedId(prefix: "mqy" | "mrs" | "mad" | "ctxp", domain: string, input: unknown) {
  const value = `${prefix}_${hashCanonical(domain, input).slice(0, 32)}`;
  switch (prefix) {
    case "mqy":
      return memoryQueryIdSchema.parse(value);
    case "mrs":
      return memoryResultSnapshotIdSchema.parse(value);
    case "mad":
      return memoryAdoptionIdSchema.parse(value);
    case "ctxp":
      return contextPackageIdSchema.parse(value);
  }
}

function backendDescriptor(profile: MemoryBackendProfile): MemoryQuery["backendDescriptor"] {
  return freezeMemoryBackendDescriptor(profile);
}

function missingBackendDescriptor(
  backendId: MemoryQuery["backendId"],
  selection: {
    readonly layers: readonly ("L1" | "L2" | "L3" | "Skill")[];
    readonly maxLimit: number;
    readonly maxContextBudget: number;
  },
): MemoryQuery["backendDescriptor"] {
  return {
    backendId,
    displayName: "未配置的 Memory 后端",
    kind: "memmy" as const,
    adapterContractVersion: "memmy-http-query.v1" as const,
    configured: false,
    authMode: "none" as const,
    credentialRevision: "none",
    configurationFingerprint: hashCanonical("memory-backend-profile.missing.v1", { backendId }),
    capabilities: {
      query: true as const,
      tags: true as const,
      layers: [...selection.layers],
      maxLimit: selection.maxLimit,
      maxContextBudget: selection.maxContextBudget,
    },
  };
}

function packageResponse(
  contextPackage: ContextPackage,
  status: "ready" | "optional_failed",
): PreparePlanningContextResponse {
  return {
    schemaVersion: "chat-internal-runtime.v1",
    status,
    contextPackageRef: {
      contextPackageId: contextPackage.contextPackageId,
      revision: contextPackage.revision,
      sha256: contextPackage.sha256,
    },
  };
}

function terminalResponse(
  snapshot: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"],
  query: MemoryQuery,
): PreparePlanningContextResponse | undefined {
  if (query.status === "pending") return undefined;
  const contextPackage = Object.values(snapshot.entities.contextPackages).find(
    (candidate) => candidate.memoryQueryId === query.memoryQueryId,
  );
  if (query.status === "completed") {
    if (contextPackage === undefined)
      throw revisionConflict("已完成Memory Query缺少ContextPackage");
    return packageResponse(contextPackage, "ready");
  }
  if (query.requirement === "optional") {
    if (contextPackage === undefined) throw revisionConflict("可选Memory失败缺少ContextPackage");
    return packageResponse(contextPackage, "optional_failed");
  }
  return { schemaVersion: "chat-internal-runtime.v1", status: "required_failed" };
}

function queryDispatch(
  snapshot: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"],
  query: MemoryQuery,
): MemoryQueryDispatchDto {
  const run = snapshot.entities.runs[query.productRunId];
  const message = run === undefined ? undefined : snapshot.entities.messages[run.sourceMessageId];
  if (run === undefined || message === undefined)
    throw revisionConflict("Memory Query源输入不存在");
  return {
    memoryQueryId: query.memoryQueryId,
    contextRequestId: query.contextRequestId,
    productRunId: query.productRunId,
    productSessionId: run.sessionId,
    backendId: query.backendId,
    backendDescriptor: query.backendDescriptor,
    backendDescriptorSha256: query.backendDescriptorSha256,
    requirement: query.requirement,
    sourceMessageSha256: query.sourceMessageSha256,
    queryText: message.content.text,
    tags: query.tags,
    layers: query.layers,
    limit: query.limit,
    contextBudget: query.contextBudget,
  };
}

/**
 * 第一个耐久节点只冻结查询意图，不越过外部服务边界。Workflow 重放会读取
 * 同一个 pending Query；不会在 API 进程里再次调用 memmy。
 */
export async function beginPlanningContext(
  deps: ApplicationDeps,
  input: BeginPlanningContextCommand,
): Promise<BeginPlanningContextResponse> {
  const { snapshot: before } = await deps.store.read({ kind: "committedSnapshot" });
  const run = before.entities.runs[input.productRunId];
  if (run === undefined) throw notFound("Product Run不存在");
  if (input.planRevision !== 1) throw revisionConflict("Memory上下文必须在首版规划前冻结");
  const request = Object.values(before.entities.contextRequests).find(
    (candidate) => candidate.productRunId === input.productRunId,
  );
  if (request === undefined) throw revisionConflict("Product Run缺少ContextRequest");

  const existing = Object.values(before.entities.memoryQueries).find(
    (candidate) => candidate.contextRequestId === request.contextRequestId,
  );
  if (existing !== undefined) {
    const terminal = terminalResponse(before, existing);
    return terminal === undefined
      ? {
          schemaVersion: "chat-internal-runtime.v1",
          status: "dispatch_required",
          query: queryDispatch(before, existing),
        }
      : terminal;
  }

  const now = deps.now();
  if (request.memory === undefined) {
    const result = await deps.store.transact({
      commandId: input.commandId,
      commandType: "PreparePlanningContextNone",
      requestSha256: hashCanonical("command.prepare-planning-context-none.v1", {
        productRunId: input.productRunId,
        contextRequestId: request.contextRequestId,
      }),
      traceContext: { productRunId: input.productRunId },
      mutate: () => ({
        resultRefs: {
          productRunId: input.productRunId,
          contextRequestId: request.contextRequestId,
        },
      }),
    });
    if (!result.replayed) {
      emitRunEvent(deps, input.productRunId, {
        level: "info",
        eventName: "context.assembly.started",
        outcome: "unknown",
        productRunId: input.productRunId,
        attemptId: input.attemptId,
        contextRequestId: request.contextRequestId,
        memoryRequested: false,
      });
      emitRunEvent(deps, input.productRunId, {
        level: "info",
        eventName: "context.assembly.completed",
        outcome: "success",
        productRunId: input.productRunId,
        attemptId: input.attemptId,
        contextRequestId: request.contextRequestId,
        status: "none",
        memoryRequested: false,
        adoptedCount: 0,
        excludedCount: 0,
        durationMs: 0,
      });
    }
    return { schemaVersion: "chat-internal-runtime.v1", status: "none" };
  }

  const profile = deps.memoryBackends?.get(request.memory.backendId)?.describe();
  const descriptor =
    profile === undefined
      ? missingBackendDescriptor(request.memory.backendId, {
          layers: request.memory.layers,
          maxLimit: request.memory.limit,
          maxContextBudget: request.memory.contextBudget,
        })
      : backendDescriptor(profile);
  const backendDescriptorSha256 = computeMemoryBackendDescriptorSha256(descriptor);
  const memoryQueryId = derivedId("mqy", "id.memory-query.v1", {
    contextRequestId: request.contextRequestId,
  });
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "BeginMemoryContextQuery",
    requestSha256: hashCanonical("command.begin-memory-context-query.v1", {
      contextRequestId: request.contextRequestId,
      productRunId: input.productRunId,
      planRevision: 1,
      backendDescriptorSha256,
    }),
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const committedRequest = draft.entities.contextRequests[request.contextRequestId];
      if (committedRequest?.memory === undefined) {
        throw revisionConflict("ContextRequest不再要求Memory查询");
      }
      if (
        Object.values(draft.entities.memoryQueries).some(
          (candidate) => candidate.contextRequestId === committedRequest.contextRequestId,
        )
      ) {
        throw revisionConflict("ContextRequest已存在Memory Query");
      }
      const query: MemoryQuery = {
        schemaVersion: "memory-query.v1",
        memoryQueryId,
        contextRequestId: committedRequest.contextRequestId,
        productRunId: input.productRunId,
        planRevision: 1,
        backendId: committedRequest.memory.backendId,
        backendDescriptor: descriptor,
        backendDescriptorSha256,
        requirement: committedRequest.memory.requirement,
        sourceMessageSha256: committedRequest.sourceMessageSha256,
        tags: committedRequest.memory.tags,
        layers: committedRequest.memory.layers,
        limit: committedRequest.memory.limit,
        contextBudget: committedRequest.memory.contextBudget,
        status: "pending",
        startedAt: now,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.memoryQueries[memoryQueryId] = query;
      return { resultRefs: { memoryQueryId, productRunId: input.productRunId } };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const query = snapshot.entities.memoryQueries[result.resultRefs["memoryQueryId"] ?? ""];
  if (query === undefined) throw notFound("Memory Query不存在");
  if (!result.replayed) {
    emitRunEvent(deps, input.productRunId, {
      level: "info",
      eventName: "context.assembly.started",
      outcome: "unknown",
      productRunId: input.productRunId,
      attemptId: input.attemptId,
      contextRequestId: request.contextRequestId,
      memoryRequested: true,
    });
  }
  return {
    schemaVersion: "chat-internal-runtime.v1",
    status: "dispatch_required",
    query: queryDispatch(snapshot, query),
  };
}

export type NormalizedMemoryQueryResult = Extract<
  MemoryQueryExecutionResult,
  { outcome: "success" }
>;

/** Adapter输出与Workflow checkpoint共用这一套规范化/预算算法。 */
export function normalizeMemoryQueryResult(
  query: Pick<MemoryQuery, "limit" | "contextBudget">,
  output: MemoryQueryOutput,
): NormalizedMemoryQueryResult {
  if (output.sections.length > query.limit) {
    throw new MemoryBackendError({
      code: "memory.response.too_many_sections",
      message: "Memory返回采用段落超过本轮上限",
      retryable: false,
    });
  }
  const sections = output.sections.map((section) => ({
    ...section,
    externalObjectIds: [...new Set(section.externalObjectIds)].sort(),
    tags: [...new Set(section.tags.map((tag) => tag.trim()).filter(Boolean))].sort(),
    tokenEstimate: estimateMemorySectionTokens(section),
  }));
  const sourceCount = new Set(sections.flatMap((section) => section.externalObjectIds)).size;
  if (sourceCount > output.hitCount) {
    throw new MemoryBackendError({
      code: "memory.backend.contract_invalid",
      message: "Memory命中数量小于采用来源数量",
      retryable: false,
    });
  }
  const sectionEstimate = sections.reduce((total, section) => total + section.tokenEstimate, 0);
  const tokenEstimate = Math.max(output.tokenEstimate ?? 0, sectionEstimate);
  if (tokenEstimate > query.contextBudget) {
    throw new MemoryBackendError({
      code: "memory.response.over_budget",
      message: "Memory返回内容超过本轮预算",
      retryable: false,
    });
  }
  return {
    outcome: "success",
    externalQueryId: output.externalQueryId,
    hitCount: output.hitCount,
    tokenEstimate,
    sections,
    resultSetSha256: computeMemoryQueryResultSha256({
      externalQueryId: output.externalQueryId,
      hitCount: output.hitCount,
      tokenEstimate,
      sections,
    }),
  };
}

export function stableMemoryBackendFailure(error: unknown): string {
  return error instanceof MemoryBackendError ? error.code : "memory.backend.unavailable";
}

/** 第三个耐久节点只提交已 checkpoint 的结果；这里不再调用外部服务。 */
export async function persistPlanningContextResult(
  deps: ApplicationDeps,
  input: PersistPlanningContextResultCommand,
): Promise<PreparePlanningContextResponse> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const query = snapshot.entities.memoryQueries[input.memoryQueryId];
  if (query === undefined || query.productRunId !== input.productRunId) {
    throw notFound("Memory Query不存在");
  }
  const response =
    input.result.outcome === "success"
      ? await settleMemorySuccess(deps, input.commandId, query, input.result)
      : await settleMemoryFailure(deps, input.commandId, query, input.result.errorCode);
  if (!response.replayed) {
    const durationMs = Math.max(0, Date.parse(deps.now()) - Date.parse(query.startedAt));
    if (response.value.status === "ready" || response.value.status === "optional_failed") {
      const { snapshot: committed } = await deps.store.read({ kind: "committedSnapshot" });
      const contextPackage =
        committed.entities.contextPackages[response.value.contextPackageRef.contextPackageId];
      emitRunEvent(deps, input.productRunId, {
        level: "info",
        eventName: "context.assembly.completed",
        outcome: "success",
        productRunId: input.productRunId,
        attemptId: input.attemptId,
        contextRequestId: query.contextRequestId,
        status: response.value.status,
        memoryRequested: true,
        adoptedCount: contextPackage?.items.length ?? 0,
        excludedCount: contextPackage?.exclusions.length ?? 0,
        contextPackageRef: {
          objectType: "context_package",
          objectId: response.value.contextPackageRef.contextPackageId,
          revision: response.value.contextPackageRef.revision,
          sha256: response.value.contextPackageRef.sha256,
        },
        durationMs,
      });
    } else {
      emitRunEvent(deps, input.productRunId, {
        level: "error",
        eventName: "context.assembly.failed",
        outcome: "failure",
        productRunId: input.productRunId,
        attemptId: input.attemptId,
        contextRequestId: query.contextRequestId,
        memoryRequested: true,
        error: {
          code:
            input.result.outcome === "failure"
              ? input.result.errorCode
              : "memory.backend.unavailable",
          type: "MemoryBackendError",
        },
        durationMs,
      });
    }
  }
  return response.value;
}

interface SettledResponse {
  readonly value: PreparePlanningContextResponse;
  readonly replayed: boolean;
}

async function settleMemorySuccess(
  deps: ApplicationDeps,
  commandId: CommandId,
  query: MemoryQuery,
  checkpoint: Extract<MemoryQueryExecutionResult, { outcome: "success" }>,
): Promise<SettledResponse> {
  const normalized = normalizeMemoryQueryResult(query, checkpoint);
  if (normalized.resultSetSha256 !== checkpoint.resultSetSha256) {
    throw revisionConflict("Workflow checkpoint的Memory结果Hash不一致");
  }
  const now = deps.now();
  const contextPackageId = derivedId("ctxp", "id.context-package.v1", {
    memoryQueryId: query.memoryQueryId,
  });
  const result = await deps.store.transact({
    commandId,
    commandType: "CompleteMemoryContextQuery",
    requestSha256: hashCanonical("command.complete-memory-context-query.v1", {
      memoryQueryId: query.memoryQueryId,
      resultSetSha256: normalized.resultSetSha256,
    }),
    traceContext: { productRunId: query.productRunId },
    mutate: (draft) => {
      const committedQuery = draft.entities.memoryQueries[query.memoryQueryId];
      if (committedQuery === undefined) throw notFound("Memory Query不存在");
      if (committedQuery.status !== "pending") throw revisionConflict("Memory Query已进入终态");
      const items: ContextPackage["items"] = [];
      for (const [index, section] of normalized.sections.entries()) {
        const sha256 = computeMemoryResultSnapshotSha256({
          backendId: committedQuery.backendId,
          externalObjectIds: [...section.externalObjectIds],
          title: section.title,
          kind: section.kind,
          memoryLayer: section.memoryLayer,
          content: section.content,
          tags: [...section.tags],
          ...(section.score !== undefined ? { score: section.score } : {}),
          tokenEstimate: section.tokenEstimate,
          ...(section.sourceUpdatedAt !== undefined
            ? { sourceUpdatedAt: section.sourceUpdatedAt }
            : {}),
        });
        const memoryResultSnapshotId = derivedId("mrs", "id.memory-result-snapshot.v1", {
          memoryQueryId: committedQuery.memoryQueryId,
          index,
          sha256,
        });
        draft.entities.memoryResultSnapshots[memoryResultSnapshotId] = {
          schemaVersion: "memory-result-snapshot.v1",
          memoryResultSnapshotId,
          memoryQueryId: committedQuery.memoryQueryId,
          backendId: committedQuery.backendId,
          externalObjectIds: [...section.externalObjectIds],
          title: section.title,
          kind: section.kind,
          memoryLayer: section.memoryLayer,
          content: section.content,
          tags: [...section.tags],
          ...(section.score !== undefined ? { score: section.score } : {}),
          tokenEstimate: section.tokenEstimate,
          ...(section.sourceUpdatedAt !== undefined
            ? { sourceUpdatedAt: section.sourceUpdatedAt }
            : {}),
          sha256,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        items.push({
          kind: "memory_snapshot",
          memoryResultSnapshotId,
          revision: 1,
          sha256,
          selection: "retrieved",
          reasonCode: "within_budget",
        });
      }
      const packageShape = {
        contextRequestId: committedQuery.contextRequestId,
        productRunId: committedQuery.productRunId,
        assembledForPlanRevision: committedQuery.planRevision,
        purpose: "planning" as const,
        memoryQueryId: committedQuery.memoryQueryId,
        items,
        exclusions: [],
      };
      const contextPackage: ContextPackage = {
        schemaVersion: "context-package.v1",
        contextPackageId,
        ...packageShape,
        sha256: computeContextPackageSha256(packageShape),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.contextPackages[contextPackageId] = contextPackage;
      for (const item of items) {
        const memoryAdoptionId = derivedId("mad", "id.memory-adoption.v1", {
          contextPackageId,
          memoryResultSnapshotId: item.memoryResultSnapshotId,
        });
        draft.entities.memoryAdoptions[memoryAdoptionId] = {
          schemaVersion: "memory-adoption.v1",
          memoryAdoptionId,
          productRunId: committedQuery.productRunId,
          contextPackageId,
          memoryResultSnapshotId: item.memoryResultSnapshotId,
          status: "adopted",
          reasonCode: "within_budget",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
      }
      draft.entities.memoryQueries[committedQuery.memoryQueryId] = {
        ...committedQuery,
        status: "completed",
        externalQueryId: normalized.externalQueryId,
        hitCount: normalized.hitCount,
        adoptedCount: items.length,
        tokenEstimate: normalized.tokenEstimate,
        resultSetSha256: normalized.resultSetSha256,
        completedAt: now,
        revision: 2,
        updatedAt: now,
      };
      return { resultRefs: { contextPackageId, productRunId: committedQuery.productRunId } };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const contextPackage =
    snapshot.entities.contextPackages[result.resultRefs["contextPackageId"] ?? ""];
  if (contextPackage === undefined) throw notFound("ContextPackage不存在");
  return { value: packageResponse(contextPackage, "ready"), replayed: result.replayed };
}

async function settleMemoryFailure(
  deps: ApplicationDeps,
  commandId: CommandId,
  query: MemoryQuery,
  errorCode: string,
): Promise<SettledResponse> {
  const now = deps.now();
  const optional = query.requirement === "optional";
  const contextPackageId = derivedId("ctxp", "id.context-package.v1", {
    memoryQueryId: query.memoryQueryId,
  });
  const result = await deps.store.transact({
    commandId,
    commandType: optional ? "CommitOptionalMemoryQueryFailure" : "CommitRequiredMemoryQueryFailure",
    requestSha256: hashCanonical("command.memory-context-failure.v1", {
      memoryQueryId: query.memoryQueryId,
      errorCode,
    }),
    traceContext: { productRunId: query.productRunId },
    mutate: (draft) => {
      const committedQuery = draft.entities.memoryQueries[query.memoryQueryId];
      if (committedQuery === undefined) throw notFound("Memory Query不存在");
      if (committedQuery.status !== "pending") throw revisionConflict("Memory Query已进入终态");
      draft.entities.memoryQueries[committedQuery.memoryQueryId] = {
        ...committedQuery,
        status: "failed",
        errorCode,
        completedAt: now,
        revision: 2,
        updatedAt: now,
      };
      if (!optional) return { resultRefs: { productRunId: committedQuery.productRunId } };
      const packageShape = {
        contextRequestId: committedQuery.contextRequestId,
        productRunId: committedQuery.productRunId,
        assembledForPlanRevision: committedQuery.planRevision,
        purpose: "planning" as const,
        memoryQueryId: committedQuery.memoryQueryId,
        items: [],
        exclusions: [
          {
            kind: "memory_backend" as const,
            backendId: committedQuery.backendId,
            reasonCode: errorCode,
          },
        ],
      };
      draft.entities.contextPackages[contextPackageId] = {
        schemaVersion: "context-package.v1",
        contextPackageId,
        ...packageShape,
        sha256: computeContextPackageSha256(packageShape),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      return { resultRefs: { contextPackageId, productRunId: committedQuery.productRunId } };
    },
  });
  if (!optional) {
    return {
      value: { schemaVersion: "chat-internal-runtime.v1", status: "required_failed" },
      replayed: result.replayed,
    };
  }
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const contextPackage =
    snapshot.entities.contextPackages[result.resultRefs["contextPackageId"] ?? ""];
  if (contextPackage === undefined) throw notFound("ContextPackage不存在");
  return {
    value: packageResponse(contextPackage, "optional_failed"),
    replayed: result.replayed,
  };
}
