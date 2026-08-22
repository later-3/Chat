import { type ProductSnapshot } from "@chat/contracts";
import {
  computeContextPackageSha256,
  computeMemoryBackendDescriptorSha256,
  computeMemoryQueryResultSha256,
  computeMemoryResultSnapshotSha256,
  computeRunContextRequestSha256,
  computeWorkspaceInstructionItemSha256,
  computeWorkspaceInstructionsSha256,
  estimateMemorySectionTokens,
  hashCanonical,
} from "@chat/domain";
import type { Fail } from "./shared.js";

export function assertLongTermContext(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const indexes = indexLongTermContext(entities);

  assertContextRequests(entities, indexes, fail);
  assertMemoryQueries(entities, indexes, fail);
  assertMemorySnapshots(entities, fail);
  assertContextPackages(entities, fail);
  assertMemoryAdoptions(entities, indexes, fail);
  assertLongTermContextCardinalityAndReuse(entities, indexes, fail);
}

type SnapshotEntities = ProductSnapshot["entities"];
type ContextRequestEntity = SnapshotEntities["contextRequests"][string];
type MemoryQueryEntity = SnapshotEntities["memoryQueries"][string];
type CompletedMemoryQueryEntity = Extract<MemoryQueryEntity, { status: "completed" }>;
type MemorySnapshotEntity = SnapshotEntities["memoryResultSnapshots"][string];
type MemoryAdoptionEntity = SnapshotEntities["memoryAdoptions"][string];
type PlanningAttemptEntity = SnapshotEntities["attempts"][string];

interface LongTermContextIndexes {
  readonly requestCountByRun: ReadonlyMap<string, number>;
  readonly requestByRun: ReadonlyMap<string, ContextRequestEntity>;
  readonly queryCountByRequest: ReadonlyMap<string, number>;
  readonly packageCountByQuery: ReadonlyMap<string, number>;
  readonly adoptionsByPackage: ReadonlyMap<string, readonly MemoryAdoptionEntity[]>;
  readonly packageItemCountBySnapshot: ReadonlyMap<string, number>;
  readonly adoptionCountBySnapshot: ReadonlyMap<string, number>;
  readonly planningAttemptsByRun: ReadonlyMap<string, readonly PlanningAttemptEntity[]>;
}

/** 多个基数不变量共享同一批索引，避免在完整性校验中反复扫描整张对象图。 */
function indexLongTermContext(entities: SnapshotEntities): LongTermContextIndexes {
  const requestCountByRun = new Map<string, number>();
  const requestByRun = new Map<string, ContextRequestEntity>();
  for (const request of Object.values(entities.contextRequests)) {
    requestCountByRun.set(
      request.productRunId,
      (requestCountByRun.get(request.productRunId) ?? 0) + 1,
    );
    if (!requestByRun.has(request.productRunId)) requestByRun.set(request.productRunId, request);
  }

  const queryCountByRequest = new Map<string, number>();
  for (const query of Object.values(entities.memoryQueries)) {
    queryCountByRequest.set(
      query.contextRequestId,
      (queryCountByRequest.get(query.contextRequestId) ?? 0) + 1,
    );
  }

  const packageCountByQuery = new Map<string, number>();
  const packageItemCountBySnapshot = new Map<string, number>();
  for (const contextPackage of Object.values(entities.contextPackages)) {
    packageCountByQuery.set(
      contextPackage.memoryQueryId,
      (packageCountByQuery.get(contextPackage.memoryQueryId) ?? 0) + 1,
    );
    for (const item of contextPackage.items) {
      packageItemCountBySnapshot.set(
        item.memoryResultSnapshotId,
        (packageItemCountBySnapshot.get(item.memoryResultSnapshotId) ?? 0) + 1,
      );
    }
  }

  const adoptionsByPackage = new Map<string, MemoryAdoptionEntity[]>();
  const adoptionCountBySnapshot = new Map<string, number>();
  for (const adoption of Object.values(entities.memoryAdoptions)) {
    const packageAdoptions = adoptionsByPackage.get(adoption.contextPackageId) ?? [];
    packageAdoptions.push(adoption);
    adoptionsByPackage.set(adoption.contextPackageId, packageAdoptions);
    adoptionCountBySnapshot.set(
      adoption.memoryResultSnapshotId,
      (adoptionCountBySnapshot.get(adoption.memoryResultSnapshotId) ?? 0) + 1,
    );
  }

  const planningAttemptsByRun = new Map<string, PlanningAttemptEntity[]>();
  for (const attempt of Object.values(entities.attempts)) {
    if (attempt.kind !== "planning") continue;
    const attempts = planningAttemptsByRun.get(attempt.productRunId) ?? [];
    attempts.push(attempt);
    planningAttemptsByRun.set(attempt.productRunId, attempts);
  }

  return {
    requestCountByRun,
    requestByRun,
    queryCountByRequest,
    packageCountByQuery,
    adoptionsByPackage,
    packageItemCountBySnapshot,
    adoptionCountBySnapshot,
    planningAttemptsByRun,
  };
}

function assertContextRequests(
  entities: SnapshotEntities,
  indexes: LongTermContextIndexes,
  fail: Fail,
): void {
  for (const request of Object.values(entities.contextRequests)) {
    if (request.updatedAt !== request.createdAt) {
      fail(`contextRequest ${request.contextRequestId} 不可变时间戳不一致`);
    }
    if (
      request.memory !== undefined &&
      (new Set(request.memory.tags).size !== request.memory.tags.length ||
        new Set(request.memory.layers).size !== request.memory.layers.length)
    ) {
      fail(`contextRequest ${request.contextRequestId} Memory选择包含重复项`);
    }
    const run = entities.runs[request.productRunId];
    const message = entities.messages[request.sourceMessageId];
    const session = run === undefined ? undefined : entities.sessions[run.sessionId];
    if (run === undefined) {
      fail(`contextRequest ${request.contextRequestId} 悬空productRunId`);
    }
    if (
      message === undefined ||
      message.messageId !== run.sourceMessageId ||
      message.role !== "user" ||
      session === undefined ||
      session.ownerPrincipalId !== request.requestedByPrincipalId
    ) {
      fail(`contextRequest ${request.contextRequestId} 与Message/Principal不一致`);
    }
    const sourceMessageSha256 = hashCanonical("message.v1", {
      messageId: message.messageId,
      sessionId: message.sessionId,
      sessionSequence: message.sessionSequence,
      role: message.role,
      content: message.content,
    });
    if (sourceMessageSha256 !== request.sourceMessageSha256) {
      fail(`contextRequest ${request.contextRequestId} sourceMessageSha256不一致`);
    }
    if (request.schemaVersion === "run-context-request.v2") {
      const totalContentCharacters = request.workspaceInstructions.items.reduce(
        (total, item) => total + item.content.length,
        0,
      );
      if (totalContentCharacters !== request.workspaceInstructions.totalContentCharacters) {
        fail(`contextRequest ${request.contextRequestId} Workspace指令长度证据不一致`);
      }
      for (const item of request.workspaceInstructions.items) {
        if (computeWorkspaceInstructionItemSha256(item.content) !== item.sha256) {
          fail(`contextRequest ${request.contextRequestId} Workspace指令内容Hash不一致`);
        }
      }
      if (
        computeWorkspaceInstructionsSha256({
          items: request.workspaceInstructions.items,
          totalContentCharacters,
        }) !== request.workspaceInstructions.sha256
      ) {
        fail(`contextRequest ${request.contextRequestId} Workspace指令快照Hash不一致`);
      }
    }
    const requestSha256 = computeRunContextRequestSha256({
      productRunId: request.productRunId,
      requestedByPrincipalId: request.requestedByPrincipalId,
      sourceMessageId: request.sourceMessageId,
      sourceMessageSha256: request.sourceMessageSha256,
      ...(request.memory !== undefined ? { memory: request.memory } : {}),
      ...(request.schemaVersion === "run-context-request.v2"
        ? { workspaceInstructions: request.workspaceInstructions }
        : {}),
    });
    if (requestSha256 !== request.sha256) {
      fail(`contextRequest ${request.contextRequestId} Hash不一致`);
    }
  }
  for (const run of Object.values(entities.runs)) {
    if ((indexes.requestCountByRun.get(run.productRunId) ?? 0) !== 1) {
      fail(`run ${run.productRunId} 必须恰有一个ContextRequest`);
    }
  }
}

function assertMemoryQueries(
  entities: SnapshotEntities,
  indexes: LongTermContextIndexes,
  fail: Fail,
): void {
  for (const query of Object.values(entities.memoryQueries)) {
    const request = entities.contextRequests[query.contextRequestId];
    if (
      request === undefined ||
      request.memory === undefined ||
      request.productRunId !== query.productRunId ||
      request.memory.backendId !== query.backendId ||
      request.memory.requirement !== query.requirement ||
      JSON.stringify(request.memory.tags) !== JSON.stringify(query.tags) ||
      JSON.stringify(request.memory.layers) !== JSON.stringify(query.layers) ||
      request.memory.limit !== query.limit ||
      request.memory.contextBudget !== query.contextBudget
    ) {
      fail(`memoryQuery ${query.memoryQueryId} 与ContextRequest不一致`);
    }
    const run = entities.runs[query.productRunId];
    const message = run === undefined ? undefined : entities.messages[run.sourceMessageId];
    if (message === undefined) fail(`memoryQuery ${query.memoryQueryId} 源消息不存在`);
    const sourceHash = hashCanonical("message.v1", {
      messageId: message.messageId,
      sessionId: message.sessionId,
      sessionSequence: message.sessionSequence,
      role: message.role,
      content: message.content,
    });
    if (sourceHash !== query.sourceMessageSha256) {
      fail(`memoryQuery ${query.memoryQueryId} sourceMessageSha256不一致`);
    }
    if (query.planRevision !== 1) {
      fail(`memoryQuery ${query.memoryQueryId} 必须在首版规划前冻结`);
    }
    if (
      query.backendDescriptor.backendId !== query.backendId ||
      computeMemoryBackendDescriptorSha256(query.backendDescriptor) !==
        query.backendDescriptorSha256
    ) {
      fail(`memoryQuery ${query.memoryQueryId} 后端描述证据不一致`);
    }
    const capabilityLayers = new Set(query.backendDescriptor.capabilities.layers);
    if (
      capabilityLayers.size !== query.backendDescriptor.capabilities.layers.length ||
      query.layers.some((layer) => !capabilityLayers.has(layer)) ||
      query.limit > query.backendDescriptor.capabilities.maxLimit ||
      query.contextBudget > query.backendDescriptor.capabilities.maxContextBudget
    ) {
      fail(`memoryQuery ${query.memoryQueryId} 查询选择超出后端能力`);
    }
    if (
      new Set(query.tags).size !== query.tags.length ||
      new Set(query.layers).size !== query.layers.length
    ) {
      fail(`memoryQuery ${query.memoryQueryId} 查询条件包含重复项`);
    }
    if (
      query.startedAt !== query.createdAt ||
      Date.parse(query.createdAt) < Date.parse(request.createdAt) ||
      (query.status === "pending" && query.updatedAt !== query.createdAt) ||
      (query.status !== "pending" &&
        (Date.parse(query.completedAt) < Date.parse(query.startedAt) ||
          query.updatedAt !== query.completedAt))
    ) {
      fail(`memoryQuery ${query.memoryQueryId} 时间线倒置`);
    }
    if (query.status === "completed" && query.hitCount < query.adoptedCount) {
      fail(`memoryQuery ${query.memoryQueryId} hitCount小于adoptedCount`);
    }
  }
  for (const request of Object.values(entities.contextRequests)) {
    const queryCount = indexes.queryCountByRequest.get(request.contextRequestId) ?? 0;
    if (queryCount > 1 || (request.memory === undefined && queryCount !== 0)) {
      fail(`contextRequest ${request.contextRequestId} 与Memory Query数量不一致`);
    }
  }
}

function assertMemorySnapshots(entities: SnapshotEntities, fail: Fail): void {
  for (const memorySnapshot of Object.values(entities.memoryResultSnapshots)) {
    const query = entities.memoryQueries[memorySnapshot.memoryQueryId];
    if (
      query === undefined ||
      query.status !== "completed" ||
      query.backendId !== memorySnapshot.backendId
    ) {
      fail(`memorySnapshot ${memorySnapshot.memoryResultSnapshotId} 与Query不一致`);
    }
    if (
      memorySnapshot.updatedAt !== memorySnapshot.createdAt ||
      memorySnapshot.createdAt !== query.completedAt
    ) {
      fail(`memorySnapshot ${memorySnapshot.memoryResultSnapshotId} 时间线不一致`);
    }
    if (
      new Set(memorySnapshot.externalObjectIds).size !== memorySnapshot.externalObjectIds.length ||
      new Set(memorySnapshot.tags).size !== memorySnapshot.tags.length
    ) {
      fail(`memorySnapshot ${memorySnapshot.memoryResultSnapshotId} 包含重复来源或标签`);
    }
    if (estimateMemorySectionTokens(memorySnapshot) !== memorySnapshot.tokenEstimate) {
      fail(`memorySnapshot ${memorySnapshot.memoryResultSnapshotId} Token估算不一致`);
    }
    const expected = computeMemoryResultSnapshotSha256({
      backendId: memorySnapshot.backendId,
      externalObjectIds: memorySnapshot.externalObjectIds,
      title: memorySnapshot.title,
      kind: memorySnapshot.kind,
      memoryLayer: memorySnapshot.memoryLayer,
      content: memorySnapshot.content,
      tags: memorySnapshot.tags,
      ...(memorySnapshot.score !== undefined ? { score: memorySnapshot.score } : {}),
      ...(memorySnapshot.tokenEstimate !== undefined
        ? { tokenEstimate: memorySnapshot.tokenEstimate }
        : {}),
      ...(memorySnapshot.sourceUpdatedAt !== undefined
        ? { sourceUpdatedAt: memorySnapshot.sourceUpdatedAt }
        : {}),
    });
    if (expected !== memorySnapshot.sha256) {
      fail(`memorySnapshot ${memorySnapshot.memoryResultSnapshotId} Hash不一致`);
    }
  }
}

function assertContextPackages(entities: SnapshotEntities, fail: Fail): void {
  for (const contextPackage of Object.values(entities.contextPackages)) {
    const request = entities.contextRequests[contextPackage.contextRequestId];
    const query = entities.memoryQueries[contextPackage.memoryQueryId];
    if (
      request === undefined ||
      query === undefined ||
      request.productRunId !== contextPackage.productRunId ||
      query.productRunId !== contextPackage.productRunId ||
      query.contextRequestId !== contextPackage.contextRequestId ||
      query.status === "pending" ||
      contextPackage.assembledForPlanRevision !== query.planRevision
    ) {
      fail(`contextPackage ${contextPackage.contextPackageId} 血缘不一致`);
    }
    if (
      contextPackage.updatedAt !== contextPackage.createdAt ||
      contextPackage.createdAt !== query.completedAt
    ) {
      fail(`contextPackage ${contextPackage.contextPackageId} 时间线不一致`);
    }
    const seenSnapshots = new Set<string>();
    for (const item of contextPackage.items) {
      const memorySnapshot = entities.memoryResultSnapshots[item.memoryResultSnapshotId];
      if (
        memorySnapshot === undefined ||
        memorySnapshot.memoryQueryId !== query.memoryQueryId ||
        memorySnapshot.revision !== item.revision ||
        memorySnapshot.sha256 !== item.sha256 ||
        seenSnapshots.has(item.memoryResultSnapshotId)
      ) {
        fail(`contextPackage ${contextPackage.contextPackageId} item引用不一致`);
      }
      seenSnapshots.add(item.memoryResultSnapshotId);
    }
    if (query.status === "completed") {
      assertCompletedContextPackage(contextPackage, query, entities, fail);
    } else if (
      query.requirement !== "optional" ||
      contextPackage.items.length !== 0 ||
      contextPackage.exclusions.length !== 1 ||
      contextPackage.exclusions[0]?.backendId !== query.backendId ||
      contextPackage.exclusions[0]?.reasonCode !== query.errorCode
    ) {
      fail(`contextPackage ${contextPackage.contextPackageId} optional失败投影不一致`);
    }
    const expected = computeContextPackageSha256({
      contextRequestId: contextPackage.contextRequestId,
      productRunId: contextPackage.productRunId,
      assembledForPlanRevision: contextPackage.assembledForPlanRevision,
      purpose: contextPackage.purpose,
      memoryQueryId: contextPackage.memoryQueryId,
      items: contextPackage.items,
      exclusions: contextPackage.exclusions,
    });
    if (expected !== contextPackage.sha256) {
      fail(`contextPackage ${contextPackage.contextPackageId} Hash不一致`);
    }
  }
}

/** 完成态Query必须能从冻结Snapshot逐字重算结果证据，不能信任外部服务摘要。 */
function assertCompletedContextPackage(
  contextPackage: SnapshotEntities["contextPackages"][string],
  query: CompletedMemoryQueryEntity,
  entities: SnapshotEntities,
  fail: Fail,
): void {
  if (
    contextPackage.exclusions.length !== 0 ||
    query.adoptedCount !== contextPackage.items.length ||
    contextPackage.items.length > query.limit
  ) {
    fail(`contextPackage ${contextPackage.contextPackageId} 完成结果数量不一致`);
  }
  const snapshots = contextPackage.items.map(
    (item) => entities.memoryResultSnapshots[item.memoryResultSnapshotId],
  );
  if (snapshots.some((snapshot) => snapshot === undefined)) {
    fail(`contextPackage ${contextPackage.contextPackageId} 缺少Memory Snapshot`);
  }
  const presentSnapshots = snapshots.filter(
    (snapshot): snapshot is MemorySnapshotEntity => snapshot !== undefined,
  );
  const tokenEstimate = presentSnapshots.reduce(
    (total, snapshot) => total + estimateMemorySectionTokens(snapshot),
    0,
  );
  if (tokenEstimate > query.tokenEstimate || query.tokenEstimate > query.contextBudget) {
    fail(`contextPackage ${contextPackage.contextPackageId} 超预算或Token估算不一致`);
  }
  const resultSetSha256 = computeMemoryQueryResultSha256({
    externalQueryId: query.externalQueryId,
    hitCount: query.hitCount,
    tokenEstimate: query.tokenEstimate,
    sections: presentSnapshots.map((snapshot) => ({
      externalObjectIds: snapshot.externalObjectIds,
      title: snapshot.title,
      kind: snapshot.kind,
      memoryLayer: snapshot.memoryLayer,
      content: snapshot.content,
      tags: snapshot.tags,
      ...(snapshot.score !== undefined ? { score: snapshot.score } : {}),
      tokenEstimate: snapshot.tokenEstimate,
      ...(snapshot.sourceUpdatedAt !== undefined
        ? { sourceUpdatedAt: snapshot.sourceUpdatedAt }
        : {}),
    })),
  });
  if (resultSetSha256 !== query.resultSetSha256) {
    fail(`memoryQuery ${query.memoryQueryId} resultSetSha256不一致`);
  }
  const sourceCount = new Set(
    presentSnapshots.flatMap((memorySnapshot) => memorySnapshot.externalObjectIds),
  ).size;
  if (sourceCount > query.hitCount) {
    fail(`memoryQuery ${query.memoryQueryId} hitCount小于结果来源数量`);
  }
}

function assertMemoryAdoptions(
  entities: SnapshotEntities,
  indexes: LongTermContextIndexes,
  fail: Fail,
): void {
  for (const adoption of Object.values(entities.memoryAdoptions)) {
    const contextPackage = entities.contextPackages[adoption.contextPackageId];
    const memorySnapshot = entities.memoryResultSnapshots[adoption.memoryResultSnapshotId];
    if (
      contextPackage === undefined ||
      memorySnapshot === undefined ||
      contextPackage.productRunId !== adoption.productRunId ||
      !contextPackage.items.some(
        (item) => item.memoryResultSnapshotId === adoption.memoryResultSnapshotId,
      ) ||
      memorySnapshot.memoryQueryId !== contextPackage.memoryQueryId
    ) {
      fail(`memoryAdoption ${adoption.memoryAdoptionId} 绑定不一致`);
    }
    if (
      adoption.updatedAt !== adoption.createdAt ||
      adoption.createdAt !== contextPackage.createdAt ||
      adoption.createdAt !== memorySnapshot.createdAt
    ) {
      fail(`memoryAdoption ${adoption.memoryAdoptionId} 时间线不一致`);
    }
  }
  for (const contextPackage of Object.values(entities.contextPackages)) {
    const adoptions = indexes.adoptionsByPackage.get(contextPackage.contextPackageId) ?? [];
    const adoptedIds = new Set(adoptions.map((adoption) => adoption.memoryResultSnapshotId));
    if (
      adoptions.length !== contextPackage.items.length ||
      adoptedIds.size !== contextPackage.items.length ||
      contextPackage.items.some((item) => !adoptedIds.has(item.memoryResultSnapshotId))
    ) {
      fail(`contextPackage ${contextPackage.contextPackageId} 与Adoption不是一一对应`);
    }
  }
}

function assertLongTermContextCardinalityAndReuse(
  entities: SnapshotEntities,
  indexes: LongTermContextIndexes,
  fail: Fail,
): void {
  for (const memorySnapshot of Object.values(entities.memoryResultSnapshots)) {
    const itemCount = indexes.packageItemCountBySnapshot.get(memorySnapshot.memoryResultSnapshotId);
    const adoptionCount = indexes.adoptionCountBySnapshot.get(
      memorySnapshot.memoryResultSnapshotId,
    );
    if (itemCount !== 1 || adoptionCount !== 1) {
      fail(`memorySnapshot ${memorySnapshot.memoryResultSnapshotId} 必须恰好被采用一次`);
    }
  }

  for (const query of Object.values(entities.memoryQueries)) {
    const expectedPackages =
      query.status === "completed" ||
      (query.status === "failed" && query.requirement === "optional")
        ? 1
        : 0;
    if ((indexes.packageCountByQuery.get(query.memoryQueryId) ?? 0) !== expectedPackages) {
      fail(`memoryQuery ${query.memoryQueryId} 与ContextPackage数量不一致`);
    }
  }

  for (const run of Object.values(entities.runs)) {
    const request = indexes.requestByRun.get(run.productRunId);
    const planningAttempts = indexes.planningAttemptsByRun.get(run.productRunId) ?? [];
    if (
      request?.memory !== undefined &&
      planningAttempts.some((attempt) => attempt.contextPackageId === undefined)
    ) {
      fail(`run ${run.productRunId} 有ContextRequest但Planning Attempt缺少ContextPackage`);
    }
    const packageIds = new Set(
      planningAttempts.flatMap((attempt) =>
        attempt.contextPackageId === undefined ? [] : [attempt.contextPackageId],
      ),
    );
    if (packageIds.size > 1) {
      fail(`run ${run.productRunId} M1修订轮未复用同一ContextPackage`);
    }
  }
}
