import {
  INTERNAL_RUNTIME_SCHEMA_VERSION,
  memoryAgentRetrieveNodeConfigSchema,
  memoryAgentWriteCandidateIdSchema,
  memoryAgentWriteCandidateResponseSchema,
  memoryAgentWriteCandidateSchema,
  memoryAgentWriteDecisionIdSchema,
  memoryAgentWriteDecisionResponseSchema,
  memoryAgentWriteDecisionSchema,
  memoryAgentWriteNodeConfigSchema,
  memoryWriteIntentIdSchema,
  memoryWriteIntentV3Schema,
  memoryWriteResultIdSchema,
  memoryWriteResultSchema,
  type DecideMemoryAgentWriteCandidatePayload,
  type DirectAgentCandidateId,
  type MemoryAgentEvidenceRef,
  type MemoryAgentOperationId,
  type MemoryAgentWriteCandidate,
  type MemoryAgentWriteCandidateId,
  type MemoryAgentWriteDecision,
  type MemoryWriteAgentProposal,
  type PrincipalId,
  type ProductRunId,
  type WorkflowRunSpecId,
} from "@chat/contracts";
import {
  assertMemoryAgentWriteCandidateIntegrity,
  computeMemoryAgentWriteCandidateItemSha256,
  computeMemoryAgentWriteCandidateSha256,
  computeMemoryProviderDescriptorSha256,
  computeMemoryWriteAgentCandidateRequestSha256,
  computeMemoryWriteAgentCandidateSemanticDedupeSha256,
  computeMemoryWriteAgentEvidenceSha256,
  computeMemoryAgentOperationResultSha256,
  computeMemoryAgentEvidenceManifestSha256,
  computeWorkflowMemoryMessageSha256,
  hashCanonical,
  deriveMemoryAgentWriteCandidateId,
  renderMemoryAgentWriteCandidateItem,
  sha256Hex,
} from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { ApplicationError, forbidden, notFound, revisionConflict } from "./errors.js";
import { requireDirectAgentRun } from "./product-run-kind.js";
import { validateWorkflowRunSpecIntegrity } from "./workflow-run-spec-compiler.js";

interface MemoryWriteAgentEvidence {
  readonly ref: MemoryAgentEvidenceRef;
  readonly label: string;
  readonly role: "user" | "assistant";
  readonly content: string;
}

function candidateIdForRun(productRunId: ProductRunId): MemoryAgentWriteCandidateId {
  return memoryAgentWriteCandidateIdSchema.parse(deriveMemoryAgentWriteCandidateId(productRunId));
}

function decisionIdFor(
  commandId: string,
  candidateId: MemoryAgentWriteCandidateId,
): MemoryAgentWriteDecision["memoryAgentWriteDecisionId"] {
  return memoryAgentWriteDecisionIdSchema.parse(
    `mwd_${hashCanonical("id.memory-agent-write-decision.v1", {
      commandId,
      candidateId,
    }).slice(0, 32)}`,
  );
}

function intentIdFor(
  candidateId: MemoryAgentWriteCandidateId,
  itemKey: string,
): ReturnType<typeof memoryWriteIntentIdSchema.parse> {
  return memoryWriteIntentIdSchema.parse(
    `mwi_${hashCanonical("id.memory-write-intent.v3", { candidateId, itemKey }).slice(0, 32)}`,
  );
}

function resultIdFor(intentId: ReturnType<typeof memoryWriteIntentIdSchema.parse>) {
  return memoryWriteResultIdSchema.parse(
    `mwr_${hashCanonical("id.memory-write-result.v1", { intentId }).slice(0, 32)}`,
  );
}

function writeAgentContext(
  snapshot: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"],
  input: {
    readonly productRunId: ProductRunId;
    readonly workflowRunSpecId: WorkflowRunSpecId;
    readonly directAgentCandidateId: DirectAgentCandidateId;
    readonly candidateSha256: string;
  },
): {
  readonly principalId: PrincipalId;
  readonly productSessionId: MemoryAgentWriteCandidate["productSessionId"];
  readonly providerId: MemoryAgentWriteCandidate["providerId"];
  readonly required: boolean;
  readonly maxItems: number;
  readonly evidence: readonly MemoryWriteAgentEvidence[];
  readonly evidenceSha256: string;
} {
  const found = snapshot.entities.runs[input.productRunId];
  if (found === undefined) throw notFound("Product Run不存在");
  const run = requireDirectAgentRun(found);
  const rawRunSpec = snapshot.entities.workflowRunSpecs[input.workflowRunSpecId];
  const validated =
    rawRunSpec === undefined ? undefined : validateWorkflowRunSpecIntegrity(rawRunSpec);
  const candidate = snapshot.entities.directAgentCandidates[input.directAgentCandidateId];
  if (
    run.runnerFamily !== "memory-agent-direct.v1" ||
    run.workflowRunSpecId !== input.workflowRunSpecId ||
    run.currentDirectAgentCandidateId !== input.directAgentCandidateId ||
    rawRunSpec?.productRunId !== input.productRunId ||
    validated === undefined ||
    !validated.success ||
    validated.runSpec.definitionRef.blueprintKey !== "direct" ||
    validated.runSpec.definitionRef.blueprintVersion !== 3 ||
    candidate === undefined ||
    candidate.productRunId !== input.productRunId ||
    candidate.sha256 !== input.candidateSha256
  ) {
    throw revisionConflict("Memory写入Agent的RunSpec或Direct候选绑定无效");
  }
  const retrievalNode = validated.runSpec.nodeResolutions.find(
    (node) => node.nodeType === "agent.memory_retrieve",
  );
  const writeNode = validated.runSpec.nodeResolutions.find(
    (node) => node.nodeType === "agent.memory_write",
  );
  const retrievalConfig = memoryAgentRetrieveNodeConfigSchema.safeParse(retrievalNode?.config);
  const writeConfig = memoryAgentWriteNodeConfigSchema.safeParse(writeNode?.config);
  if (
    !retrievalConfig.success ||
    !writeConfig.success ||
    retrievalConfig.data.providerId !== writeConfig.data.providerId
  ) {
    throw revisionConflict("Memory Agent节点配置不存在或Provider不一致");
  }
  const session = snapshot.entities.sessions[run.sessionId];
  if (session === undefined) throw revisionConflict("Memory写入Agent的Session不存在");
  const sourceMessage = snapshot.entities.messages[run.sourceMessageId];
  if (sourceMessage === undefined || sourceMessage.sessionId !== session.sessionId) {
    throw revisionConflict("Memory写入Agent的来源Message不存在");
  }
  const messages = Object.values(snapshot.entities.messages)
    .filter(
      (message) =>
        message.sessionId === session.sessionId &&
        message.sessionSequence <= sourceMessage.sessionSequence,
    )
    .sort((left, right) => left.sessionSequence - right.sessionSequence)
    .slice(-writeConfig.data.maxSourceMessages);
  const evidence: MemoryWriteAgentEvidence[] = messages.map((message) => ({
    ref: {
      kind: "message",
      messageId: message.messageId,
      messageSha256: computeWorkflowMemoryMessageSha256(message) as never,
      role: message.role,
    },
    label: `对话消息 #${String(message.sessionSequence)}`,
    role: message.role,
    content: message.content.text,
  }));
  evidence.push({
    ref: {
      kind: "direct_agent_candidate",
      directAgentCandidateId: candidate.directAgentCandidateId,
      candidateSha256: candidate.sha256 as never,
    },
    label: "本轮执行Agent候选输出",
    role: "assistant",
    content: candidate.output.text,
  });
  const evidenceSha256 = computeMemoryWriteAgentEvidenceSha256({
    productRunId: input.productRunId,
    workflowRunSpecId: input.workflowRunSpecId,
    directAgentCandidateId: input.directAgentCandidateId,
    candidateSha256: input.candidateSha256,
    evidence,
  });
  return {
    principalId: session.ownerPrincipalId,
    productSessionId: session.sessionId,
    providerId: writeConfig.data.providerId,
    required: writeConfig.data.required,
    maxItems: writeConfig.data.maxItems,
    evidence,
    evidenceSha256,
  };
}

export async function prepareMemoryWriteAgentInput(
  deps: ApplicationDeps,
  input: {
    readonly productRunId: ProductRunId;
    readonly workflowRunSpecId: WorkflowRunSpecId;
    readonly directAgentCandidateId: DirectAgentCandidateId;
    readonly candidateSha256: string;
  },
) {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const context = writeAgentContext(snapshot, input);
  return {
    schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
    productRunId: input.productRunId,
    workflowRunSpecId: input.workflowRunSpecId,
    providerId: context.providerId,
    required: context.required,
    maxItems: context.maxItems,
    evidenceSha256: context.evidenceSha256,
    evidence: context.evidence,
  } as const;
}

export async function persistMemoryWriteAgentCandidate(
  deps: ApplicationDeps,
  input: {
    readonly commandId: Parameters<ApplicationDeps["store"]["transact"]>[0]["commandId"];
    readonly productRunId: ProductRunId;
    readonly workflowRunSpecId: WorkflowRunSpecId;
    readonly directAgentCandidateId: DirectAgentCandidateId;
    readonly candidateSha256: string;
    readonly expectedEvidenceSha256: string;
    readonly memoryAgentOperationId: MemoryAgentOperationId;
    readonly operationResultSha256: string;
    readonly proposal: MemoryWriteAgentProposal;
  },
) {
  const { snapshot: before } = await deps.store.read({ kind: "committedSnapshot" });
  const context = writeAgentContext(before, input);
  if (context.evidenceSha256 !== input.expectedEvidenceSha256) {
    throw revisionConflict("Memory写入Agent输入证据已变化");
  }
  const operation = before.entities.memoryAgentOperations[input.memoryAgentOperationId];
  if (
    operation?.status !== "succeeded" ||
    operation.operationKind !== "write" ||
    operation.productRunId !== input.productRunId ||
    operation.workflowRunSpecId !== input.workflowRunSpecId ||
    operation.definitionNodeId !== "memory-agent.write" ||
    operation.sourceSha256 !== context.evidenceSha256 ||
    operation.result.kind !== "write" ||
    operation.resultSha256 !== input.operationResultSha256 ||
    computeMemoryAgentOperationResultSha256({ kind: "write", proposal: input.proposal }) !==
      operation.resultSha256
  ) {
    throw revisionConflict("Memory写入候选未绑定已完成的耐久Agent Operation");
  }
  if (input.proposal.items.length > context.maxItems) {
    throw revisionConflict("Memory写入Agent候选超过冻结条数上限");
  }
  const now = deps.now();
  const memoryAgentWriteCandidateId = candidateIdForRun(input.productRunId);
  const evidenceManifest = context.evidence.map((item) => item.ref);
  const items = input.proposal.items.map((proposed, index) => {
    const evidenceRefs = proposed.evidenceIndexes.map((evidenceIndex) => {
      const evidence = context.evidence[evidenceIndex];
      if (evidence === undefined) throw revisionConflict("Memory写入候选引用了越界证据");
      return evidence.ref;
    });
    const immutable = {
      itemKey: `item-${String(index + 1)}`,
      title: proposed.title.trim(),
      category: proposed.category,
      content: proposed.content.trim(),
      labels: [...new Set(proposed.labels.map((label) => label.trim().toLowerCase()))].sort(),
      evidenceRefs,
    } as const;
    return {
      ...immutable,
      sha256: computeMemoryAgentWriteCandidateItemSha256(immutable) as never,
    };
  });
  const candidate =
    items.length === 0
      ? undefined
      : memoryAgentWriteCandidateSchema.parse({
          schemaVersion: "memory-agent-write-candidate.v1",
          memoryAgentWriteCandidateId,
          memoryAgentOperationId: operation.memoryAgentOperationId,
          operationResultSha256: operation.resultSha256,
          productRunId: input.productRunId,
          productSessionId: context.productSessionId,
          providerId: context.providerId,
          evidenceSha256: context.evidenceSha256,
          evidenceManifest,
          items,
          sha256: computeMemoryAgentWriteCandidateSha256({
            memoryAgentWriteCandidateId,
            memoryAgentOperationId: operation.memoryAgentOperationId,
            operationResultSha256: operation.resultSha256,
            productRunId: input.productRunId,
            productSessionId: context.productSessionId,
            providerId: context.providerId,
            evidenceSha256: context.evidenceSha256,
            evidenceManifest,
            items,
          }),
          status: "pending_review",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
  if (candidate !== undefined) assertMemoryAgentWriteCandidateIntegrity(candidate);
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "PersistMemoryWriteAgentCandidate",
    requestSha256: hashCanonical("command.persist-memory-write-agent-candidate.v1", input),
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      // 重读全部冻结引用；模型执行期间发生的产品漂移必须失败关闭。
      const currentContext = writeAgentContext(draft as typeof before, input);
      if (currentContext.evidenceSha256 !== input.expectedEvidenceSha256) {
        throw revisionConflict("Memory写入Agent输入证据已变化");
      }
      const currentOperation = draft.entities.memoryAgentOperations[input.memoryAgentOperationId];
      if (
        currentOperation?.status !== "succeeded" ||
        currentOperation.resultSha256 !== input.operationResultSha256 ||
        currentOperation.sourceSha256 !== currentContext.evidenceSha256
      ) {
        throw revisionConflict("Memory写入Agent Operation在提交前发生漂移");
      }
      const existing = draft.entities.memoryAgentWriteCandidates[memoryAgentWriteCandidateId];
      if (candidate === undefined) {
        if (existing !== undefined) throw revisionConflict("本轮已存在Memory写入候选");
        return { resultRefs: { productRunId: input.productRunId, status: "nothing_useful" } };
      }
      if (existing !== undefined && existing.sha256 !== candidate.sha256) {
        throw revisionConflict("Memory写入候选稳定身份发生Hash冲突");
      }
      draft.entities.memoryAgentWriteCandidates[memoryAgentWriteCandidateId] =
        existing ?? candidate;
      return {
        resultRefs: {
          productRunId: input.productRunId,
          status: "candidate_ready",
          memoryAgentWriteCandidateId,
        },
      };
    },
  });
  if (transaction.resultRefs["status"] === "nothing_useful") {
    return {
      schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
      productRunId: input.productRunId,
      status: "nothing_useful" as const,
    };
  }
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const committed = snapshot.entities.memoryAgentWriteCandidates[memoryAgentWriteCandidateId];
  if (committed === undefined) throw notFound("Memory写入候选不存在");
  return {
    schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
    productRunId: input.productRunId,
    status: "candidate_ready" as const,
    memoryAgentWriteCandidateId: committed.memoryAgentWriteCandidateId,
    candidateSha256: committed.sha256,
  };
}

function requireCandidateOwner(
  snapshot: Awaited<ReturnType<ApplicationDeps["store"]["read"]>>["snapshot"],
  principalId: PrincipalId,
  candidateId: MemoryAgentWriteCandidateId,
): MemoryAgentWriteCandidate {
  const candidate = snapshot.entities.memoryAgentWriteCandidates[candidateId];
  if (candidate === undefined) throw notFound("Memory写入候选不存在");
  const session = snapshot.entities.sessions[candidate.productSessionId];
  if (session === undefined || session.ownerPrincipalId !== principalId) {
    throw forbidden("无权访问该Memory写入候选");
  }
  assertMemoryAgentWriteCandidateIntegrity(candidate);
  return candidate;
}

export async function getMemoryAgentWriteCandidate(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly candidateId: MemoryAgentWriteCandidateId },
) {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  return memoryAgentWriteCandidateResponseSchema.parse({
    candidate: requireCandidateOwner(snapshot, input.principalId, input.candidateId),
  });
}

export async function listMemoryAgentWriteCandidates(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly status?: MemoryAgentWriteCandidate["status"] | undefined;
    readonly limit: number;
  },
) {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const ownedSessionIds = new Set(
    Object.values(snapshot.entities.sessions)
      .filter((session) => session.ownerPrincipalId === input.principalId)
      .map((session) => session.sessionId),
  );
  return {
    candidates: Object.values(snapshot.entities.memoryAgentWriteCandidates)
      .filter((candidate) => ownedSessionIds.has(candidate.productSessionId))
      .filter((candidate) => input.status === undefined || candidate.status === input.status)
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.memoryAgentWriteCandidateId.localeCompare(left.memoryAgentWriteCandidateId),
      )
      .slice(0, input.limit),
  };
}

export async function decideMemoryAgentWriteCandidate(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: Parameters<ApplicationDeps["store"]["transact"]>[0]["commandId"];
    readonly candidateId: MemoryAgentWriteCandidateId;
    readonly payload: DecideMemoryAgentWriteCandidatePayload;
  },
) {
  const { snapshot: before } = await deps.store.read({ kind: "committedSnapshot" });
  const candidate = requireCandidateOwner(before, input.principalId, input.candidateId);
  const decisionId = decisionIdFor(input.commandId, input.candidateId);
  const provider = deps.workflowMemoryProviders?.getWrite(candidate.providerId);
  const descriptor = provider?.describeProvider();
  const capability = descriptor?.capabilities.write;
  const now = deps.now();
  const outboxIds =
    input.payload.kind === "approve" ? candidate.items.map(() => deps.ids.outbox()) : [];
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "DecideMemoryAgentWriteCandidate",
    requestSha256: hashCanonical("command.decide-memory-agent-write-candidate.v1", input),
    traceContext: { productRunId: candidate.productRunId },
    mutate: (draft) => {
      const current = requireCandidateOwner(
        draft as typeof before,
        input.principalId,
        input.candidateId,
      );
      if (
        current.status !== "pending_review" ||
        current.revision !== input.payload.expectedCandidateRevision ||
        current.sha256 !== input.payload.expectedCandidateSha256
      ) {
        throw revisionConflict("Memory写入候选已变化或已经决定");
      }
      const decision = memoryAgentWriteDecisionSchema.parse({
        schemaVersion: "memory-agent-write-decision.v1",
        memoryAgentWriteDecisionId: decisionId,
        memoryAgentWriteCandidateId: current.memoryAgentWriteCandidateId,
        candidateRevision: current.revision,
        candidateSha256: current.sha256,
        kind: input.payload.kind,
        ...(input.payload.kind === "reject" && input.payload.reason !== undefined
          ? { reason: input.payload.reason }
          : {}),
        principalId: input.principalId,
        commandId: input.commandId,
        revision: 1,
        createdAt: now,
      });
      draft.entities.memoryAgentWriteDecisions[decisionId] = decision;
      if (input.payload.kind === "reject") {
        draft.entities.memoryAgentWriteCandidates[current.memoryAgentWriteCandidateId] =
          memoryAgentWriteCandidateSchema.parse({
            ...current,
            status: "rejected",
            decisionId,
            revision: current.revision + 1,
            updatedAt: now,
          });
        return {
          resultRefs: {
            memoryAgentWriteCandidateId: current.memoryAgentWriteCandidateId,
            memoryAgentWriteDecisionId: decisionId,
          },
        };
      }
      const foundRun = draft.entities.runs[current.productRunId];
      const run = foundRun === undefined ? undefined : requireDirectAgentRun(foundRun);
      if (
        run === undefined ||
        run.status !== "succeeded" ||
        run.phase !== "completed" ||
        run.finalDirectAgentCandidateId === undefined ||
        run.currentDirectAgentCandidateId !== run.finalDirectAgentCandidateId
      ) {
        throw revisionConflict("Direct Agent结果尚未完成Product Commit，不能采用Memory候选");
      }
      const finalDirectCandidate =
        draft.entities.directAgentCandidates[run.finalDirectAgentCandidateId];
      if (finalDirectCandidate === undefined) {
        throw revisionConflict("Direct Agent最终候选不存在，不能采用Memory候选");
      }
      const finalContext = writeAgentContext(draft as typeof before, {
        productRunId: current.productRunId,
        workflowRunSpecId: run.workflowRunSpecId,
        directAgentCandidateId: finalDirectCandidate.directAgentCandidateId,
        candidateSha256: finalDirectCandidate.sha256,
      });
      if (
        finalContext.evidenceSha256 !== current.evidenceSha256 ||
        computeMemoryAgentEvidenceManifestSha256(finalContext.evidence.map((item) => item.ref)) !==
          computeMemoryAgentEvidenceManifestSha256(current.evidenceManifest)
      ) {
        throw revisionConflict("Memory候选没有绑定本轮最终Direct Agent证据");
      }
      if (
        descriptor === undefined ||
        descriptor.providerId !== current.providerId ||
        !descriptor.configured ||
        capability === undefined ||
        capability === null
      ) {
        throw new ApplicationError({
          code: "validation_failed",
          httpStatus: 409,
          message: "Memory Provider未配置或不支持写入",
          recoveryAction: "rehydrate_and_retry",
        });
      }
      const approvedCapability = capability;
      const providerDescriptorSha256 = computeMemoryProviderDescriptorSha256(descriptor);
      const intentIds = current.items.map((item, index) => {
        const content = renderMemoryAgentWriteCandidateItem(item);
        if (content.length > approvedCapability.maxContentCharacters) {
          throw new ApplicationError({
            code: "validation_failed",
            httpStatus: 422,
            message: "Memory写入候选超过Provider正文上限",
          });
        }
        const memoryWriteIntentId = intentIdFor(current.memoryAgentWriteCandidateId, item.itemKey);
        const memoryWriteResultId = resultIdFor(memoryWriteIntentId);
        const sourceSelection = {
          kind: "agent_candidate_item" as const,
          memoryAgentWriteCandidateId: current.memoryAgentWriteCandidateId,
          candidateSha256: current.sha256,
          itemKey: item.itemKey,
          itemSha256: item.sha256,
          contentSha256: sha256Hex(content),
        };
        const sourceSessionKey = current.productSessionId;
        const sourceTurnKey = `${current.memoryAgentWriteCandidateId}:${item.itemKey}`;
        const requestSha256 = computeMemoryWriteAgentCandidateRequestSha256({
          operationId: memoryWriteIntentId,
          providerDescriptorSha256,
          contentType: "conversation_turn",
          sourceSelection,
          sourceSessionKey,
          sourceTurnKey,
          contentSha256: sha256Hex(content),
        });
        const semanticDedupeSha256 = computeMemoryWriteAgentCandidateSemanticDedupeSha256({
          requestedByPrincipalId: input.principalId,
          providerId: current.providerId,
          productSessionId: current.productSessionId,
          memoryAgentWriteCandidateId: current.memoryAgentWriteCandidateId,
          itemKey: item.itemKey,
          itemSha256: item.sha256,
        });
        const intent = memoryWriteIntentV3Schema.parse({
          schemaVersion: "memory-write-intent.v3",
          memoryWriteIntentId,
          operationId: memoryWriteIntentId,
          requestedByPrincipalId: input.principalId,
          productSessionId: current.productSessionId,
          sourceSelection,
          sourceSessionKey,
          sourceTurnKey,
          contentSnapshot: content,
          contentType: "conversation_turn",
          providerId: current.providerId,
          providerDescriptor: descriptor,
          providerDescriptorSha256,
          requestSha256,
          semanticDedupeSha256,
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
        return memoryWriteIntentId;
      });
      draft.entities.memoryAgentWriteCandidates[current.memoryAgentWriteCandidateId] =
        memoryAgentWriteCandidateSchema.parse({
          ...current,
          status: "approved",
          decisionId,
          memoryWriteIntentIds: intentIds,
          revision: current.revision + 1,
          updatedAt: now,
        });
      return {
        resultRefs: {
          memoryAgentWriteCandidateId: current.memoryAgentWriteCandidateId,
          memoryAgentWriteDecisionId: decisionId,
        },
      };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const committedCandidate = requireCandidateOwner(snapshot, input.principalId, input.candidateId);
  const decision = snapshot.entities.memoryAgentWriteDecisions[decisionId];
  if (decision === undefined) throw notFound("Memory写入候选Decision不存在");
  return memoryAgentWriteDecisionResponseSchema.parse({
    candidate: committedCandidate,
    decision,
  });
}
