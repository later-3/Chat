import {
  memoryAgentWriteNodeConfigSchema,
  type MemoryAgentEvidenceRef,
  type ProductSnapshot,
} from "@chat/contracts";
import { validateWorkflowRunSpecIntegrity } from "@chat/application/workflow-run-spec-compiler";
import {
  MEMORY_DIRECT_RUNNER_BUNDLE_VERSION,
  MEMORY_DIRECT_RUNNER_FAMILY,
  MEMORY_AGENT_DIRECT_RUNNER_BUNDLE_VERSION,
  MEMORY_AGENT_DIRECT_RUNNER_FAMILY,
} from "@chat/application/workflow-system-definitions";
import {
  computeMemoryImportBackendDescriptorSha256,
  computeMemoryImportRequestSha256,
  computeMemoryImportSemanticDedupeSha256,
  resolveMemoryImportContent,
  assertWorkflowMemoryContextOrder,
  computeMemoryProviderDescriptorSha256,
  computeMemoryWriteRequestSha256,
  computeMemoryWriteSemanticDedupeSha256,
  computeMemoryWriteImportRequestSha256,
  computeMemoryWriteImportSemanticDedupeSha256,
  computeWorkflowMemoryContextSha256,
  computeWorkflowMemoryMessageSha256,
  computeWorkflowMemoryQueryResultSha256,
  computeWorkflowMemorySnapshotSha256,
  resolveMemoryWriteContent,
  resolveMemoryWriteImportContent,
  assertMemoryAgentWriteCandidateIntegrity,
  computeMemoryAgentWriteCandidateItemSha256,
  computeMemoryAgentEvidenceManifestSha256,
  computeMemoryWriteAgentEvidenceSha256,
  computeMemoryWriteAgentCandidateRequestSha256,
  computeMemoryWriteAgentCandidateSemanticDedupeSha256,
  resolveMemoryWriteAgentCandidateContent,
  renderMemoryAgentWriteCandidateItem,
  computeMemoryAgentOperationInputSha256,
  computeMemoryAgentOperationResultSha256,
  deriveMemoryAgentOperationId,
  deriveMemoryAgentWriteCandidateId,
  computeMemoryRetrievalAgentSourceSha256,
  hashCanonical,
  MEMORY_SESSION_CONVERSION_VERSION,
  sha256Hex,
} from "@chat/domain";
import type { Fail } from "./shared.js";

type MemoryAgentWriteCandidateEntity =
  ProductSnapshot["entities"]["memoryAgentWriteCandidates"][string];

function expectedWriteCandidateProjection(
  snapshot: ProductSnapshot,
  candidate: MemoryAgentWriteCandidateEntity,
) {
  const { entities } = snapshot;
  const run = entities.runs[candidate.productRunId];
  if (run?.runKind !== "direct_agent" || run.currentDirectAgentCandidateId === undefined) {
    return undefined;
  }
  const runSpec = entities.workflowRunSpecs[run.workflowRunSpecId];
  const validated = runSpec === undefined ? undefined : validateWorkflowRunSpecIntegrity(runSpec);
  if (validated === undefined || !validated.success) return undefined;
  const writeNode = validated.runSpec.nodeResolutions.find(
    (node) => node.nodeType === "agent.memory_write",
  );
  const writeConfig = memoryAgentWriteNodeConfigSchema.safeParse(writeNode?.config);
  const directCandidate = entities.directAgentCandidates[run.currentDirectAgentCandidateId];
  const sourceMessage = entities.messages[run.sourceMessageId];
  if (
    !writeConfig.success ||
    directCandidate === undefined ||
    directCandidate.productRunId !== run.productRunId ||
    sourceMessage === undefined ||
    sourceMessage.sessionId !== run.sessionId
  ) {
    return undefined;
  }
  const evidence: {
    readonly ref: MemoryAgentEvidenceRef;
    readonly label: string;
    readonly role: "user" | "assistant";
    readonly content: string;
  }[] = Object.values(entities.messages)
    .filter(
      (message) =>
        message.sessionId === run.sessionId &&
        message.sessionSequence <= sourceMessage.sessionSequence,
    )
    .sort((left, right) => left.sessionSequence - right.sessionSequence)
    .slice(-writeConfig.data.maxSourceMessages)
    .map((message) => ({
      ref: {
        kind: "message" as const,
        messageId: message.messageId,
        messageSha256: computeWorkflowMemoryMessageSha256(message),
        role: message.role,
      },
      label: `对话消息 #${String(message.sessionSequence)}`,
      role: message.role,
      content: message.content.text,
    }));
  evidence.push({
    ref: {
      kind: "direct_agent_candidate" as const,
      directAgentCandidateId: directCandidate.directAgentCandidateId,
      candidateSha256: directCandidate.sha256,
    },
    label: "本轮执行Agent候选输出",
    role: "assistant" as const,
    content: directCandidate.output.text,
  });
  const evidenceManifest = evidence.map((item) => item.ref);
  return {
    providerId: writeConfig.data.providerId,
    evidenceManifest,
    evidenceSha256: computeMemoryWriteAgentEvidenceSha256({
      productRunId: candidate.productRunId,
      workflowRunSpecId: run.workflowRunSpecId,
      directAgentCandidateId: directCandidate.directAgentCandidateId,
      candidateSha256: directCandidate.sha256,
      evidence,
    }),
  };
}

function expectedWriteCandidateItems(
  proposal: Extract<
    ProductSnapshot["entities"]["memoryAgentOperations"][string],
    { readonly status: "succeeded" }
  >["result"] & { readonly kind: "write" },
  evidenceManifest: MemoryAgentWriteCandidateEntity["evidenceManifest"],
) {
  const items = [];
  for (const [index, proposed] of proposal.proposal.items.entries()) {
    const evidenceRefs = proposed.evidenceIndexes.map((evidenceIndex) =>
      evidenceManifest.at(evidenceIndex),
    );
    if (evidenceRefs.some((ref) => ref === undefined)) return undefined;
    const immutable = {
      itemKey: `item-${String(index + 1)}`,
      title: proposed.title.trim(),
      category: proposed.category,
      content: proposed.content.trim(),
      labels: [...new Set(proposed.labels.map((label) => label.trim().toLowerCase()))].sort(),
      evidenceRefs,
    };
    items.push({
      ...immutable,
      sha256: computeMemoryAgentWriteCandidateItemSha256(immutable as never),
    });
  }
  return items;
}

function isWorkflowMemoryRun(
  run: ProductSnapshot["entities"]["runs"][string] | undefined,
  runSpec: ProductSnapshot["entities"]["workflowRunSpecs"][string] | undefined,
): boolean {
  if (run?.runKind === "planning") return true;
  if (run?.runKind !== "direct_agent" || runSpec?.definitionRef.blueprintKey !== "direct") {
    return false;
  }
  return (
    (run.runnerFamily === MEMORY_DIRECT_RUNNER_FAMILY &&
      run.runnerBundleVersion === MEMORY_DIRECT_RUNNER_BUNDLE_VERSION &&
      runSpec.runner.runnerFamily === MEMORY_DIRECT_RUNNER_FAMILY &&
      runSpec.runner.runnerBundleVersion === MEMORY_DIRECT_RUNNER_BUNDLE_VERSION &&
      runSpec.definitionRef.blueprintVersion === 2) ||
    (run.runnerFamily === MEMORY_AGENT_DIRECT_RUNNER_FAMILY &&
      run.runnerBundleVersion === MEMORY_AGENT_DIRECT_RUNNER_BUNDLE_VERSION &&
      runSpec.runner.runnerFamily === MEMORY_AGENT_DIRECT_RUNNER_FAMILY &&
      runSpec.runner.runnerBundleVersion === MEMORY_AGENT_DIRECT_RUNNER_BUNDLE_VERSION &&
      [3, 4].includes(runSpec.definitionRef.blueprintVersion))
  );
}

export function assertWorkflowMemory(snapshot: ProductSnapshot, fail: Fail): void {
  const { entities } = snapshot;
  const snapshotsByQuery = new Map<string, (typeof entities.workflowMemorySnapshots)[string][]>();
  const operationIdsByBinding = new Map<string, string>();

  for (const operation of Object.values(entities.memoryAgentOperations)) {
    const run = entities.runs[operation.productRunId];
    const runSpec = entities.workflowRunSpecs[operation.workflowRunSpecId];
    const validated = runSpec === undefined ? undefined : validateWorkflowRunSpecIntegrity(runSpec);
    const node = validated?.success
      ? validated.runSpec.nodeResolutions.find(
          (candidate) => candidate.definitionNodeId === operation.definitionNodeId,
        )
      : undefined;
    const expectedNodeType =
      operation.operationKind === "retrieval" ? "agent.memory_retrieve" : "agent.memory_write";
    const expectedBlueprintVersions = operation.operationKind === "retrieval" ? [3, 4] : [3, 5];
    const bindingKey = [
      operation.productRunId,
      operation.workflowRunSpecId,
      operation.definitionNodeId,
      operation.operationKind,
    ].join("\u0000");
    const duplicateOperationId = operationIdsByBinding.get(bindingKey);
    operationIdsByBinding.set(bindingKey, operation.memoryAgentOperationId);
    if (
      operation.memoryAgentOperationId !==
        deriveMemoryAgentOperationId({
          productRunId: operation.productRunId,
          definitionNodeId: operation.definitionNodeId,
          operationKind: operation.operationKind,
        }) ||
      duplicateOperationId !== undefined ||
      run?.runKind !== "direct_agent" ||
      run.runnerFamily !== MEMORY_AGENT_DIRECT_RUNNER_FAMILY ||
      run.workflowRunSpecId !== operation.workflowRunSpecId ||
      runSpec?.productRunId !== operation.productRunId ||
      validated === undefined ||
      !validated.success ||
      !expectedBlueprintVersions.includes(validated.runSpec.definitionRef.blueprintVersion) ||
      node?.nodeType !== expectedNodeType ||
      node.activation === "skipped" ||
      computeMemoryAgentOperationInputSha256({
        operationKind: operation.operationKind,
        productRunId: operation.productRunId,
        workflowRunSpecId: operation.workflowRunSpecId,
        definitionNodeId: operation.definitionNodeId,
        sourceSha256: operation.sourceSha256,
      }) !== operation.inputSha256
    ) {
      fail(`memoryAgentOperation ${operation.memoryAgentOperationId} Run/Node绑定无效`);
    }
    if (
      operation.startedAt !== operation.createdAt ||
      Date.parse(operation.updatedAt) < Date.parse(operation.createdAt) ||
      (operation.status === "dispatching" &&
        (operation.revision !== 1 ||
          operation.providerRequestCount !== 0 ||
          operation.updatedAt !== operation.createdAt)) ||
      (operation.status !== "dispatching" &&
        (operation.revision !== 2 ||
          operation.updatedAt !== operation.completedAt ||
          Date.parse(operation.completedAt) < Date.parse(operation.startedAt)))
    ) {
      fail(`memoryAgentOperation ${operation.memoryAgentOperationId} 时间线无效`);
    }
    if (
      operation.status === "succeeded" &&
      (operation.result.kind !== operation.operationKind ||
        computeMemoryAgentOperationResultSha256(operation.result) !== operation.resultSha256)
    ) {
      fail(`memoryAgentOperation ${operation.memoryAgentOperationId} 结果Hash或类型无效`);
    }
  }

  for (const candidate of Object.values(entities.memoryAgentWriteCandidates)) {
    const run = entities.runs[candidate.productRunId];
    const session = entities.sessions[candidate.productSessionId];
    const operation = entities.memoryAgentOperations[candidate.memoryAgentOperationId];
    const projection = expectedWriteCandidateProjection(snapshot, candidate);
    const operationWriteResult =
      operation?.status === "succeeded" && operation.result.kind === "write"
        ? operation.result
        : undefined;
    const projectedItems =
      operationWriteResult === undefined
        ? undefined
        : expectedWriteCandidateItems(operationWriteResult, candidate.evidenceManifest);
    try {
      assertMemoryAgentWriteCandidateIntegrity(candidate);
    } catch {
      fail(`memoryAgentWriteCandidate ${candidate.memoryAgentWriteCandidateId} Hash无效`);
    }
    if (
      candidate.memoryAgentWriteCandidateId !==
        deriveMemoryAgentWriteCandidateId(candidate.productRunId) ||
      run?.runKind !== "direct_agent" ||
      run.runnerFamily !== MEMORY_AGENT_DIRECT_RUNNER_FAMILY ||
      run.sessionId !== candidate.productSessionId ||
      session === undefined ||
      operation?.status !== "succeeded" ||
      operation.operationKind !== "write" ||
      operation.productRunId !== candidate.productRunId ||
      operation.workflowRunSpecId !== run.workflowRunSpecId ||
      operation.sourceSha256 !== candidate.evidenceSha256 ||
      operation.result.kind !== "write" ||
      operation.resultSha256 !== candidate.operationResultSha256 ||
      projection === undefined ||
      projection.providerId !== candidate.providerId ||
      projection.evidenceSha256 !== candidate.evidenceSha256 ||
      computeMemoryAgentEvidenceManifestSha256(projection.evidenceManifest) !==
        computeMemoryAgentEvidenceManifestSha256(candidate.evidenceManifest) ||
      projectedItems === undefined ||
      hashCanonical("memory-agent-write-candidate-items.v1", projectedItems) !==
        hashCanonical("memory-agent-write-candidate-items.v1", candidate.items) ||
      (candidate.status === "approved" &&
        (run.status !== "succeeded" ||
          run.phase !== "completed" ||
          run.currentDirectAgentCandidateId === undefined ||
          run.currentDirectAgentCandidateId !== run.finalDirectAgentCandidateId)) ||
      new Set(candidate.items.map((item) => item.itemKey)).size !== candidate.items.length
    ) {
      fail(`memoryAgentWriteCandidate ${candidate.memoryAgentWriteCandidateId} Run或Item绑定无效`);
    }
    for (const ref of candidate.evidenceManifest) {
      if (ref.kind === "message") {
        const message = entities.messages[ref.messageId];
        if (
          message === undefined ||
          message.sessionId !== candidate.productSessionId ||
          message.role !== ref.role ||
          computeWorkflowMemoryMessageSha256(message) !== ref.messageSha256
        ) {
          fail(
            `memoryAgentWriteCandidate ${candidate.memoryAgentWriteCandidateId} Message证据无效`,
          );
        }
      } else {
        const directCandidate = entities.directAgentCandidates[ref.directAgentCandidateId];
        if (
          directCandidate === undefined ||
          directCandidate.productRunId !== candidate.productRunId ||
          directCandidate.sha256 !== ref.candidateSha256
        ) {
          fail(`memoryAgentWriteCandidate ${candidate.memoryAgentWriteCandidateId} Direct证据无效`);
        }
      }
    }
    if (candidate.status === "pending_review") continue;
    const decision = entities.memoryAgentWriteDecisions[candidate.decisionId];
    if (
      decision === undefined ||
      decision.memoryAgentWriteCandidateId !== candidate.memoryAgentWriteCandidateId ||
      decision.candidateRevision + 1 !== candidate.revision ||
      decision.candidateSha256 !== candidate.sha256 ||
      decision.principalId !== session.ownerPrincipalId ||
      (candidate.status === "approved" && decision.kind !== "approve") ||
      (candidate.status === "rejected" && decision.kind !== "reject")
    ) {
      fail(`memoryAgentWriteCandidate ${candidate.memoryAgentWriteCandidateId} Decision绑定无效`);
    }
  }
  for (const decision of Object.values(entities.memoryAgentWriteDecisions)) {
    const candidate = entities.memoryAgentWriteCandidates[decision.memoryAgentWriteCandidateId];
    if (candidate === undefined || candidate.status === "pending_review") {
      fail(`memoryAgentWriteDecision ${decision.memoryAgentWriteDecisionId} Candidate反向绑定无效`);
    }
  }

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
      run === undefined ||
      !isWorkflowMemoryRun(run, runSpec) ||
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
      (node?.nodeType !== "memory.query" && node?.nodeType !== "agent.memory_retrieve") ||
      node.activation === "skipped"
    ) {
      fail(`workflowMemoryQuery ${query.workflowMemoryQueryId} Run/Node绑定无效`);
    }
    if (node?.nodeType === "agent.memory_retrieve" && query.status !== "pending") {
      const sourceSha256 = computeMemoryRetrievalAgentSourceSha256({
        workflowMemoryQueryId: query.workflowMemoryQueryId,
        workflowRunSpecSha256: query.workflowRunSpecSha256,
        sourceMessageSha256: query.sourceMessageSha256,
        querySha256: query.querySha256,
        providerDescriptorSha256: query.providerDescriptorSha256,
        requirement: query.requirement,
        maxResults: query.maxResults,
        maxContextCharacters: query.maxContextCharacters,
      });
      const operation =
        entities.memoryAgentOperations[
          deriveMemoryAgentOperationId({
            productRunId: query.productRunId,
            definitionNodeId: query.definitionNodeId,
            operationKind: "retrieval",
          })
        ];
      const completedResultSha256 =
        operation?.status === "succeeded" && operation.result.kind === "retrieval"
          ? computeWorkflowMemoryQueryResultSha256({
              externalQueryId: operation.result.externalQueryId,
              hitCount: operation.result.hitCount,
              sections: operation.result.sections,
            })
          : undefined;
      if (
        operation === undefined ||
        operation.sourceSha256 !== sourceSha256 ||
        (query.status === "completed" &&
          (operation.status !== "succeeded" || completedResultSha256 !== query.resultSetSha256)) ||
        (query.status === "failed" &&
          operation.status !== "failed" &&
          operation.status !== "outcome_unknown")
      ) {
        fail(`workflowMemoryQuery ${query.workflowMemoryQueryId} Agent Operation绑定无效`);
      }
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
      !isWorkflowMemoryRun(run, runSpec) ||
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
    const writeCapability = intent.providerDescriptor.capabilities.write;
    if (
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
    let requestSha256: string;
    let semanticSha256: string;
    try {
      if (intent.schemaVersion === "memory-write-intent.v1") {
        const session = entities.sessions[intent.productSessionId];
        const message = entities.messages[intent.sourceSelection.sourceMessageId];
        if (
          session === undefined ||
          message === undefined ||
          message.sessionId !== session.sessionId ||
          session.ownerPrincipalId !== intent.requestedByPrincipalId
        ) {
          fail(`memoryWriteIntent ${intent.memoryWriteIntentId} Message来源无效`);
        }
        content = resolveMemoryWriteContent({
          message,
          selection: intent.sourceSelection,
          maxContentCharacters: writeCapability.maxContentCharacters,
        });
        requestSha256 = computeMemoryWriteRequestSha256({
          operationId: intent.operationId,
          providerDescriptorSha256: intent.providerDescriptorSha256,
          contentType: intent.contentType,
          sourceSelection: intent.sourceSelection,
          contentSha256: sha256Hex(content),
        });
        semanticSha256 = computeMemoryWriteSemanticDedupeSha256({
          requestedByPrincipalId: intent.requestedByPrincipalId,
          productSessionId: intent.productSessionId,
          providerId: intent.providerId,
          sourceSelection: intent.sourceSelection,
        });
      } else if (intent.schemaVersion === "memory-write-intent.v2") {
        const ownerImport =
          entities.memorySessionImports[intent.sourceSelection.memorySessionImportId];
        if (
          ownerImport === undefined ||
          ownerImport.requestedByPrincipalId !== intent.requestedByPrincipalId
        ) {
          fail(`memoryWriteIntent ${intent.memoryWriteIntentId} Session Import来源无效`);
        }
        content = resolveMemoryWriteImportContent({
          contentSnapshot: intent.contentSnapshot,
          selection: intent.sourceSelection,
          maxContentCharacters: writeCapability.maxContentCharacters,
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
        semanticSha256 = computeMemoryWriteImportSemanticDedupeSha256({
          requestedByPrincipalId: intent.requestedByPrincipalId,
          providerId: intent.providerId,
          sourceKind: intent.sourceSelection.sourceKind,
          sourceSessionId: intent.sourceSelection.sourceSessionId,
          sourceItemKey: intent.sourceSelection.sourceItemKey,
          sourceItemSha256: intent.sourceSelection.sourceItemSha256,
        });
      } else {
        const candidate =
          entities.memoryAgentWriteCandidates[intent.sourceSelection.memoryAgentWriteCandidateId];
        const session = entities.sessions[intent.productSessionId];
        const item = candidate?.items.find(
          (candidateItem) => candidateItem.itemKey === intent.sourceSelection.itemKey,
        );
        if (
          candidate === undefined ||
          candidate.status !== "approved" ||
          session?.ownerPrincipalId !== intent.requestedByPrincipalId ||
          candidate.productSessionId !== intent.productSessionId ||
          candidate.providerId !== intent.providerId ||
          candidate.sha256 !== intent.sourceSelection.candidateSha256 ||
          item === undefined ||
          item.sha256 !== intent.sourceSelection.itemSha256 ||
          !candidate.memoryWriteIntentIds.includes(intent.memoryWriteIntentId)
        ) {
          fail(`memoryWriteIntent ${intent.memoryWriteIntentId} Memory Agent候选来源无效`);
        }
        const rendered = renderMemoryAgentWriteCandidateItem(item);
        if (rendered !== intent.contentSnapshot) {
          fail(`memoryWriteIntent ${intent.memoryWriteIntentId} Memory Agent正文快照无效`);
        }
        content = resolveMemoryWriteAgentCandidateContent({
          contentSnapshot: intent.contentSnapshot,
          selection: intent.sourceSelection,
          maxContentCharacters: writeCapability.maxContentCharacters,
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
        semanticSha256 = computeMemoryWriteAgentCandidateSemanticDedupeSha256({
          requestedByPrincipalId: intent.requestedByPrincipalId,
          providerId: intent.providerId,
          productSessionId: intent.productSessionId,
          memoryAgentWriteCandidateId: intent.sourceSelection.memoryAgentWriteCandidateId,
          itemKey: intent.sourceSelection.itemKey,
          itemSha256: intent.sourceSelection.itemSha256,
        });
      }
    } catch (error) {
      fail(
        `memoryWriteIntent ${intent.memoryWriteIntentId} 来源内容无效:${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (
      requestSha256 !== intent.requestSha256 ||
      semanticSha256 !== intent.semanticDedupeSha256 ||
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
  for (const candidate of Object.values(entities.memoryAgentWriteCandidates)) {
    if (candidate.status !== "approved") continue;
    if (
      candidate.memoryWriteIntentIds.length !== candidate.items.length ||
      new Set(candidate.memoryWriteIntentIds).size !== candidate.memoryWriteIntentIds.length
    ) {
      fail(`memoryAgentWriteCandidate ${candidate.memoryAgentWriteCandidateId} Intent集合无效`);
    }
    for (const item of candidate.items) {
      const matchingIntentIds = candidate.memoryWriteIntentIds.filter((intentId) => {
        const intent = entities.memoryWriteIntents[intentId];
        return (
          intent?.schemaVersion === "memory-write-intent.v3" &&
          intent.sourceSelection.memoryAgentWriteCandidateId ===
            candidate.memoryAgentWriteCandidateId &&
          intent.sourceSelection.candidateSha256 === candidate.sha256 &&
          intent.sourceSelection.itemKey === item.itemKey &&
          intent.sourceSelection.itemSha256 === item.sha256
        );
      });
      if (matchingIntentIds.length !== 1) {
        fail(
          `memoryAgentWriteCandidate ${candidate.memoryAgentWriteCandidateId} Item ${item.itemKey} 缺少唯一v3 Intent`,
        );
      }
      const memoryWriteIntentId = matchingIntentIds[0]!;
      const matchingResults = Object.values(entities.memoryWriteResults).filter(
        (result) => result.memoryWriteIntentId === memoryWriteIntentId,
      );
      if (matchingResults.length !== 1) {
        fail(
          `memoryAgentWriteCandidate ${candidate.memoryAgentWriteCandidateId} Item ${item.itemKey} 缺少唯一Result`,
        );
      }
      const result = matchingResults[0]!;
      const initialStartOutboxes = Object.values(snapshot.outbox).filter(
        (entry) =>
          entry.kind === "memory_write_start" &&
          entry.memoryWriteIntentId === memoryWriteIntentId &&
          entry.memoryWriteResultId === result.memoryWriteResultId &&
          entry.expectedResultRevision === 1,
      );
      if (initialStartOutboxes.length !== 1) {
        fail(
          `memoryAgentWriteCandidate ${candidate.memoryAgentWriteCandidateId} Item ${item.itemKey} 缺少唯一初始Memory Write Outbox`,
        );
      }
    }
  }

  const importDedupe = new Set<string>();
  const createdIntentOwners = new Set<string>();
  for (const sessionImport of Object.values(entities.memorySessionImports)) {
    const sourceSessionId =
      sessionImport.source.kind === "chat"
        ? sessionImport.source.productSessionId
        : sessionImport.source.codexSessionId;
    const chatSession =
      sessionImport.source.kind === "chat"
        ? entities.sessions[sessionImport.source.productSessionId]
        : undefined;
    if (
      (sessionImport.source.kind === "chat" &&
        (chatSession === undefined ||
          chatSession.ownerPrincipalId !== sessionImport.requestedByPrincipalId)) ||
      sessionImport.providerDescriptor.providerId !== sessionImport.providerId ||
      computeMemoryProviderDescriptorSha256(sessionImport.providerDescriptor) !==
        sessionImport.providerDescriptorSha256 ||
      sessionImport.providerDescriptor.capabilities.write === null ||
      sessionImport.conversionVersion !== MEMORY_SESSION_CONVERSION_VERSION ||
      sessionImport.createdAt !== sessionImport.updatedAt ||
      sessionImport.createdItemCount + sessionImport.existingItemCount !==
        sessionImport.items.length ||
      sessionImport.createdItemCount !==
        sessionImport.items.filter((item) => item.disposition === "created").length ||
      new Set(sessionImport.items.map((item) => item.memoryWriteIntentId)).size !==
        sessionImport.items.length
    ) {
      fail(`memorySessionImport ${sessionImport.memorySessionImportId} 冻结合同无效`);
    }
    const previewItems = sessionImport.items.map((ref) => {
      const intent = entities.memoryWriteIntents[ref.memoryWriteIntentId];
      if (
        intent?.schemaVersion !== "memory-write-intent.v2" ||
        intent.requestedByPrincipalId !== sessionImport.requestedByPrincipalId ||
        intent.providerId !== sessionImport.providerId ||
        intent.sourceSelection.sourceKind !== sessionImport.source.kind ||
        intent.sourceSelection.sourceSessionId !== sourceSessionId ||
        intent.sourceSelection.sourceItemKey !== ref.sourceItemKey ||
        intent.sourceSelection.sourceItemSha256 !== ref.sourceItemSha256 ||
        intent.contentSnapshot.length !== ref.contentCharacters ||
        (ref.disposition === "created" &&
          (intent.sourceSelection.memorySessionImportId !== sessionImport.memorySessionImportId ||
            intent.sourceSelection.sourceSnapshotSha256 !== sessionImport.sourceSnapshotSha256))
      ) {
        fail(`memorySessionImport ${sessionImport.memorySessionImportId} Item引用无效`);
      }
      if (ref.disposition === "created") {
        if (createdIntentOwners.has(ref.memoryWriteIntentId)) {
          fail(`memoryWriteIntent ${ref.memoryWriteIntentId} 被多个Import声明为created`);
        }
        createdIntentOwners.add(ref.memoryWriteIntentId);
      }
      return {
        sourceItemKey: ref.sourceItemKey,
        sourceItemSha256: ref.sourceItemSha256,
        title: ref.title,
        contentSha256: intent.sourceSelection.contentSha256,
        contentCharacters: ref.contentCharacters,
      };
    });
    const previewSha256 = hashCanonical("memory-session-import-preview.v1", {
      source: sessionImport.source,
      sourceSnapshotSha256: sessionImport.sourceSnapshotSha256,
      conversionVersion: sessionImport.conversionVersion,
      providerId: sessionImport.providerId,
      providerDescriptorSha256: sessionImport.providerDescriptorSha256,
      items: previewItems,
    });
    const semanticDedupeSha256 = hashCanonical("memory-session-import-semantic-dedupe.v1", {
      principalId: sessionImport.requestedByPrincipalId,
      source: sessionImport.source,
      sourceSnapshotSha256: sessionImport.sourceSnapshotSha256,
      conversionVersion: sessionImport.conversionVersion,
      providerId: sessionImport.providerId,
      providerDescriptorSha256: sessionImport.providerDescriptorSha256,
      previewSha256: sessionImport.previewSha256,
    });
    if (
      previewSha256 !== sessionImport.previewSha256 ||
      semanticDedupeSha256 !== sessionImport.semanticDedupeSha256 ||
      importDedupe.has(sessionImport.semanticDedupeSha256)
    ) {
      fail(`memorySessionImport ${sessionImport.memorySessionImportId} Hash或幂等身份无效`);
    }
    importDedupe.add(sessionImport.semanticDedupeSha256);
  }
  for (const intent of Object.values(entities.memoryWriteIntents)) {
    if (
      intent.schemaVersion === "memory-write-intent.v2" &&
      !createdIntentOwners.has(intent.memoryWriteIntentId)
    ) {
      fail(`memoryWriteIntent ${intent.memoryWriteIntentId} 缺少创建它的Session Import`);
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
