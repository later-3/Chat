import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeBaselineDtoSchema,
  type AgentKey,
  type TraceEventInput,
} from "@chat/contracts";
import type { ApplicationDeps, DirectAgentIdFactory, IdFactory } from "@chat/application";
import {
  beginDirectAgentAttempt,
  commitMemoryImportAccepted,
  createMemoryWrite,
  createMemoryImport,
  createProductSession,
  markMemoryImportDispatching,
  publishPromptReviewRequest,
  submitPromptReviewDecision,
  submitUserMessage,
  transitionConfigurablePlanningNode,
  updateOutboxStatus,
} from "@chat/application";
import { SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID } from "@chat/application/workflow-system-definitions";
import { canonicalJsonStringify, computePromptReviewPayloadSha256 } from "@chat/domain";
import { JsonProductStore } from "@chat/product-store-json";
import { OutboxDispatcher } from "./outbox-dispatcher.js";
import { createFilePromptCatalog } from "./prompt-catalog.js";

function ids(): IdFactory {
  let value = 0;
  const next = (prefix: string) => `${prefix}_dispatch${(++value).toString(36)}`;
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

function directAgentIds(): DirectAgentIdFactory {
  let value = 0;
  const next = (prefix: string) => `${prefix}_dispatch${(++value).toString(36)}`;
  return {
    promptReviewRequest: () =>
      next("prr") as ReturnType<DirectAgentIdFactory["promptReviewRequest"]>,
    promptReviewDecision: () =>
      next("prd") as ReturnType<DirectAgentIdFactory["promptReviewDecision"]>,
    candidate: () => next("drc") as ReturnType<DirectAgentIdFactory["candidate"]>,
  };
}

const importBackend = {
  describeImport: () => ({
    descriptor: {
      backendId: "mbk_memmy" as never,
      displayName: "memmy",
      kind: "memmy" as const,
      adapterContractVersion: "memmy-http-import.v1" as const,
      configured: true,
      configurationFingerprint: "a".repeat(64) as never,
      capabilities: {
        mode: "explicit_fact" as const,
        layers: ["L2"] as ["L2"],
        title: true as const,
        tags: true as const,
        maxContentChars: 50_000,
      },
      authMode: "none" as const,
      credentialRevision: "none" as never,
    },
  }),
  import: vi.fn(),
  reconcile: vi.fn(),
};

const workflowMemoryProvider = {
  describeProvider: () => ({
    schemaVersion: "memory-provider-descriptor.v1" as const,
    providerId: "mbk_tencentmemorycore" as never,
    displayName: "Tencent MemoryCore",
    providerKind: "tencent_memorycore",
    transport: "http" as const,
    adapterContractVersion: "tencent-memorycore-http.v2",
    configured: true,
    configurationFingerprint: "c".repeat(64) as never,
    capabilities: {
      query: { maxResults: 20, maxContextCharacters: 32_000 },
      write: {
        maxContentCharacters: 8_192,
        materialization: "asynchronous" as const,
        idempotency: "chat_reconcile" as const,
      },
      reconcile: true,
      management: { list: false, get: false, update: false, delete: false, history: false },
    },
    authMode: "bearer" as const,
    credentialRevision: "dispatcher-memorycore-v1",
  }),
  health: async () => ({ status: "ready" as const }),
  queryMemory: vi.fn(),
  writeMemory: vi.fn(),
  reconcileMemoryWrite: vi.fn(),
};

function runtimeProfile(agentKey: AgentKey) {
  if (agentKey !== "direct" && agentKey !== "project_bootstrap" && agentKey !== "coding_executor")
    return undefined;
  const variantKey =
    agentKey === "direct" || agentKey === "project_bootstrap"
      ? "read_only"
      : "workspace_write_shell";
  const tools =
    agentKey === "direct" || agentKey === "project_bootstrap"
      ? ["read", "grep", "find", "ls"]
      : ["read", "bash", "edit", "write", "grep", "find", "ls"];
  return agentRuntimeBaselineDtoSchema.parse({
    kind: "pi_coding_agent",
    title: "Pi Coding Agent",
    packageName: "@earendil-works/pi-coding-agent",
    packageVersion: "0.84.2",
    managedSource: "later-3/pi@codex/later-custom",
    compositionStrategy: "pi_default_or_custom_then_chat_runtime_then_context",
    chatRuntimeAppend: {
      bodyMarkdown: "Chat Runtime Contract",
      sha256: "a".repeat(64),
      sourceRelativePath: "packages/pi-runtime/src/coding-agent-runtime-profile.ts",
    },
    variants: [
      {
        variantKey,
        title: variantKey,
        description: "测试Pi能力",
        enabledToolNames: tools,
        piSystemPrompt: {
          bodyMarkdown: `Pi runtime ${variantKey}`,
          sha256: "b".repeat(64),
          dynamicPlaceholders: ["WORKSPACE_ROOT"],
          sourceRelativePaths: ["pi/packages/coding-agent/src/core/system-prompt.ts"],
        },
        tools: tools.map((name) => ({
          name,
          description: `${name} tool`,
          parametersJson: "{}",
          sourceRelativePath: `pi/packages/coding-agent/src/core/tools/${name}.ts`,
        })),
      },
    ],
    finalReviewNote: "发送前复核。",
  });
}

async function seed(): Promise<{
  deps: ApplicationDeps;
  productRunId: string;
  sessionId: string;
  messageId: string;
  messageSha256: string;
  traces: TraceEventInput[];
  advance: (milliseconds: number) => void;
}> {
  const directory = await mkdtemp(join(tmpdir(), "chat-dispatch-test-"));
  let timestamp = Date.parse("2026-08-07T12:00:00.000Z");
  const now = () => new Date(timestamp).toISOString();
  const store = await JsonProductStore.open({
    filePath: join(directory, "chat-product-store.v1.json"),
    now,
  });
  const traces: TraceEventInput[] = [];
  const deps: ApplicationDeps = {
    store,
    now,
    ids: ids(),
    directAgentIds: directAgentIds(),
    promptCatalog: await createFilePromptCatalog(),
    agentRuntimeProfiles: { read: async (agentKey) => runtimeProfile(agentKey) },
    trace: (event) => traces.push(event),
    memoryImportBackends: {
      list: () => [importBackend],
      get: (backendId) => (backendId === "mbk_memmy" ? importBackend : undefined),
    },
    workflowMemoryProviders: {
      list: () => [workflowMemoryProvider.describeProvider()],
      getQuery: (providerId) =>
        providerId === "mbk_tencentmemorycore" ? workflowMemoryProvider : undefined,
      getWrite: (providerId) =>
        providerId === "mbk_tencentmemorycore" ? workflowMemoryProvider : undefined,
    },
  };
  const { session } = await createProductSession(deps, {
    principalId: "usr_dispatchtest" as never,
    commandId: "cmd_dispatch1" as never,
    payload: {},
  });
  const { message, run } = await submitUserMessage(deps, {
    principalId: "usr_dispatchtest" as never,
    sessionId: session.sessionId,
    commandId: "cmd_dispatch2" as never,
    payload: { text: "启动规划" },
  });
  if (message.sha256 === undefined) throw new Error("测试Message缺少Hash");
  return {
    deps,
    productRunId: run.productRunId,
    sessionId: session.sessionId,
    messageId: message.messageId,
    messageSha256: message.sha256,
    traces,
    advance: (milliseconds) => {
      timestamp += milliseconds;
    },
  };
}

async function seedMemoryWrite() {
  const seeded = await seed();
  const snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
  const planningOutbox = Object.values(snapshot.outbox).find(
    (entry) => entry.kind === "workflow_start",
  );
  const session = snapshot.entities.sessions[seeded.sessionId];
  if (planningOutbox === undefined || session === undefined) {
    throw new Error("缺少规划Outbox或Session");
  }
  await updateOutboxStatus(seeded.deps, {
    commandId: "cmd_disableplanningwrite" as never,
    outboxId: planningOutbox.outboxId,
    status: "failed_terminal",
  });
  const { memoryWrite } = await createMemoryWrite(seeded.deps, {
    principalId: "usr_dispatchtest" as never,
    commandId: "cmd_memorywrite1" as never,
    payload: {
      productSessionId: session.sessionId,
      providerId: "mbk_tencentmemorycore" as never,
      sourceSelection: {
        kind: "full_message",
        sourceMessageId: seeded.messageId as never,
        sourceMessageSha256: seeded.messageSha256 as never,
      },
      expectedSessionRevision: session.revision,
    },
  });
  return { ...seeded, memoryWrite };
}

async function seedMemoryImport() {
  const seeded = await seed();
  const snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
  const planningOutbox = Object.values(snapshot.outbox).find(
    (entry) => entry.kind === "workflow_start",
  );
  if (planningOutbox === undefined) throw new Error("缺少规划Outbox");
  await updateOutboxStatus(seeded.deps, {
    commandId: "cmd_disableplanning" as never,
    outboxId: planningOutbox.outboxId,
    status: "failed_terminal",
  });
  const { memoryImport } = await createMemoryImport(seeded.deps, {
    principalId: "usr_dispatchtest" as never,
    commandId: "cmd_memoryimport1" as never,
    payload: {
      sourceSelection: {
        kind: "full_message",
        sourceMessageId: seeded.messageId as never,
        sourceMessageSha256: seeded.messageSha256 as never,
      },
      backendId: "mbk_memmy" as never,
      title: "派发恢复测试",
      tags: ["recovery"],
    },
  });
  return { ...seeded, memoryImport };
}

/** 只通过正式Application命令形成Prompt Review Decision及其workflow_resume Outbox。 */
async function seedPromptReviewResume() {
  const seeded = await seed();
  const initial = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
  const directRevision =
    initial.entities.workflowDefinitionRevisions[SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID];
  if (directRevision === undefined) throw new Error("缺少Direct Agent系统Definition");
  const submitted = await submitUserMessage(seeded.deps, {
    principalId: "usr_dispatchtest" as never,
    sessionId: seeded.sessionId as never,
    commandId: "cmd_promptreviewsubmit" as never,
    payload: {
      text: "只读检查Prompt Review Resume派发边界",
      workflowSelection: {
        kind: "published_revision",
        workflowDefinitionRevisionId: directRevision.workflowDefinitionRevisionId,
        definitionSha256: directRevision.definitionSha256,
      },
    },
  });
  const afterSubmit = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
  const run = afterSubmit.entities.runs[submitted.run.productRunId];
  const workflowAttempt = Object.values(afterSubmit.entities.attempts).find(
    (attempt) => attempt.productRunId === submitted.run.productRunId && attempt.kind === "workflow",
  );
  if (run?.runKind !== "direct_agent" || workflowAttempt === undefined) {
    throw new Error("没有形成完整Direct Agent Run");
  }
  const startOutboxes = Object.values(afterSubmit.outbox).filter(
    (entry) => entry.kind === "workflow_start" && entry.status === "pending",
  );
  for (const [index, entry] of startOutboxes.entries()) {
    await updateOutboxStatus(seeded.deps, {
      commandId: `cmd_disablepromptstart${String(index + 1)}` as never,
      outboxId: entry.outboxId,
      status: "failed_terminal",
    });
  }
  const begun = await beginDirectAgentAttempt(seeded.deps, {
    commandId: "cmd_promptreviewbegin" as never,
    productRunId: run.productRunId,
    workflowAttemptId: workflowAttempt.attemptId,
  });
  if (run.workflowRunSpecId === undefined) throw new Error("Direct Run缺少Workflow RunSpec");
  await transitionConfigurablePlanningNode(seeded.deps, {
    commandId: "cmd_promptreviewrunning" as never,
    productRunId: run.productRunId,
    workflowRunSpecId: run.workflowRunSpecId,
    definitionNodeId: "direct.agent",
    executionPath: [],
    attemptNumber: 1,
    toStatus: "running",
    publicSummary: "正在推进直接Agent，等待下一处Provider边界",
  });
  const canonicalPayloadJson = canonicalJsonStringify({
    messages: [{ content: "只读检查Prompt Review Resume派发边界", role: "user" }],
    model: "qwen3.7-plus",
  });
  const published = await publishPromptReviewRequest(seeded.deps, {
    commandId: "cmd_promptreviewpublish" as never,
    productRunId: run.productRunId,
    directAgentAttemptId: begun.directAgentAttemptId,
    expectedRunRevision: begun.runRevision,
    requestIndex: 1,
    requestKind: "agent_turn",
    providerId: "bailian",
    modelId: "qwen3.7-plus",
    endpointHost: "dashscope.aliyuncs.com",
    canonicalPayloadJson,
    payloadSha256: computePromptReviewPayloadSha256(canonicalPayloadJson),
  });
  await transitionConfigurablePlanningNode(seeded.deps, {
    commandId: "cmd_promptreviewwaiting" as never,
    productRunId: run.productRunId,
    workflowRunSpecId: run.workflowRunSpecId,
    definitionNodeId: "direct.agent",
    executionPath: [],
    attemptNumber: 1,
    toStatus: "waiting_human",
    publicSummary: "等待审核第1次Provider完整提示词",
  });
  const approved = await submitPromptReviewDecision(seeded.deps, {
    principalId: "usr_dispatchtest" as never,
    productRunId: run.productRunId,
    commandId: "cmd_promptreviewapprove" as never,
    expectedRunRevision: published.runRevision,
    payload: {
      promptReviewRequestId: published.promptReview.promptReviewRequestId,
      requestRevision: published.promptReview.requestRevision,
      reviewSha256: published.promptReview.reviewSha256,
      payloadSha256: published.promptReview.payloadSha256,
      kind: "approve",
    },
  });
  const committed = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
  const resumeOutbox = Object.values(committed.outbox).find(
    (entry) =>
      entry.kind === "workflow_resume" &&
      entry.promptReviewRequestId === published.promptReview.promptReviewRequestId &&
      entry.promptReviewDecisionId === approved.decision.promptReviewDecisionId,
  );
  if (resumeOutbox?.kind !== "workflow_resume") {
    throw new Error("Prompt Review Decision没有产生workflow_resume Outbox");
  }
  return {
    ...seeded,
    approved,
    begun,
    canonicalPayloadJson,
    published,
    resumeOutbox,
    workflowAttemptId: workflowAttempt.attemptId,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Outbox结果未知栅栏", () => {
  it("Runtime成功响应体损坏时进入outcome_unknown，对账不得第二次Start", async () => {
    const { deps, productRunId } = await seed();
    let startCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/start")) {
          startCalls += 1;
          return new Response("not-json", { status: 201 });
        }
        if (url.includes("/reconcile")) {
          return Response.json({
            schemaVersion: "chat-workflow-dispatch.v1",
            productRunId,
            startBinding: "outcome_unknown",
          });
        }
        throw new Error("unexpected fetch");
      }),
    );
    const dispatcher = new OutboxDispatcher({
      deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
    });

    await dispatcher.tick();
    let { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    let entry = Object.values(snapshot.outbox)[0];
    expect(entry?.status).toBe("outcome_unknown");
    expect(entry?.dispatchAttempts).toBe(1);

    await dispatcher.tick();
    await dispatcher.tick();
    ({ snapshot } = await deps.store.read({ kind: "committedSnapshot" }));
    entry = Object.values(snapshot.outbox)[0];
    expect(entry?.status).toBe("outcome_unknown");
    expect(entry?.dispatchAttempts).toBe(1);
    expect(startCalls).toBe(1);
  });

  it("Workflow在mark前终止时只创建新的start Outbox，原条目不再永久acknowledged", async () => {
    const { deps, memoryImport, advance } = await seedMemoryImport();
    const dispatchedBodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/memory-import/start")) {
          dispatchedBodies.push(JSON.parse(String(init?.body)));
          return Response.json(
            { schemaVersion: "chat-workflow-dispatch.v1", status: "started" },
            { status: 201 },
          );
        }
        if (url.includes("/memory-import/reconcile")) {
          const outboxId = new URL(url).searchParams.get("outboxId");
          return Response.json({
            schemaVersion: "chat-workflow-dispatch.v1",
            outboxId,
            startBinding: "exists",
            runStatus: "failed",
          });
        }
        throw new Error("unexpected fetch");
      }),
    );
    const dispatcher = new OutboxDispatcher({
      deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
    });
    await dispatcher.tick();
    advance(2_000);
    await dispatcher.tick();
    let snapshot = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const imports = Object.values(snapshot.outbox).filter(
      (entry) => entry.kind === "memory_import_start",
    );
    expect(imports.map((entry) => entry.status).sort()).toEqual(["failed_terminal", "pending"]);
    expect(snapshot.entities.memoryImportResults[memoryImport.memoryImportResultId]?.status).toBe(
      "queued",
    );
    await dispatcher.tick();
    snapshot = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(dispatchedBodies).toHaveLength(2);
    expect(dispatchedBodies).toEqual([
      expect.objectContaining({ mode: "import" }),
      expect.objectContaining({ mode: "import" }),
    ]);
  });

  it("Workflow越过mark后终止时收敛为outcome_unknown并只派发reconcile", async () => {
    const { deps, memoryImport, advance, traces } = await seedMemoryImport();
    const dispatchedModes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/memory-import/start")) {
          const body = JSON.parse(String(init?.body)) as { mode: string };
          dispatchedModes.push(body.mode);
          return Response.json(
            { schemaVersion: "chat-workflow-dispatch.v1", status: "started" },
            { status: 201 },
          );
        }
        if (url.includes("/memory-import/reconcile")) {
          return Response.json({
            schemaVersion: "chat-workflow-dispatch.v1",
            outboxId: new URL(url).searchParams.get("outboxId"),
            startBinding: "exists",
            runStatus: "failed",
          });
        }
        throw new Error("unexpected fetch");
      }),
    );
    const dispatcher = new OutboxDispatcher({
      deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
    });
    await dispatcher.tick();
    const before = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const intent = before.entities.memoryImportIntents[memoryImport.memoryImportIntentId];
    if (intent === undefined) throw new Error("缺少Intent");
    await markMemoryImportDispatching(deps, {
      commandId: "cmd_markdispatching" as never,
      memoryImportIntentId: intent.memoryImportIntentId,
      memoryImportResultId: memoryImport.memoryImportResultId,
      requestSha256: intent.requestSha256,
      expectedRevision: 1,
    });
    advance(2_000);
    await dispatcher.tick();
    let snapshot = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(snapshot.entities.memoryImportResults[memoryImport.memoryImportResultId]).toMatchObject({
      status: "outcome_unknown",
      revision: 3,
    });
    expect(
      Object.values(snapshot.outbox).filter(
        (entry) => entry.kind === "memory_import_reconcile" && entry.status === "pending",
      ),
    ).toHaveLength(1);
    expect(traces).toContainEqual(
      expect.objectContaining({
        eventName: "memory.import.outcome_unknown",
        origin: "recovery",
        memoryImportIntentId: memoryImport.memoryImportIntentId,
      }),
    );
    await dispatcher.tick();
    snapshot = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(dispatchedModes).toEqual(["import", "reconcile"]);
  });

  it("L0导入已accepted时不得被终态监督器降级为outcome_unknown", async () => {
    const { deps, memoryImport, advance } = await seedMemoryImport();
    let reconcileCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/memory-import/start")) {
          return Response.json(
            { schemaVersion: "chat-workflow-dispatch.v1", status: "started" },
            { status: 201 },
          );
        }
        if (url.includes("/memory-import/reconcile")) {
          reconcileCalls += 1;
          throw new Error("accepted结果不应触发终态故障恢复");
        }
        throw new Error("unexpected fetch");
      }),
    );
    const dispatcher = new OutboxDispatcher({
      deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
    });
    await dispatcher.tick();
    const before = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const intent = before.entities.memoryImportIntents[memoryImport.memoryImportIntentId];
    if (intent === undefined) throw new Error("缺少Intent");
    const dispatching = await markMemoryImportDispatching(deps, {
      commandId: "cmd_markaccepted" as never,
      memoryImportIntentId: intent.memoryImportIntentId,
      memoryImportResultId: memoryImport.memoryImportResultId,
      requestSha256: intent.requestSha256,
      expectedRevision: 1,
    });
    await commitMemoryImportAccepted(deps, {
      commandId: "cmd_commitaccepted" as never,
      memoryImportIntentId: intent.memoryImportIntentId,
      memoryImportResultId: memoryImport.memoryImportResultId,
      requestSha256: intent.requestSha256,
      expectedRevision: dispatching.revision,
      accepted: {
        externalObjectId: "chat-import:mii_dispatchaccepted",
        externalStatus: "l0_accepted",
        responseSha256: "b".repeat(64),
      },
      reconciled: true,
    });

    advance(2_000);
    await dispatcher.tick();
    const snapshot = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(snapshot.entities.memoryImportResults[memoryImport.memoryImportResultId]).toMatchObject({
      status: "accepted",
      reconcileAttempts: 1,
    });
    expect(reconcileCalls).toBe(0);
    expect(
      Object.values(snapshot.outbox).filter(
        (entry) => entry.kind === "memory_import_reconcile" && entry.status === "pending",
      ),
    ).toHaveLength(0);
  });

  it("Memory Write启动响应未知时不重复Start，超时后收敛产品Result等待人工对账", async () => {
    const { deps, memoryWrite, advance } = await seedMemoryWrite();
    let startCalls = 0;
    let reconcileCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/memory-write/start")) {
          startCalls += 1;
          return new Response("not-json", { status: 201 });
        }
        if (url.includes("/memory-write/reconcile")) {
          reconcileCalls += 1;
          return Response.json({
            schemaVersion: "chat-workflow-dispatch.v1",
            outboxId: new URL(url).searchParams.get("outboxId"),
            startBinding: "outcome_unknown",
          });
        }
        throw new Error(`unexpected fetch:${url}`);
      }),
    );
    const dispatcher = new OutboxDispatcher({
      deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
    });

    await dispatcher.tick();
    await dispatcher.tick();
    let snapshot = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const startOutbox = Object.values(snapshot.outbox).find(
      (entry) => entry.kind === "memory_write_start",
    );
    expect(startOutbox).toMatchObject({ status: "outcome_unknown", dispatchAttempts: 1 });
    expect(startCalls).toBe(1);
    expect(reconcileCalls).toBe(1);

    advance(61_000);
    await dispatcher.tick();
    snapshot = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(snapshot.entities.memoryWriteResults[memoryWrite.memoryWriteResultId]).toMatchObject({
      status: "outcome_unknown",
      errorCode: "memory.write.workflow_dispatch_unknown",
    });
    expect(snapshot.outbox[startOutbox!.outboxId]).toMatchObject({
      status: "failed_terminal",
      dispatchAttempts: 1,
    });
    expect(startCalls).toBe(1);
  });
});

describe("Prompt Review Resume Outbox最小披露与对账", () => {
  it("只派发产品引用，成功即ack；响应损坏后按prr对账且不重复resume", async () => {
    const successful = await seedPromptReviewResume();
    const successfulBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (!url.endsWith("/internal/workflow/v1/resume")) {
          throw new Error(`unexpected fetch:${url}`);
        }
        successfulBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({
          schemaVersion: "chat-workflow-dispatch.v1",
          status: "resumed",
        });
      }),
    );
    const successfulDispatcher = new OutboxDispatcher({
      deps: successful.deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
    });

    await successfulDispatcher.tick();
    const successfulSnapshot = (await successful.deps.store.read({ kind: "committedSnapshot" }))
      .snapshot;
    const successfulBody = successfulBodies[0];
    expect(successfulBodies).toHaveLength(1);
    expect(Object.keys(successfulBody ?? {}).sort()).toEqual(
      [
        "attemptId",
        "outboxId",
        "payloadSha256",
        "productRunId",
        "promptReviewDecisionId",
        "promptReviewRequestId",
        "requestRevision",
        "reviewSha256",
        "schemaVersion",
      ].sort(),
    );
    expect(successfulBody).toEqual({
      schemaVersion: "chat-workflow-dispatch.v1",
      productRunId: successful.resumeOutbox.productRunId,
      attemptId: successful.workflowAttemptId,
      promptReviewRequestId: successful.published.promptReview.promptReviewRequestId,
      promptReviewDecisionId: successful.approved.decision.promptReviewDecisionId,
      requestRevision: successful.published.promptReview.requestRevision,
      reviewSha256: successful.published.promptReview.reviewSha256,
      payloadSha256: successful.published.promptReview.payloadSha256,
      outboxId: successful.resumeOutbox.outboxId,
    });
    expect(successfulBody).not.toHaveProperty("canonicalPayloadJson");
    expect(successfulBody).not.toHaveProperty("hookToken");
    expect(successfulBody).not.toHaveProperty("piSessionId");
    expect(successfulSnapshot.outbox[successful.resumeOutbox.outboxId]).toMatchObject({
      status: "acknowledged",
      dispatchAttempts: 1,
    });

    vi.unstubAllGlobals();
    const uncertain = await seedPromptReviewResume();
    const uncertainBodies: Record<string, unknown>[] = [];
    const reconcileUrls: string[] = [];
    let resumeCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/internal/workflow/v1/resume")) {
          resumeCalls += 1;
          uncertainBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response("not-json", { status: 200 });
        }
        if (url.includes("/internal/workflow/v1/reconcile?")) {
          reconcileUrls.push(url);
          return Response.json({
            schemaVersion: "chat-workflow-dispatch.v1",
            productRunId: uncertain.resumeOutbox.productRunId,
            startBinding: "exists",
            hookResumeState: "dispatched",
          });
        }
        throw new Error(`unexpected fetch:${url}`);
      }),
    );
    const uncertainDispatcher = new OutboxDispatcher({
      deps: uncertain.deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
    });

    await uncertainDispatcher.tick();
    let uncertainSnapshot = (await uncertain.deps.store.read({ kind: "committedSnapshot" }))
      .snapshot;
    expect(uncertainSnapshot.outbox[uncertain.resumeOutbox.outboxId]).toMatchObject({
      status: "outcome_unknown",
      dispatchAttempts: 1,
    });

    await uncertainDispatcher.tick();
    await uncertainDispatcher.tick();
    uncertainSnapshot = (await uncertain.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(uncertainSnapshot.outbox[uncertain.resumeOutbox.outboxId]).toMatchObject({
      status: "acknowledged",
      dispatchAttempts: 1,
    });
    expect(resumeCalls).toBe(1);
    expect(uncertainBodies).toHaveLength(1);
    expect(reconcileUrls).toHaveLength(1);
    const reconcileUrl = new URL(reconcileUrls[0]!);
    expect(reconcileUrl.searchParams.get("productRunId")).toBe(uncertain.resumeOutbox.productRunId);
    expect(reconcileUrl.searchParams.get("promptReviewRequestId")).toBe(
      uncertain.published.promptReview.promptReviewRequestId,
    );
    expect(reconcileUrl.searchParams.has("approvalRequestId")).toBe(false);
    expect(reconcileUrl.searchParams.has("hookNoteCandidateId")).toBe(false);
  });
});
