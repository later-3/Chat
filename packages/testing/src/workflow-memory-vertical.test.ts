import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  beginWorkflowMemoryQuery,
  beginWorkflowMemoryWrite,
  commitMemoryWriteAccepted,
  commitMemoryWriteMaterialized,
  compilePlanningInput,
  createMemoryWrite,
  createProductSession,
  freezeWorkflowMemoryContext,
  loadMemoryWriteForRuntime,
  markMemoryWriteDispatching,
  normalizeWorkflowMemoryQueryResult,
  persistWorkflowMemoryQueryResult,
  submitUserMessage,
  transitionConfigurablePlanningNode,
  type ApplicationDeps,
  type IdFactory,
  type WorkflowMemoryProviderRegistryPort,
  type WorkflowMemoryQueryInput,
  type WorkflowMemoryWriteInput,
} from "@chat/application";
import { SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID } from "@chat/application/workflow-system-definitions";
import type {
  CommandId,
  CreateMemoryWritePayload,
  MemoryBackendId,
  MemoryProviderDescriptor,
  PrincipalId,
  WorkflowMemoryQueryExecutionResult,
} from "@chat/contracts";
import type { WorkflowMemoryWriteReconcileInput } from "@chat/application";
import { JsonProductStore, assertSnapshotIntegrity } from "@chat/product-store-json";
import { createExecutionTraceReader, createTraceSink } from "@chat/realtime";

const OWNER = "usr_workflowmemory" as PrincipalId;
const PROVIDER_ID = "mbk_tencentmemorycore" as MemoryBackendId;
const DESCRIPTOR: MemoryProviderDescriptor = {
  schemaVersion: "memory-provider-descriptor.v1",
  providerId: PROVIDER_ID,
  displayName: "Tencent MemoryCore（测试）",
  providerKind: "tencent_memorycore",
  transport: "http",
  adapterContractVersion: "tencent-memorycore-workflow.v1",
  configured: true,
  configurationFingerprint: "a".repeat(64) as never,
  capabilities: {
    query: { maxResults: 20, maxContextCharacters: 50_000 },
    write: {
      maxContentCharacters: 50_000,
      materialization: "asynchronous",
      idempotency: "chat_reconcile",
    },
    reconcile: true,
    management: { list: false, get: false, update: false, delete: false, history: false },
  },
  authMode: "none",
  credentialRevision: "none",
};

function ids(): IdFactory {
  let sequence = 0;
  const next = (prefix: string) => `${prefix}_workflowmemory${(++sequence).toString(36)}`;
  return {
    session: () => next("psn") as ReturnType<IdFactory["session"]>,
    message: () => next("msg") as ReturnType<IdFactory["message"]>,
    run: () => next("run") as ReturnType<IdFactory["run"]>,
    attempt: () => next("att") as ReturnType<IdFactory["attempt"]>,
    plan: () => next("pln") as ReturnType<IdFactory["plan"]>,
    planRevision: () => next("plr") as ReturnType<IdFactory["planRevision"]>,
    revisionInput: () => next("rin") as ReturnType<IdFactory["revisionInput"]>,
    approval: () => next("apr") as ReturnType<IdFactory["approval"]>,
    decision: () => next("dec") as ReturnType<IdFactory["decision"]>,
    executionContract: () => next("exc") as ReturnType<IdFactory["executionContract"]>,
    executionCandidate: () => next("xcd") as ReturnType<IdFactory["executionCandidate"]>,
    validationResult: () => next("val") as ReturnType<IdFactory["validationResult"]>,
    artifact: () => next("art") as ReturnType<IdFactory["artifact"]>,
    outbox: () => next("obx") as ReturnType<IdFactory["outbox"]>,
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "chat-workflow-memory-"));
  const traceDir = join(directory, "trace");
  let tick = 0;
  let traceTick = 0;
  let commandSequence = 0;
  let queryCalls = 0;
  let writeCalls = 0;
  let reconcileCalls = 0;
  const now = () => new Date(Date.parse("2026-08-18T10:00:00.000Z") + tick++ * 1_000).toISOString();
  const traceSink = createTraceSink({
    dir: traceDir,
    now: () => new Date(Date.parse("2026-08-18T10:00:00.000Z") + traceTick++ * 100),
  });
  const store = await JsonProductStore.open({
    filePath: join(directory, "product.json"),
    now,
  });
  const provider = {
    describeProvider: () => DESCRIPTOR,
    health: async () => ({ status: "ready" as const }),
    queryMemory: async (input: WorkflowMemoryQueryInput) => {
      queryCalls += 1;
      return {
        externalQueryId: `tencent-query-${String(queryCalls)}`,
        hitCount: 2,
        // 故意使用反序与重复标签，证明稳定排序/去重由Chat边界负责。
        sections: [
          {
            externalObjectIds: ["memory-procedure-1"],
            title: " 发布门 ",
            category: "procedure" as const,
            content: `针对“${input.query}”，发布前必须完成真实端到端测试。`,
            labels: ["Release", "release"],
            score: 0.98,
          },
          {
            externalObjectIds: ["memory-preference-1"],
            title: "执行偏好",
            category: "preference" as const,
            content: "优先复用独立服务，不在Chat内重写Memory引擎。",
            labels: ["architecture"],
            score: 0.92,
          },
        ],
      };
    },
    writeMemory: async (input: WorkflowMemoryWriteInput) => {
      writeCalls += 1;
      return {
        externalObjectId: `memory-write:${input.operationId}`,
        externalObjectVersion: "v1",
        externalStatus: "l0_accepted",
        responseSha256: "b".repeat(64),
      };
    },
    reconcileMemoryWrite: async (input: WorkflowMemoryWriteReconcileInput) => {
      reconcileCalls += 1;
      return {
        status: "materialized" as const,
        accepted: {
          externalObjectId: `memory-write:${input.operationId}`,
          externalObjectVersion: "v1",
          externalStatus: "materialized",
          responseSha256: "b".repeat(64),
        },
        verificationKind: "provider_query",
        verificationSha256: "c".repeat(64),
      };
    },
  };
  const registry: WorkflowMemoryProviderRegistryPort = {
    list: () => [DESCRIPTOR],
    getQuery: (providerId) => (providerId === PROVIDER_ID ? provider : undefined),
    getWrite: (providerId) => (providerId === PROVIDER_ID ? provider : undefined),
  };
  const deps: ApplicationDeps = {
    store,
    now,
    ids: ids(),
    workflowMemoryProviders: registry,
    trace: (event) => {
      traceSink.emit(event);
    },
  };
  const command = () => `cmd_workflowmemory${(++commandSequence).toString(36)}` as CommandId;
  const { session } = await createProductSession(deps, {
    principalId: OWNER,
    commandId: command(),
    payload: {},
  });
  const initialSnapshot = (await store.read({ kind: "committedSnapshot" })).snapshot;
  const memoryRevision =
    initialSnapshot.entities.workflowDefinitionRevisions[
      SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID
    ];
  if (memoryRevision === undefined) throw new Error("fixture缺少独立Memory Planning Definition");
  const submitted = await submitUserMessage(deps, {
    principalId: OWNER,
    sessionId: session.sessionId,
    commandId: command(),
    payload: {
      text: "请按我们的发布规则设计腾讯Memory接入方案",
      workflowSelection: {
        kind: "published_revision",
        workflowDefinitionRevisionId: memoryRevision.workflowDefinitionRevisionId,
        definitionSha256: memoryRevision.definitionSha256,
      },
    },
  });
  const snapshot = (await store.read({ kind: "committedSnapshot" })).snapshot;
  const run = snapshot.entities.runs[submitted.run.productRunId];
  if (run?.workflowRunSpecId === undefined) throw new Error("fixture缺少Planning RunSpec");
  return {
    deps,
    store,
    command,
    provider,
    sessionId: session.sessionId,
    message: submitted.message,
    productRunId: submitted.run.productRunId,
    workflowRunSpecId: run.workflowRunSpecId,
    traceDir,
    calls: () => ({ queryCalls, writeCalls, reconcileCalls }),
  };
}

function queryIdentity(input: Awaited<ReturnType<typeof fixture>>) {
  return {
    productRunId: input.productRunId,
    workflowRunSpecId: input.workflowRunSpecId,
    definitionNodeId: "memory-planning.query",
    executionPath: [],
    attemptNumber: 1,
  };
}

describe("Workflow Memory正式纵向", () => {
  it("memory.query冻结Provider中立快照，重放不重复查询，并把同一Context交给Planner", async () => {
    const f = await fixture();
    const identity = queryIdentity(f);
    const startCommandId = f.command();
    const startInput = {
      commandId: startCommandId,
      ...identity,
      toStatus: "running" as const,
      publicSummary: "正在查询Memory",
    };
    await transitionConfigurablePlanningNode(f.deps, startInput);
    await transitionConfigurablePlanningNode(f.deps, startInput);
    await transitionConfigurablePlanningNode(f.deps, {
      ...startInput,
      commandId: f.command(),
    });
    const begun = await beginWorkflowMemoryQuery(f.deps, {
      commandId: f.command(),
      ...identity,
    });
    expect(begun.status).toBe("dispatch_required");
    expect(f.calls().queryCalls).toBe(0);
    if (begun.status !== "dispatch_required") throw new Error("Query未进入dispatch_required");

    const providerOutput = await f.provider.queryMemory({
      operationId: begun.query.operationId,
      productRunId: begun.query.productRunId,
      productSessionId: begun.query.productSessionId,
      principalId: begun.query.principalId,
      query: begun.query.queryText,
      maxResults: begun.query.maxResults,
      maxContextCharacters: begun.query.maxContextCharacters,
    });
    const result = normalizeWorkflowMemoryQueryResult(begun.query, providerOutput);
    const persistCommandId = f.command();
    const persistInput = {
      commandId: persistCommandId,
      ...identity,
      workflowMemoryQueryId: begun.workflowMemoryQueryId,
      result,
    };
    const persisted = await persistWorkflowMemoryQueryResult(f.deps, persistInput);
    await persistWorkflowMemoryQueryResult(f.deps, persistInput);
    await persistWorkflowMemoryQueryResult(f.deps, {
      ...persistInput,
      commandId: f.command(),
    });
    expect(persisted).toMatchObject({ status: "completed", snapshotCount: 2 });
    expect(f.calls().queryCalls).toBe(1);
    expect(
      createExecutionTraceReader({ dir: f.traceDir }).read({
        productRunId: f.productRunId,
        afterSequence: 0,
        limit: 100,
      }).items,
    ).toEqual([
      expect.objectContaining({ type: "tool_call", toolName: "memory_query" }),
      expect.objectContaining({ type: "tool_result", toolName: "memory_query" }),
    ]);

    const replay = await beginWorkflowMemoryQuery(f.deps, {
      commandId: f.command(),
      ...identity,
    });
    expect(replay.status).toBe("completed");
    expect(f.calls().queryCalls).toBe(1);

    const frozen = await freezeWorkflowMemoryContext(f.deps, {
      commandId: f.command(),
      productRunId: f.productRunId,
      workflowRunSpecId: f.workflowRunSpecId,
    });
    if (frozen.status !== "ready") throw new Error("Workflow Memory Context未冻结");
    const planning = await compilePlanningInput(f.deps, {
      commandId: f.command(),
      productRunId: f.productRunId,
      planRevision: 1,
      workflowMemoryContextRef: frozen.contextRef,
    });
    expect(planning.workflowMemory?.items).toHaveLength(2);
    expect(planning.workflowMemory?.items.map((item) => item.category).sort()).toEqual([
      "preference",
      "procedure",
    ]);
    expect(planning.workflowMemory?.items.flatMap((item) => item.labels)).toContain("release");
    expect(planning.workflowMemory?.ref).toEqual(frozen.contextRef);
    expect(JSON.stringify(planning.workflowMemory)).not.toMatch(/"L[0-3]"|service_id|team_id/u);

    const snapshot = (await f.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(() => assertSnapshotIntegrity(snapshot)).not.toThrow();
    expect(
      Object.values(snapshot.entities.workflowNodeRuns).find(
        (node) => node.definitionNodeId === "memory-planning.query",
      ),
    ).toMatchObject({ status: "succeeded", outcomeCode: "success" });
  });

  it("独立Memory Workflow的必需query失败可观察，并阻止Planner使用伪造正文", async () => {
    const f = await fixture();
    const identity = queryIdentity(f);
    const begun = await beginWorkflowMemoryQuery(f.deps, {
      commandId: f.command(),
      ...identity,
    });
    if (begun.status !== "dispatch_required") throw new Error("Query未进入dispatch_required");
    const failure: WorkflowMemoryQueryExecutionResult = {
      outcome: "failure",
      errorCode: "memory.provider.unavailable",
    };
    await expect(
      persistWorkflowMemoryQueryResult(f.deps, {
        commandId: f.command(),
        ...identity,
        workflowMemoryQueryId: begun.workflowMemoryQueryId,
        result: failure,
      }),
    ).resolves.toMatchObject({ status: "required_failed", snapshotCount: 0 });
    await expect(
      freezeWorkflowMemoryContext(f.deps, {
        commandId: f.command(),
        productRunId: f.productRunId,
        workflowRunSpecId: f.workflowRunSpecId,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    const snapshot = (await f.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(() => assertSnapshotIntegrity(snapshot)).not.toThrow();
    expect(
      Object.values(snapshot.entities.workflowNodeRuns).find(
        (node) => node.definitionNodeId === "memory-planning.query",
      ),
    ).toMatchObject({ status: "failed", outcomeCode: "required_unavailable" });
  });

  it("Memory Planning内的write由当前Workflow唯一执行，不再产生竞争Outbox", async () => {
    const f = await fixture();
    const commandId = f.command();
    const transition = {
      commandId,
      productRunId: f.productRunId,
      workflowRunSpecId: f.workflowRunSpecId,
      definitionNodeId: "memory-planning.write",
      executionPath: [],
      attemptNumber: 1,
      toStatus: "running" as const,
      publicSummary: "正在保存本次输入到Memory Provider",
    };
    await transitionConfigurablePlanningNode(f.deps, transition);
    await transitionConfigurablePlanningNode(f.deps, transition);
    const loaded = await beginWorkflowMemoryWrite(f.deps, {
      commandId: f.command(),
      productRunId: f.productRunId,
      workflowRunSpecId: f.workflowRunSpecId,
      definitionNodeId: "memory-planning.write",
      executionPath: [],
      attemptNumber: 1,
    });
    expect(loaded.result.status).toBe("queued");
    const dispatching = await markMemoryWriteDispatching(f.deps, {
      commandId: f.command(),
      memoryWriteIntentId: loaded.intent.memoryWriteIntentId,
      memoryWriteResultId: loaded.result.memoryWriteResultId,
      requestSha256: loaded.intent.requestSha256,
      expectedRevision: loaded.result.revision,
    });
    const acceptedEvidence = await f.provider.writeMemory(loaded.adapterInput);
    const accepted = await commitMemoryWriteAccepted(f.deps, {
      commandId: f.command(),
      memoryWriteIntentId: loaded.intent.memoryWriteIntentId,
      memoryWriteResultId: dispatching.memoryWriteResultId,
      requestSha256: loaded.intent.requestSha256,
      expectedRevision: dispatching.revision,
      accepted: acceptedEvidence,
    });
    if (accepted.status !== "accepted") throw new Error("Memory Write未进入accepted");
    const reconciled = await f.provider.reconcileMemoryWrite({
      ...loaded.adapterInput,
      externalObjectId: accepted.externalObjectId,
    });
    if (reconciled.status !== "materialized") throw new Error("测试Provider未完成物化");
    await commitMemoryWriteMaterialized(f.deps, {
      commandId: f.command(),
      memoryWriteIntentId: loaded.intent.memoryWriteIntentId,
      memoryWriteResultId: accepted.memoryWriteResultId,
      requestSha256: loaded.intent.requestSha256,
      expectedRevision: accepted.revision,
      accepted: reconciled.accepted,
      verificationKind: reconciled.verificationKind,
      verificationSha256: reconciled.verificationSha256,
      reconciled: true,
    });
    await transitionConfigurablePlanningNode(f.deps, {
      ...transition,
      commandId: f.command(),
      toStatus: "succeeded",
      outcomeCode: "materialized",
      publicSummary: "本次输入已写入并可查询",
    });
    const snapshot = (await f.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(
      Object.values(snapshot.outbox).filter(
        (entry) =>
          entry.kind === "memory_write_start" &&
          entry.memoryWriteIntentId === loaded.intent.memoryWriteIntentId,
      ),
    ).toEqual([]);
    expect(() => assertSnapshotIntegrity(snapshot)).not.toThrow();
    expect(
      createExecutionTraceReader({ dir: f.traceDir }).read({
        productRunId: f.productRunId,
        afterSequence: 0,
        limit: 100,
      }).items,
    ).toEqual([
      expect.objectContaining({ type: "tool_call", toolName: "memory_write" }),
      expect.objectContaining({
        type: "tool_result",
        toolName: "memory_write",
        outcome: "success",
      }),
    ]);
  });

  it("默认Simple Planning实际Run不声明也不产生任何Memory轨迹", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-simple-planning-memory-trace-"));
    const traceDir = join(directory, "trace");
    let tick = 0;
    let traceTick = 0;
    let commandSequence = 0;
    const now = () =>
      new Date(Date.parse("2026-08-18T12:00:00.000Z") + tick++ * 1_000).toISOString();
    const traceSink = createTraceSink({
      dir: traceDir,
      now: () => new Date(Date.parse("2026-08-18T12:00:00.000Z") + traceTick++ * 100),
    });
    const store = await JsonProductStore.open({ filePath: join(directory, "product.json"), now });
    const deps: ApplicationDeps = {
      store,
      now,
      ids: ids(),
      trace: (event) => {
        traceSink.emit(event);
      },
    };
    const command = () => `cmd_simpleplanningtrace${(++commandSequence).toString(36)}` as CommandId;
    const { session } = await createProductSession(deps, {
      principalId: OWNER,
      commandId: command(),
      payload: {},
    });
    const submitted = await submitUserMessage(deps, {
      principalId: OWNER,
      sessionId: session.sessionId,
      commandId: command(),
      payload: { text: "普通规划不应访问Memory" },
    });
    const snapshot = (await store.read({ kind: "committedSnapshot" })).snapshot;
    const run = snapshot.entities.runs[submitted.run.productRunId];
    const runSpec =
      run?.workflowRunSpecId === undefined
        ? undefined
        : snapshot.entities.workflowRunSpecs[run.workflowRunSpecId];
    const nodeTypes = runSpec?.nodeResolutions.map((node) => node.nodeType) ?? [];
    expect(nodeTypes).not.toContain("memory.query");
    expect(nodeTypes).not.toContain("memory.write");
    expect(
      createExecutionTraceReader({ dir: traceDir })
        .read({ productRunId: submitted.run.productRunId, afterSequence: 0, limit: 100 })
        .items.filter(
          (item) =>
            (item.type === "tool_call" || item.type === "tool_result") &&
            (item.toolName === "memory_query" || item.toolName === "memory_write"),
        ),
    ).toEqual([]);
  });

  it("memory.write先提交产品意图与Outbox，再单次写入并通过只读对账收敛", async () => {
    const f = await fixture();
    const snapshotBefore = (await f.store.read({ kind: "committedSnapshot" })).snapshot;
    const session = snapshotBefore.entities.sessions[f.sessionId];
    if (session === undefined) throw new Error("fixture缺少Session");
    const commandId = f.command();
    const payload: CreateMemoryWritePayload = {
      productSessionId: f.sessionId,
      providerId: PROVIDER_ID,
      sourceSelection: {
        kind: "full_message" as const,
        sourceMessageId: f.message.messageId,
        sourceMessageSha256: f.message.sha256,
      },
      expectedSessionRevision: session.revision,
    };
    const created = await createMemoryWrite(f.deps, {
      principalId: OWNER,
      commandId,
      payload,
    });
    expect(created.memoryWrite.result.status).toBe("queued");
    expect(f.calls().writeCalls).toBe(0);
    const semanticReplay = await createMemoryWrite(f.deps, {
      principalId: OWNER,
      commandId: f.command(),
      payload,
    });
    expect(semanticReplay.memoryWrite.memoryWriteIntentId).toBe(
      created.memoryWrite.memoryWriteIntentId,
    );

    const loaded = await loadMemoryWriteForRuntime(f.deps, {
      memoryWriteIntentId: created.memoryWrite.memoryWriteIntentId,
      memoryWriteResultId: created.memoryWrite.memoryWriteResultId,
    });
    const dispatching = await markMemoryWriteDispatching(f.deps, {
      commandId: f.command(),
      memoryWriteIntentId: loaded.intent.memoryWriteIntentId,
      memoryWriteResultId: loaded.result.memoryWriteResultId,
      requestSha256: loaded.intent.requestSha256,
      expectedRevision: loaded.result.revision,
    });
    const acceptedEvidence = await f.provider.writeMemory(loaded.adapterInput);
    const accepted = await commitMemoryWriteAccepted(f.deps, {
      commandId: f.command(),
      memoryWriteIntentId: loaded.intent.memoryWriteIntentId,
      memoryWriteResultId: dispatching.memoryWriteResultId,
      requestSha256: loaded.intent.requestSha256,
      expectedRevision: dispatching.revision,
      accepted: acceptedEvidence,
    });
    if (accepted.status !== "accepted") throw new Error("Memory Write未进入accepted");
    const reconciled = await f.provider.reconcileMemoryWrite({
      ...loaded.adapterInput,
      externalObjectId: accepted.externalObjectId,
    });
    if (reconciled.status !== "materialized") throw new Error("测试Provider未完成物化");
    const materialized = await commitMemoryWriteMaterialized(f.deps, {
      commandId: f.command(),
      memoryWriteIntentId: loaded.intent.memoryWriteIntentId,
      memoryWriteResultId: accepted.memoryWriteResultId,
      requestSha256: loaded.intent.requestSha256,
      expectedRevision: accepted.revision,
      accepted: reconciled.accepted,
      verificationKind: reconciled.verificationKind,
      verificationSha256: reconciled.verificationSha256,
      reconciled: true,
    });
    expect(materialized.status).toBe("materialized");
    expect(f.calls()).toEqual({ queryCalls: 0, writeCalls: 1, reconcileCalls: 1 });

    const snapshot = (await f.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(
      Object.values(snapshot.outbox).filter((entry) => entry.kind === "memory_write_start"),
    ).toHaveLength(1);
    expect(() => assertSnapshotIntegrity(snapshot)).not.toThrow();
  });
});
