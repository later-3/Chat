import { type ProductSnapshot } from "@chat/contracts";
import { validateWorkflowRunSpecIntegrity } from "@chat/application/workflow-run-spec-compiler";
import {
  computeMemoryImportBackendDescriptorSha256,
  computeMemoryImportRequestSha256,
  computeMemoryImportSemanticDedupeSha256,
  resolveMemoryImportContent,
  assertWorkflowMemoryContextOrder,
  computeMemoryProviderDescriptorSha256,
  computeMemoryWriteRequestSha256,
  computeMemoryWriteSemanticDedupeSha256,
  computeWorkflowMemoryContextSha256,
  computeWorkflowMemoryMessageSha256,
  computeWorkflowMemoryQueryResultSha256,
  computeWorkflowMemorySnapshotSha256,
  resolveMemoryWriteContent,
  sha256Hex,
} from "@chat/domain";
import type { Fail } from "./shared.js";

export function assertWorkflowMemory(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const snapshotsByQuery = new Map<string, (typeof entities.workflowMemorySnapshots)[string][]>();

  for (const memorySnapshot of Object.values(entities.workflowMemorySnapshots)) {
    const query = entities.workflowMemoryQueries[memorySnapshot.workflowMemoryQueryId];
    if (
      query === undefined ||
      query.status !== "completed" ||
      query.providerId !== memorySnapshot.providerId
    ) {
      fail(`workflowMemorySnapshot ${memorySnapshot.workflowMemorySnapshotId} Query绑定无效`);
    }
    if (
      memorySnapshot.createdAt !== memorySnapshot.updatedAt ||
      memorySnapshot.createdAt !== query.completedAt ||
      new Set(memorySnapshot.externalObjectIds).size !== memorySnapshot.externalObjectIds.length ||
      new Set(memorySnapshot.labels).size !== memorySnapshot.labels.length
    ) {
      fail(`workflowMemorySnapshot ${memorySnapshot.workflowMemorySnapshotId} 不可变证据无效`);
    }
    const expectedSha256 = computeWorkflowMemorySnapshotSha256({
      providerId: memorySnapshot.providerId,
      externalObjectIds: memorySnapshot.externalObjectIds,
      title: memorySnapshot.title,
      category: memorySnapshot.category,
      content: memorySnapshot.content,
      labels: memorySnapshot.labels,
      ...(memorySnapshot.score !== undefined ? { score: memorySnapshot.score } : {}),
      ...(memorySnapshot.sourceUpdatedAt !== undefined
        ? { sourceUpdatedAt: memorySnapshot.sourceUpdatedAt }
        : {}),
    });
    if (expectedSha256 !== memorySnapshot.sha256) {
      fail(`workflowMemorySnapshot ${memorySnapshot.workflowMemorySnapshotId} Hash不一致`);
    }
    const values = snapshotsByQuery.get(memorySnapshot.workflowMemoryQueryId) ?? [];
    values.push(memorySnapshot);
    snapshotsByQuery.set(memorySnapshot.workflowMemoryQueryId, values);
  }

  for (const query of Object.values(entities.workflowMemoryQueries)) {
    const run = entities.runs[query.productRunId];
    const session = run === undefined ? undefined : entities.sessions[run.sessionId];
    const message = entities.messages[query.sourceMessageId];
    const runSpec = entities.workflowRunSpecs[query.workflowRunSpecId];
    const validated = runSpec === undefined ? undefined : validateWorkflowRunSpecIntegrity(runSpec);
    const node = validated?.success
      ? validated.runSpec.nodeResolutions.find(
          (candidate) => candidate.definitionNodeId === query.definitionNodeId,
        )
      : undefined;
    if (
      run?.runKind !== "planning" ||
      session === undefined ||
      message === undefined ||
      message.messageId !== run.sourceMessageId ||
      message.sessionId !== session.sessionId ||
      session.ownerPrincipalId !== query.requestedByPrincipalId ||
      run.workflowRunSpecId !== query.workflowRunSpecId ||
      runSpec?.productRunId !== query.productRunId ||
      runSpec.sha256 !== query.workflowRunSpecSha256 ||
      validated === undefined ||
      !validated.success ||
      node?.nodeType !== "memory.query" ||
      node.activation === "skipped"
    ) {
      fail(`workflowMemoryQuery ${query.workflowMemoryQueryId} Run/Node绑定无效`);
    }
    const configuredProvider = node?.config["providerId"];
    const configuredRequired = node?.config["required"];
    const configuredMaxResults = node?.config["maxResults"];
    const configuredMaxCharacters = node?.config["maxContextCharacters"];
    if (
      configuredProvider !== query.providerId ||
      configuredRequired !== (query.requirement === "required") ||
      configuredMaxResults !== query.maxResults ||
      configuredMaxCharacters !== query.maxContextCharacters ||
      query.operationId !== query.workflowMemoryQueryId ||
      query.providerDescriptor.providerId !== query.providerId ||
      computeMemoryProviderDescriptorSha256(query.providerDescriptor) !==
        query.providerDescriptorSha256 ||
      query.providerDescriptor.capabilities.query === null ||
      query.maxResults > query.providerDescriptor.capabilities.query.maxResults ||
      query.maxContextCharacters >
        query.providerDescriptor.capabilities.query.maxContextCharacters ||
      computeWorkflowMemoryMessageSha256(message) !== query.sourceMessageSha256 ||
      sha256Hex(message.content.text) !== query.querySha256
    ) {
      fail(`workflowMemoryQuery ${query.workflowMemoryQueryId} 冻结请求证据无效`);
    }
    if (
      query.startedAt !== query.createdAt ||
      (query.status === "pending" &&
        (query.revision !== 1 || query.updatedAt !== query.createdAt)) ||
      (query.status !== "pending" &&
        (query.revision !== 2 ||
          query.updatedAt !== query.completedAt ||
          Date.parse(query.completedAt) < Date.parse(query.startedAt)))
    ) {
      fail(`workflowMemoryQuery ${query.workflowMemoryQueryId} 时间线无效`);
    }
    const selected = (snapshotsByQuery.get(query.workflowMemoryQueryId) ?? []).sort((left, right) =>
      left.workflowMemorySnapshotId.localeCompare(right.workflowMemorySnapshotId),
    );
    if (query.status === "completed") {
      const sections = selected.map((item) => ({
        externalObjectIds: item.externalObjectIds,
        title: item.title,
        category: item.category,
        content: item.content,
        labels: item.labels,
        ...(item.score !== undefined ? { score: item.score } : {}),
        ...(item.sourceUpdatedAt !== undefined ? { sourceUpdatedAt: item.sourceUpdatedAt } : {}),
      }));
      if (
        query.selectedCount !== selected.length ||
        query.hitCount < query.selectedCount ||
        query.selectedCharacters !==
          selected.reduce((sum, item) => sum + item.title.length + item.content.length, 0) ||
        computeWorkflowMemoryQueryResultSha256({
          externalQueryId: query.externalQueryId,
          hitCount: query.hitCount,
          sections,
        }) !== query.resultSetSha256
      ) {
        fail(`workflowMemoryQuery ${query.workflowMemoryQueryId} 结果证据无效`);
      }
    } else if (selected.length !== 0) {
      fail(`workflowMemoryQuery ${query.workflowMemoryQueryId} 非成功状态不能拥有Snapshot`);
    }
  }

  for (const context of Object.values(entities.workflowMemoryContexts)) {
    const run = entities.runs[context.productRunId];
    const runSpec = entities.workflowRunSpecs[context.workflowRunSpecId];
    if (
      run === undefined ||
      run.workflowRunSpecId !== context.workflowRunSpecId ||
      runSpec?.productRunId !== context.productRunId ||
      runSpec.sha256 !== context.workflowRunSpecSha256 ||
      context.createdAt !== context.updatedAt
    ) {
      fail(`workflowMemoryContext ${context.workflowMemoryContextId} RunSpec绑定无效`);
    }
    try {
      assertWorkflowMemoryContextOrder(context);
    } catch (error) {
      fail(
        `workflowMemoryContext ${context.workflowMemoryContextId} ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    for (const ref of context.queries) {
      const query = entities.workflowMemoryQueries[ref.workflowMemoryQueryId];
      if (
        query === undefined ||
        query.productRunId !== context.productRunId ||
        query.workflowRunSpecId !== context.workflowRunSpecId ||
        query.revision !== ref.revision ||
        query.providerId !== ref.providerId ||
        (ref.outcome === "completed" &&
          (query.status !== "completed" || query.resultSetSha256 !== ref.resultSetSha256)) ||
        (ref.outcome === "optional_failed" &&
          (query.status !== "failed" ||
            query.requirement !== "optional" ||
            query.errorCode !== ref.errorCode))
      ) {
        fail(`workflowMemoryContext ${context.workflowMemoryContextId} Query引用无效`);
      }
    }
    let totalContentCharacters = 0;
    for (const ref of context.items) {
      const item = entities.workflowMemorySnapshots[ref.workflowMemorySnapshotId];
      const query =
        item === undefined ? undefined : entities.workflowMemoryQueries[item.workflowMemoryQueryId];
      if (
        item === undefined ||
        item.revision !== ref.revision ||
        item.sha256 !== ref.sha256 ||
        query?.productRunId !== context.productRunId ||
        !context.queries.some(
          (candidate) => candidate.workflowMemoryQueryId === item.workflowMemoryQueryId,
        )
      ) {
        fail(`workflowMemoryContext ${context.workflowMemoryContextId} Snapshot引用无效`);
      }
      totalContentCharacters += item.title.length + item.content.length;
    }
    if (
      totalContentCharacters !== context.totalContentCharacters ||
      computeWorkflowMemoryContextSha256({
        productRunId: context.productRunId,
        workflowRunSpecId: context.workflowRunSpecId,
        workflowRunSpecSha256: context.workflowRunSpecSha256,
        queries: context.queries,
        items: context.items,
        totalContentCharacters: context.totalContentCharacters,
      }) !== context.sha256
    ) {
      fail(`workflowMemoryContext ${context.workflowMemoryContextId} Hash或字符统计无效`);
    }
  }

  const resultCountByIntent = new Map<string, number>();
  const semanticDedupe = new Set<string>();
  for (const intent of Object.values(entities.memoryWriteIntents)) {
    const session = entities.sessions[intent.productSessionId];
    const message = entities.messages[intent.sourceSelection.sourceMessageId];
    const writeCapability = intent.providerDescriptor.capabilities.write;
    if (
      session === undefined ||
      message === undefined ||
      message.sessionId !== session.sessionId ||
      session.ownerPrincipalId !== intent.requestedByPrincipalId ||
      intent.operationId !== intent.memoryWriteIntentId ||
      intent.providerDescriptor.providerId !== intent.providerId ||
      computeMemoryProviderDescriptorSha256(intent.providerDescriptor) !==
        intent.providerDescriptorSha256 ||
      writeCapability === null ||
      intent.createdAt !== intent.updatedAt
    ) {
      fail(`memoryWriteIntent ${intent.memoryWriteIntentId} 来源或Provider证据无效`);
    }
    let content: string;
    try {
      content = resolveMemoryWriteContent({
        message,
        selection: intent.sourceSelection,
        maxContentCharacters: writeCapability.maxContentCharacters,
      });
    } catch (error) {
      fail(
        `memoryWriteIntent ${intent.memoryWriteIntentId} 来源内容无效:${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (
      computeMemoryWriteRequestSha256({
        operationId: intent.operationId,
        providerDescriptorSha256: intent.providerDescriptorSha256,
        contentType: intent.contentType,
        sourceSelection: intent.sourceSelection,
        contentSha256: sha256Hex(content),
      }) !== intent.requestSha256 ||
      computeMemoryWriteSemanticDedupeSha256({
        requestedByPrincipalId: intent.requestedByPrincipalId,
        productSessionId: intent.productSessionId,
        providerId: intent.providerId,
        sourceSelection: intent.sourceSelection,
      }) !== intent.semanticDedupeSha256 ||
      semanticDedupe.has(intent.semanticDedupeSha256)
    ) {
      fail(`memoryWriteIntent ${intent.memoryWriteIntentId} 请求Hash或语义幂等无效`);
    }
    semanticDedupe.add(intent.semanticDedupeSha256);
  }

  for (const result of Object.values(entities.memoryWriteResults)) {
    const intent = entities.memoryWriteIntents[result.memoryWriteIntentId];
    if (intent === undefined || Date.parse(result.createdAt) < Date.parse(intent.createdAt)) {
      fail(`memoryWriteResult ${result.memoryWriteResultId} Intent绑定或时间线无效`);
    }
    resultCountByIntent.set(
      result.memoryWriteIntentId,
      (resultCountByIntent.get(result.memoryWriteIntentId) ?? 0) + 1,
    );
    if (
      (["dispatching", "accepted", "materialized"].includes(result.status) &&
        result.dispatchAttempts < 1) ||
      result.reconcileAttempts > result.revision ||
      Date.parse(result.updatedAt) < Date.parse(result.createdAt)
    ) {
      fail(`memoryWriteResult ${result.memoryWriteResultId} 计数或时间线无效`);
    }
    if (
      result.status === "queued" &&
      (result.dispatchAttempts !== 0 || result.reconcileAttempts !== 0 || result.revision !== 1)
    ) {
      fail(`memoryWriteResult ${result.memoryWriteResultId} queued状态无效`);
    }
    if (
      result.status === "dispatching" &&
      (result.dispatchStartedAt !== result.updatedAt || result.dispatchAttempts < 1)
    ) {
      fail(`memoryWriteResult ${result.memoryWriteResultId} dispatching状态无效`);
    }
    if (
      (result.status === "accepted" || result.status === "materialized") &&
      Date.parse(result.acceptedAt) < Date.parse(result.createdAt)
    ) {
      fail(`memoryWriteResult ${result.memoryWriteResultId} accepted时间线无效`);
    }
    if (
      result.status === "materialized" &&
      Date.parse(result.materializedAt) < Date.parse(result.acceptedAt)
    ) {
      fail(`memoryWriteResult ${result.memoryWriteResultId} materialized时间线无效`);
    }
    if (result.status === "failed" && result.failedAt !== result.updatedAt) {
      fail(`memoryWriteResult ${result.memoryWriteResultId} failed时间线无效`);
    }
    if (
      result.status === "outcome_unknown" &&
      (Date.parse(result.unknownSince) > Date.parse(result.updatedAt) ||
        (result.lastReconciledAt !== undefined && result.lastReconciledAt !== result.updatedAt))
    ) {
      fail(`memoryWriteResult ${result.memoryWriteResultId} outcome_unknown时间线无效`);
    }
  }
  for (const intent of Object.values(entities.memoryWriteIntents)) {
    if ((resultCountByIntent.get(intent.memoryWriteIntentId) ?? 0) !== 1) {
      fail(`memoryWriteIntent ${intent.memoryWriteIntentId} 必须恰有一个Result`);
    }
  }
}

export function assertMemoryImports(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const resultCountByIntent = new Map<string, number>();
  const liveDedupe = new Set<string>();

  for (const intent of Object.values(entities.memoryImportIntents)) {
    const message = entities.messages[intent.sourceSelection.sourceMessageId];
    const session = message === undefined ? undefined : entities.sessions[message.sessionId];
    if (
      message === undefined ||
      session === undefined ||
      session.ownerPrincipalId !== intent.requestedByPrincipalId
    ) {
      fail(`memoryImportIntent ${intent.memoryImportIntentId} 来源Message/Principal不一致`);
    }
    if (
      intent.operationId !== intent.memoryImportIntentId ||
      intent.backendDescriptor.backendId !== intent.backendId ||
      !intent.backendDescriptor.configured ||
      intent.memoryLayer !== intent.backendDescriptor.capabilities.layers[0] ||
      intent.updatedAt !== intent.createdAt
    ) {
      fail(`memoryImportIntent ${intent.memoryImportIntentId} 冻结字段不一致`);
    }
    if (
      new Set(intent.tags).size !== intent.tags.length ||
      JSON.stringify([...intent.tags].sort()) !== JSON.stringify(intent.tags)
    ) {
      fail(`memoryImportIntent ${intent.memoryImportIntentId} 标签未规范化`);
    }
    try {
      const content = resolveMemoryImportContent({
        message,
        selection: intent.sourceSelection,
        maxContentChars: intent.backendDescriptor.capabilities.maxContentChars,
      });
      if (
        computeMemoryImportBackendDescriptorSha256(intent.backendDescriptor) !==
        intent.backendDescriptorSha256
      ) {
        fail(`memoryImportIntent ${intent.memoryImportIntentId} Backend Hash不一致`);
      }
      if (
        computeMemoryImportRequestSha256(
          intent.backendDescriptor.kind === "tencent_memorycore"
            ? {
                kind: "tencent_conversation_capture",
                content,
                layer: "L0",
                turnId: message.messageId,
              }
            : {
                content,
                layer: "L2",
                title: intent.title,
                tags: intent.tags,
                turnId: message.messageId,
              },
        ) !== intent.requestSha256
      ) {
        fail(`memoryImportIntent ${intent.memoryImportIntentId} Request Hash不一致`);
      }
      if (
        computeMemoryImportSemanticDedupeSha256({
          requestedByPrincipalId: intent.requestedByPrincipalId,
          sourceSelection: intent.sourceSelection,
          backendId: intent.backendId,
          title: intent.title,
          tags: intent.tags,
        }) !== intent.semanticDedupeSha256
      ) {
        fail(`memoryImportIntent ${intent.memoryImportIntentId} Semantic Hash不一致`);
      }
    } catch (error) {
      fail(
        `memoryImportIntent ${intent.memoryImportIntentId} 内容证据无效:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const result of Object.values(entities.memoryImportResults)) {
    const intent = entities.memoryImportIntents[result.memoryImportIntentId];
    if (intent === undefined) {
      fail(`memoryImportResult ${result.memoryImportResultId} 悬空Intent`);
    }
    resultCountByIntent.set(
      result.memoryImportIntentId,
      (resultCountByIntent.get(result.memoryImportIntentId) ?? 0) + 1,
    );
    if (Date.parse(result.updatedAt) < Date.parse(result.createdAt)) {
      fail(`memoryImportResult ${result.memoryImportResultId} 时间线倒置`);
    }
    if (
      (result.status === "queued" &&
        (result.dispatchAttempts !== 0 || result.reconcileAttempts !== 0)) ||
      (result.status === "dispatching" &&
        (result.dispatchAttempts < 1 || result.dispatchStartedAt !== result.updatedAt)) ||
      (result.status === "accepted" &&
        (result.dispatchAttempts < 1 ||
          Date.parse(result.acceptedAt) > Date.parse(result.updatedAt))) ||
      (result.status === "materialized" &&
        (result.dispatchAttempts < 1 ||
          result.reconcileAttempts < 1 ||
          result.materializedAt !== result.updatedAt ||
          Date.parse(result.acceptedAt) > Date.parse(result.materializedAt))) ||
      (result.status === "failed" && result.failedAt !== result.updatedAt) ||
      (result.status === "outcome_unknown" &&
        (Date.parse(result.unknownSince) > Date.parse(result.updatedAt) ||
          (result.lastReconciledAt !== undefined && result.lastReconciledAt !== result.updatedAt)))
    ) {
      fail(`memoryImportResult ${result.memoryImportResultId} 状态时间或计数不一致`);
    }
    if (result.status !== "failed") {
      if (liveDedupe.has(intent.semanticDedupeSha256)) {
        fail(`memoryImportIntent semanticDedupeSha256重复`);
      }
      liveDedupe.add(intent.semanticDedupeSha256);
    }
  }

  for (const intent of Object.values(entities.memoryImportIntents)) {
    if ((resultCountByIntent.get(intent.memoryImportIntentId) ?? 0) !== 1) {
      fail(`memoryImportIntent ${intent.memoryImportIntentId} 必须恰有一个Result`);
    }
  }
}
