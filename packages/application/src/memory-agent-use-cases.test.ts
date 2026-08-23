import { describe, expect, it } from "vitest";
import {
  createEmptySnapshot,
  type CommandId,
  type MemoryBackendId,
  type MemoryProviderDescriptor,
  type PrincipalId,
  type ProductSnapshot,
} from "@chat/contracts";
import { computeMemoryAgentOperationInputSha256 } from "@chat/domain";
import type { ApplicationDeps, DirectAgentIdFactory, IdFactory } from "./deps.js";
import type {
  ProductStorePort,
  ProductTransaction,
  ProductTransactionResult,
} from "./product-store-port.js";
import {
  commitDirectAgentResult,
  persistDirectAgentCandidate,
} from "./direct-agent-runtime-use-cases.js";
import {
  beginMemoryAgentOperation,
  completeMemoryAgentOperation,
} from "./memory-agent-operation-use-cases.js";
import {
  decideMemoryAgentWriteCandidate,
  getMemoryAgentWriteCandidate,
  prepareMemoryWriteAgentInput,
  persistMemoryWriteAgentCandidate,
} from "./memory-agent-use-cases.js";
import { BUILTIN_WORKFLOW_EXECUTOR_MANIFEST } from "./workflow-executor-manifest.js";
import { compileWorkflowRunSpec } from "./workflow-run-spec-compiler.js";
import {
  createSystemMemoryAgentDirectDefinition,
  MEMORY_AGENT_DIRECT_RUNNER_BUNDLE_VERSION,
  MEMORY_AGENT_DIRECT_RUNNER_FAMILY,
} from "./workflow-system-definitions.js";

const NOW = "2026-08-24T12:00:00.000Z";
const OWNER = "usr_memoryagentowner" as PrincipalId;
const OTHER_PRINCIPAL = "usr_memoryagentother" as PrincipalId;
const PROVIDER_ID = "mbk_memmy" as MemoryBackendId;

class InMemoryProductStore implements ProductStorePort {
  #snapshot: ProductSnapshot;
  readonly #receipts = new Map<
    string,
    { readonly requestSha256: string; readonly result: ProductTransactionResult }
  >();

  constructor(snapshot: ProductSnapshot) {
    this.#snapshot = structuredClone(snapshot);
  }

  async read(): Promise<{ readonly snapshot: Readonly<ProductSnapshot> }> {
    return { snapshot: structuredClone(this.#snapshot) };
  }

  async transact(transaction: ProductTransaction): Promise<ProductTransactionResult> {
    const prior = this.#receipts.get(transaction.commandId);
    if (prior !== undefined) {
      if (prior.requestSha256 !== transaction.requestSha256) {
        throw new Error("测试Store检测到commandId复用");
      }
      return { ...prior.result, replayed: true };
    }
    const draft = structuredClone(this.#snapshot);
    const mutation = transaction.mutate(draft);
    draft.storeRevision += 1;
    draft.committedAt = NOW;
    const result = {
      storeRevision: draft.storeRevision,
      resultRefs: { ...mutation.resultRefs },
      replayed: false,
    } satisfies ProductTransactionResult;
    this.#snapshot = draft;
    this.#receipts.set(transaction.commandId, {
      requestSha256: transaction.requestSha256,
      result,
    });
    return result;
  }

  inspect(): ProductSnapshot {
    return structuredClone(this.#snapshot);
  }
}

function providerDescriptor(input?: {
  readonly configured?: boolean;
  readonly providerId?: MemoryBackendId;
}): MemoryProviderDescriptor {
  return {
    schemaVersion: "memory-provider-descriptor.v1",
    providerId: input?.providerId ?? PROVIDER_ID,
    displayName: "Memory Agent测试Provider",
    providerKind: "memmy",
    transport: "http",
    adapterContractVersion: "memory-agent-test.v1",
    configured: input?.configured ?? true,
    configurationFingerprint: "a".repeat(64) as never,
    capabilities: {
      query: { maxResults: 20, maxContextCharacters: 50_000 },
      write: {
        maxContentCharacters: 50_000,
        materialization: "synchronous",
        idempotency: "provider_key",
      },
      reconcile: true,
      management: { list: true, get: true, update: false, delete: false, history: false },
    },
    authMode: "none",
    credentialRevision: "none",
  };
}

function fixture(options?: { readonly descriptor?: MemoryProviderDescriptor }) {
  const system = createSystemMemoryAgentDirectDefinition(NOW);
  const runSpec = compileWorkflowRunSpec({
    workflowRunSpecId: "wrs_memoryagent1" as never,
    productRunId: "run_memoryagent1" as never,
    createdAt: NOW,
    definition: {
      schemaVersion: "workflow-definition-revision-input.v1",
      workflowDefinitionRevisionId: system.revision.workflowDefinitionRevisionId,
      definitionRevision: system.revision.definitionRevision,
      blueprintKey: system.revision.blueprintKey,
      blueprintVersion: system.revision.blueprintVersion,
      semanticRoot: system.revision.semanticRoot,
      expectedSha256: system.revision.definitionSha256,
    },
    runConfiguration: { schemaVersion: "workflow-run-configuration.v1", overrides: [] },
    principal: { principalId: OWNER, capabilities: [] },
    availableResources: [],
    executorManifest: BUILTIN_WORKFLOW_EXECUTOR_MANIFEST,
    runner: {
      runnerFamily: MEMORY_AGENT_DIRECT_RUNNER_FAMILY,
      runnerBundleVersion: MEMORY_AGENT_DIRECT_RUNNER_BUNDLE_VERSION,
    },
    businessInput: { kind: "direct_agent_message" },
  });
  if (!runSpec.success) throw new Error(JSON.stringify(runSpec.diagnostics));

  const snapshot = createEmptySnapshot(NOW);
  const sessionId = "psn_memoryagent1" as const;
  const messageId = "msg_memoryagent1" as const;
  const runId = "run_memoryagent1" as const;
  const directAttemptId = "att_memoryagentdirect1" as const;
  snapshot.entities.sessions[sessionId] = {
    schemaVersion: "product-session.v1",
    sessionId: sessionId as never,
    ownerPrincipalId: OWNER,
    status: "active",
    lastMessageSequence: 1,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.messages[messageId] = {
    schemaVersion: "message.v1",
    messageId: messageId as never,
    sessionId: sessionId as never,
    sessionSequence: 1,
    role: "user",
    content: { format: "markdown", text: "我的工作流默认先读取架构合同。" },
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.workflowDefinitions[system.definition.workflowDefinitionId] = system.definition;
  snapshot.entities.workflowDefinitionRevisions[system.revision.workflowDefinitionRevisionId] =
    system.revision;
  snapshot.entities.workflowViewDefinitions[system.view.workflowViewDefinitionId] = system.view;
  snapshot.entities.workflowRunSpecs[runSpec.runSpec.workflowRunSpecId] = runSpec.runSpec;
  snapshot.entities.runs[runId] = {
    schemaVersion: "product-run.v3",
    runKind: "direct_agent",
    productRunId: runId as never,
    sessionId: sessionId as never,
    sourceMessageId: messageId as never,
    workflowViewDefinitionId: system.view.workflowViewDefinitionId,
    workflowRunSpecId: runSpec.runSpec.workflowRunSpecId,
    runnerFamily: MEMORY_AGENT_DIRECT_RUNNER_FAMILY,
    runnerBundleVersion: MEMORY_AGENT_DIRECT_RUNNER_BUNDLE_VERSION,
    status: "running",
    phase: "executing",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.attempts[directAttemptId] = {
    schemaVersion: "run-attempt.v1",
    attemptId: directAttemptId as never,
    productRunId: runId as never,
    kind: "direct_agent",
    outcome: "running",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };

  let outboxCounter = 0;
  const ids: IdFactory = new Proxy(
    {
      outbox: () => `obx_memoryagent${String(++outboxCounter)}` as never,
    },
    { get: (target, key) => target[key as keyof typeof target] ?? (() => "unused" as never) },
  ) as unknown as IdFactory;
  const directAgentIds: DirectAgentIdFactory = {
    promptReviewRequest: () => "prr_unused" as never,
    promptReviewDecision: () => "prd_unused" as never,
    candidate: () => "drc_memoryagent1" as never,
  };
  const descriptor = options?.descriptor ?? providerDescriptor();
  const provider = {
    describeProvider: () => descriptor,
    health: async () => ({ status: "ready" as const }),
    queryMemory: async () => {
      throw new Error("本测试不应查询外部Memory");
    },
    writeMemory: async () => {
      throw new Error("本测试不应执行外部Memory写入");
    },
    reconcileMemoryWrite: async () => {
      throw new Error("本测试不应执行外部Memory对账");
    },
  };
  const store = new InMemoryProductStore(snapshot);
  const deps: ApplicationDeps = {
    store,
    now: () => NOW,
    ids,
    directAgentIds,
    workflowMemoryProviders: {
      list: () => [descriptor],
      getQuery: () => provider,
      getWrite: () => provider,
    },
  };
  return {
    deps,
    store,
    runId: runId as never,
    sessionId: sessionId as never,
    directAttemptId: directAttemptId as never,
    workflowRunSpecId: runSpec.runSpec.workflowRunSpecId,
  };
}

async function persistPendingCandidate(f: ReturnType<typeof fixture>) {
  const direct = await persistDirectAgentCandidate(f.deps, {
    commandId: "cmd_memoryagentdirectcandidate" as CommandId,
    productRunId: f.runId,
    directAgentAttemptId: f.directAttemptId,
    output: { format: "markdown", text: "已按项目合同完成只读检查。" },
  });
  const prepared = await prepareMemoryWriteAgentInput(f.deps, {
    productRunId: f.runId,
    workflowRunSpecId: f.workflowRunSpecId,
    directAgentCandidateId: direct.directAgentCandidateId,
    candidateSha256: direct.sha256,
  });
  const proposal = {
    items: [
      {
        title: "工作流偏好",
        category: "procedure" as const,
        content: "执行工作流前，默认先读取项目架构合同。",
        labels: ["workflow", "architecture"],
        evidenceIndexes: [0],
      },
    ],
  };
  const inputSha256 = computeMemoryAgentOperationInputSha256({
    operationKind: "write",
    productRunId: f.runId,
    workflowRunSpecId: f.workflowRunSpecId,
    definitionNodeId: "memory-agent.write",
    sourceSha256: prepared.evidenceSha256,
  });
  const begun = await beginMemoryAgentOperation(f.deps, {
    commandId: "cmd_memoryagentoperationbegin" as CommandId,
    productRunId: f.runId,
    workflowRunSpecId: f.workflowRunSpecId,
    definitionNodeId: "memory-agent.write",
    operationKind: "write",
    inputSha256,
    sourceSha256: prepared.evidenceSha256,
  });
  if (begun.status !== "dispatch_required") throw new Error("测试Operation未进入dispatch_required");
  const completed = await completeMemoryAgentOperation(f.deps, {
    commandId: "cmd_memoryagentoperationcomplete" as CommandId,
    memoryAgentOperationId: begun.operation.memoryAgentOperationId,
    expectedRevision: 1,
    inputSha256,
    outcome: {
      kind: "succeeded",
      result: { kind: "write", proposal },
      providerRequestCount: 1,
    },
  });
  if (completed.operation.status !== "succeeded" || completed.operation.result.kind !== "write") {
    throw new Error("测试Operation未完成write结果");
  }
  const persisted = await persistMemoryWriteAgentCandidate(f.deps, {
    commandId: "cmd_memoryagentwritecandidate" as CommandId,
    productRunId: f.runId,
    workflowRunSpecId: f.workflowRunSpecId,
    directAgentCandidateId: direct.directAgentCandidateId,
    candidateSha256: direct.sha256,
    expectedEvidenceSha256: prepared.evidenceSha256,
    memoryAgentOperationId: completed.operation.memoryAgentOperationId,
    operationResultSha256: completed.operation.resultSha256,
    proposal,
  });
  if (persisted.status !== "candidate_ready") throw new Error("测试候选未生成");
  const candidate =
    f.store.inspect().entities.memoryAgentWriteCandidates[persisted.memoryAgentWriteCandidateId];
  if (candidate === undefined) throw new Error("测试候选未持久化");
  return { direct, persisted, candidate };
}

async function commitProductResult(
  f: ReturnType<typeof fixture>,
  direct: Awaited<ReturnType<typeof persistDirectAgentCandidate>>,
) {
  await commitDirectAgentResult(f.deps, {
    commandId: "cmd_memoryagentproductcommit" as CommandId,
    productRunId: f.runId,
    directAgentAttemptId: f.directAttemptId,
    directAgentCandidateId: direct.directAgentCandidateId,
    candidateSha256: direct.sha256,
  });
}

describe("Memory Agent写入候选用例", () => {
  it("persist只创建pending_review候选；非Owner不能读取或决定", async () => {
    const f = fixture();
    const { persisted, candidate } = await persistPendingCandidate(f);

    expect(candidate).toMatchObject({
      status: "pending_review",
      productRunId: f.runId,
      productSessionId: f.sessionId,
      providerId: PROVIDER_ID,
      items: [expect.objectContaining({ itemKey: "item-1" })],
    });
    expect(Object.values(f.store.inspect().entities.memoryWriteIntents)).toHaveLength(0);
    expect(Object.values(f.store.inspect().entities.memoryWriteResults)).toHaveLength(0);
    expect(Object.values(f.store.inspect().outbox)).toHaveLength(0);

    await expect(
      getMemoryAgentWriteCandidate(f.deps, {
        principalId: OTHER_PRINCIPAL,
        candidateId: persisted.memoryAgentWriteCandidateId,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      decideMemoryAgentWriteCandidate(f.deps, {
        principalId: OTHER_PRINCIPAL,
        commandId: "cmd_memoryagentotherdecision" as CommandId,
        candidateId: persisted.memoryAgentWriteCandidateId,
        payload: {
          kind: "reject",
          expectedCandidateRevision: candidate.revision,
          expectedCandidateSha256: candidate.sha256,
        },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("approve仅在Direct结果Product Commit后创建唯一v3 intent/result/outbox，并稳定重放", async () => {
    const f = fixture();
    const { direct, persisted, candidate } = await persistPendingCandidate(f);
    const payload = {
      kind: "approve" as const,
      expectedCandidateRevision: candidate.revision,
      expectedCandidateSha256: candidate.sha256,
    };

    await expect(
      decideMemoryAgentWriteCandidate(f.deps, {
        principalId: OWNER,
        commandId: "cmd_memoryagentapprovebeforecommit" as CommandId,
        candidateId: persisted.memoryAgentWriteCandidateId,
        payload,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(
      f.store.inspect().entities.memoryAgentWriteCandidates[persisted.memoryAgentWriteCandidateId],
    ).toMatchObject({ status: "pending_review" });

    await commitProductResult(f, direct);
    const commandId = "cmd_memoryagentapprove" as CommandId;
    const first = await decideMemoryAgentWriteCandidate(f.deps, {
      principalId: OWNER,
      commandId,
      candidateId: persisted.memoryAgentWriteCandidateId,
      payload,
    });
    const replayed = await decideMemoryAgentWriteCandidate(f.deps, {
      principalId: OWNER,
      commandId,
      candidateId: persisted.memoryAgentWriteCandidateId,
      payload,
    });
    expect(replayed).toEqual(first);

    const snapshot = f.store.inspect();
    const intents = Object.values(snapshot.entities.memoryWriteIntents);
    const results = Object.values(snapshot.entities.memoryWriteResults);
    const outbox = Object.values(snapshot.outbox).filter(
      (entry) => entry.kind === "memory_write_start",
    );
    expect(first.candidate).toMatchObject({
      status: "approved",
      memoryWriteIntentIds: [intents[0]?.memoryWriteIntentId],
    });
    expect(first.decision).toMatchObject({ kind: "approve", principalId: OWNER, commandId });
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      schemaVersion: "memory-write-intent.v3",
      requestedByPrincipalId: OWNER,
      productSessionId: f.sessionId,
      sourceSelection: {
        kind: "agent_candidate_item",
        memoryAgentWriteCandidateId: persisted.memoryAgentWriteCandidateId,
      },
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "queued" });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      memoryWriteIntentId: intents[0]?.memoryWriteIntentId,
      memoryWriteResultId: results[0]?.memoryWriteResultId,
      status: "pending",
    });
  });

  it("reject只记录Decision，不创建任何v3写入或outbox", async () => {
    const f = fixture();
    const { persisted, candidate } = await persistPendingCandidate(f);
    const rejected = await decideMemoryAgentWriteCandidate(f.deps, {
      principalId: OWNER,
      commandId: "cmd_memoryagentreject" as CommandId,
      candidateId: persisted.memoryAgentWriteCandidateId,
      payload: {
        kind: "reject",
        expectedCandidateRevision: candidate.revision,
        expectedCandidateSha256: candidate.sha256,
        reason: "这不是稳定的长期偏好",
      },
    });

    expect(rejected.candidate).toMatchObject({ status: "rejected" });
    expect(rejected.decision).toMatchObject({ kind: "reject", principalId: OWNER });
    const snapshot = f.store.inspect();
    expect(Object.values(snapshot.entities.memoryWriteIntents)).toHaveLength(0);
    expect(Object.values(snapshot.entities.memoryWriteResults)).toHaveLength(0);
    expect(Object.values(snapshot.outbox)).toHaveLength(0);
  });

  it.each([
    ["未配置Provider", providerDescriptor({ configured: false })],
    ["Provider身份漂移", providerDescriptor({ providerId: "mbk_other" as MemoryBackendId })],
  ])("approve对%s失败关闭且不产生写入", async (_label, descriptor) => {
    const f = fixture({ descriptor });
    const { direct, persisted, candidate } = await persistPendingCandidate(f);
    await commitProductResult(f, direct);

    await expect(
      decideMemoryAgentWriteCandidate(f.deps, {
        principalId: OWNER,
        commandId: "cmd_memoryagentproviderreject" as CommandId,
        candidateId: persisted.memoryAgentWriteCandidateId,
        payload: {
          kind: "approve",
          expectedCandidateRevision: candidate.revision,
          expectedCandidateSha256: candidate.sha256,
        },
      }),
    ).rejects.toMatchObject({ code: "validation_failed", httpStatus: 409 });
    const snapshot = f.store.inspect();
    expect(
      snapshot.entities.memoryAgentWriteCandidates[persisted.memoryAgentWriteCandidateId],
    ).toMatchObject({ status: "pending_review" });
    expect(Object.values(snapshot.entities.memoryWriteIntents)).toHaveLength(0);
    expect(Object.values(snapshot.entities.memoryWriteResults)).toHaveLength(0);
    expect(Object.values(snapshot.outbox)).toHaveLength(0);
  });
});
