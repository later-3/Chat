import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeBaselineDtoSchema,
  type AgentKey,
  type ProductSnapshot,
  type TraceEventInput,
} from "@chat/contracts";
import type {
  ApplicationDeps,
  DirectAgentIdFactory,
  IdFactory,
  NoteIdFactory,
} from "@chat/application";
import {
  beginDirectAgentAttempt,
  compileExecutionContract,
  compilePlanningInput,
  commitMemoryImportAccepted,
  createInProcessProjectBootstrapExecutionCoordinator,
  createMemoryWrite,
  createMemoryImport,
  createProductSession,
  getCurrentNoteCandidate,
  decideProjectBootstrapCandidate,
  getCurrentProjectBootstrapForSession,
  markMemoryImportDispatching,
  prepareProjectBootstrapCandidate,
  publishPromptReviewRequest,
  publishNoteCandidate,
  publishPlanForReview,
  submitPromptReviewDecision,
  submitPlanDecision,
  submitProjectBootstrapUserMessage,
  submitUserMessage,
  transitionConfigurablePlanningNode,
  updateOutboxStatus,
} from "@chat/application";
import {
  SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID,
  SYSTEM_NOTE_WORKFLOW_REVISION_ID,
} from "@chat/application/workflow-system-definitions";
import {
  canonicalJsonStringify,
  computePromptReviewPayloadSha256,
  hashCanonical,
} from "@chat/domain";
import { JsonProductStore } from "@chat/product-store-json";
import { OutboxDispatcher } from "./outbox-dispatcher.js";
import { createFilePromptCatalog } from "./prompt-catalog.js";
import { runtimeToolFixture } from "./runtime-profile-test-fixture.js";

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

function noteIds(): NoteIdFactory {
  let value = 0;
  const next = (prefix: string) => `${prefix}_dispatch${(++value).toString(36)}`;
  return {
    note: () => next("nte") as ReturnType<NoteIdFactory["note"]>,
    revision: () => next("ntr") as ReturnType<NoteIdFactory["revision"]>,
    candidate: () => next("ntc") as ReturnType<NoteIdFactory["candidate"]>,
    decision: () => next("ntd") as ReturnType<NoteIdFactory["decision"]>,
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
    agentKey === "coding_executor"
      ? "workspace_write_shell"
      : agentKey === "project_bootstrap"
        ? "read_only"
        : "pi_cli_default";
  const tools =
    agentKey === "coding_executor"
      ? ["read", "bash", "edit", "write", "grep", "find", "ls"]
      : ["read", "bash", "edit", "write"];
  const variants = [
    { variantKey, tools },
    ...(agentKey === "direct" || agentKey === "project_bootstrap"
      ? [{ variantKey: "project_bootstrap", tools: ["project_bootstrap_prepare"] }]
      : []),
  ];
  return agentRuntimeBaselineDtoSchema.parse({
    kind: "pi_coding_agent",
    title: "Pi Coding Agent",
    packageName: "@earendil-works/pi-coding-agent",
    packageVersion: "0.84.2",
    managedSource: "later-3/pi@codex/later-custom",
    managedSourceRevision: "1".repeat(40),
    compositionStrategy:
      "pi_runtime_then_agent_version_then_workflow_session_run_then_chat_context",
    chatRuntimeAppend: {
      bodyMarkdown: "Chat Runtime Contract",
      sha256: "a".repeat(64),
      sourceRelativePath: "packages/pi-runtime/src/coding-agent-runtime-profile.ts",
      appliesToVariantKeys: variants.map((variant) => variant.variantKey),
    },
    variants: variants.map((variant) => ({
      variantKey: variant.variantKey,
      title: variant.variantKey,
      description: "测试Pi能力",
      capabilityCatalogSha256: "2".repeat(64),
      readiness: "available",
      diagnostics: [],
      enabledToolNames: variant.tools,
      piSystemPrompt: {
        bodyMarkdown: `Pi runtime ${variant.variantKey}`,
        sha256: "b".repeat(64),
        dynamicPlaceholders: ["WORKSPACE_ROOT"],
        sourceRelativePaths: ["pi/packages/coding-agent/src/core/system-prompt.ts"],
      },
      tools: variant.tools.map((name) =>
        runtimeToolFixture(
          name,
          name === "project_bootstrap_prepare" ? {} : { workspaceRootId: "root_code" },
        ),
      ),
    })),
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
    noteIds: noteIds(),
    promptCatalog: await createFilePromptCatalog(undefined, {
      ...process.env,
      CHAT_PLANE_ENABLED: "1",
    }),
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

async function forceRunLifecycleForTerminalTest(
  deps: ApplicationDeps,
  input: {
    readonly commandId: string;
    readonly productRunId: string;
    readonly status: "running";
    readonly phase: "validating" | "extracting" | "classifying" | "committing";
  },
): Promise<void> {
  await deps.store.transact({
    commandId: input.commandId as never,
    // 仅构造历史中间态；使用Store已知的空引用Receipt形状，避免放宽生产完整性规则。
    commandType: "UpdateOutboxStatus",
    requestSha256: hashCanonical("test.prepare-runtime-terminal.v1", input),
    traceContext: { productRunId: input.productRunId as never },
    mutate: (draft) => {
      const run = draft.entities.runs[input.productRunId];
      if (run === undefined) throw new Error("测试Product Run不存在");
      draft.entities.runs[input.productRunId] = {
        ...run,
        status: input.status,
        phase: input.phase,
        revision: run.revision + 1,
        updatedAt: deps.now(),
      } as typeof run;
      return { resultRefs: {} };
    },
  });
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

function workflowStartFor(snapshot: ProductSnapshot, productRunId: string) {
  const entry = Object.values(snapshot.outbox).find(
    (candidate) => candidate.kind === "workflow_start" && candidate.productRunId === productRunId,
  );
  if (entry === undefined || entry.kind !== "workflow_start") {
    throw new Error("缺少Workflow Start Outbox");
  }
  return entry;
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
async function seedPromptReviewWaiting() {
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
  return {
    ...seeded,
    begun,
    canonicalPayloadJson,
    published,
    workflowAttemptId: workflowAttempt.attemptId,
  };
}

async function seedPromptReviewResume() {
  const waiting = await seedPromptReviewWaiting();
  const approved = await submitPromptReviewDecision(waiting.deps, {
    principalId: "usr_dispatchtest" as never,
    productRunId: waiting.published.promptReview.productRunId,
    commandId: "cmd_promptreviewapprove" as never,
    expectedRunRevision: waiting.published.runRevision,
    payload: {
      promptReviewRequestId: waiting.published.promptReview.promptReviewRequestId,
      requestRevision: waiting.published.promptReview.requestRevision,
      reviewSha256: waiting.published.promptReview.reviewSha256,
      payloadSha256: waiting.published.promptReview.payloadSha256,
      kind: "approve",
    },
  });
  const committed = (await waiting.deps.store.read({ kind: "committedSnapshot" })).snapshot;
  const resumeOutbox = Object.values(committed.outbox).find(
    (entry) =>
      entry.kind === "workflow_resume" &&
      entry.promptReviewRequestId === waiting.published.promptReview.promptReviewRequestId &&
      entry.promptReviewDecisionId === approved.decision.promptReviewDecisionId,
  );
  if (resumeOutbox?.kind !== "workflow_resume") {
    throw new Error("Prompt Review Decision没有产生workflow_resume Outbox");
  }
  return {
    ...waiting,
    approved,
    resumeOutbox,
  };
}

/**
 * 用真实JsonProductStore形成具备project_bootstrap能力的Direct Run与prepared Candidate。
 * Workspace/Plane只在Dispatcher消费确认事务产生的Outbox后执行，不依赖Bridge或浏览器。
 */
async function seedProjectBootstrapDispatch() {
  const seeded = await seed();
  const workspace = {
    listRoots: () => [{ rootId: "root_code" as never, displayName: "Code" }],
    preflight: vi.fn(async () => ({
      root: { rootId: "root_code" as never, displayName: "Code" },
      directoryName: "ai-learning",
      workspaceLabel: "Code/ai-learning",
    })),
    provision: vi.fn(
      async (
        _input: Parameters<
          NonNullable<ApplicationDeps["projectWorkspaceProvisioner"]>["provision"]
        >[0],
      ) => ({
        status: "completed" as const,
        workspaceLabel: "Code/ai-learning",
      }),
    ),
    reconcile: vi.fn(async () => ({
      status: "completed" as const,
      workspaceLabel: "Code/ai-learning",
    })),
  };
  const plane = {
    describe: () => ({
      providerKind: "plane_ce" as const,
      providerVersion: "1.4.1",
      providerWebBaseUrl: "http://127.0.0.1:8080",
      allowedWorkspaceSlugs: ["learning"],
    }),
    preflight: vi.fn(async () => ({ planeProjectLabel: "Learning/AI2026" })),
    provision: vi.fn(
      async (
        _input: Parameters<
          NonNullable<ApplicationDeps["projectManagementBootstrap"]>["provision"]
        >[0],
      ) => ({
        status: "completed" as const,
        planeProjectId: "66cf0460-84e0-4d3d-b1ef-d193b83b7562" as never,
      }),
    ),
    reconcile: vi.fn(async () => ({
      status: "completed" as const,
      planeProjectId: "66cf0460-84e0-4d3d-b1ef-d193b83b7562" as never,
    })),
  };
  const deps: ApplicationDeps = {
    ...seeded.deps,
    projectBootstrapIds: {
      candidate: () => "pbc_candidate1" as never,
      decision: () => "pbd_decision1" as never,
      operation: () => "pbo_operation1" as never,
      binding: () => "pwb_binding1" as never,
    },
    projectBootstrapExecutionCoordinator: createInProcessProjectBootstrapExecutionCoordinator(),
    projectWorkspaceProvisioner: workspace,
    projectManagementBootstrap: plane,
  };
  const initial = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
  const directRevision =
    initial.entities.workflowDefinitionRevisions[SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID];
  if (directRevision === undefined) throw new Error("缺少Direct Agent系统Definition");
  const submitted = await submitProjectBootstrapUserMessage(deps, {
    principalId: "usr_dispatchtest" as never,
    sessionId: seeded.sessionId as never,
    commandId: "cmd_bootstrapsubmit" as never,
    payload: {
      text: "创建一个持续学习AI课程、论文和开源项目的项目",
      workflowSelection: {
        kind: "published_revision",
        workflowDefinitionRevisionId: directRevision.workflowDefinitionRevisionId,
        definitionSha256: directRevision.definitionSha256,
        runConfiguration: {
          schemaVersion: "workflow-run-configuration.v1",
          overrides: [
            {
              kind: "node_config",
              definitionNodeId: "direct.agent",
              field: "capabilityMode",
              value: "project_bootstrap",
            },
          ],
        },
      },
    },
  });
  const afterSubmit = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
  const workflowAttempt = Object.values(afterSubmit.entities.attempts).find(
    (attempt) => attempt.productRunId === submitted.run.productRunId && attempt.kind === "workflow",
  );
  if (workflowAttempt === undefined) throw new Error("缺少Direct Workflow Attempt");
  await beginDirectAgentAttempt(deps, {
    commandId: "cmd_bootstrapbegin" as never,
    productRunId: submitted.run.productRunId,
    workflowAttemptId: workflowAttempt.attemptId,
  });
  const candidate = await prepareProjectBootstrapCandidate(deps, {
    principalId: "usr_dispatchtest" as never,
    productSessionId: seeded.sessionId as never,
    productRunId: submitted.run.productRunId,
    commandId: "cmd_bootstrapprepare" as never,
    proposal: {
      name: "AI学习",
      objective: "学习公开课程、论文和开源项目，并形成自己的实践项目。",
      planeWorkspaceSlug: "learning",
      planeProjectIdentifier: "AI2026",
      workspaceRootId: "root_code",
      directoryName: "ai-learning",
      initializerProfile: "ai_learning",
      initialModules: ["公开课", "论文", "开源项目", "实践项目"],
    },
  });
  const beforeDisable = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
  const workflowStarts = Object.values(beforeDisable.outbox).filter(
    (entry) => entry.kind === "workflow_start" && entry.status === "pending",
  );
  for (const [index, entry] of workflowStarts.entries()) {
    await updateOutboxStatus(deps, {
      commandId: `cmd_disablebootstrapstart${String(index + 1)}` as never,
      outboxId: entry.outboxId,
      status: "failed_terminal",
    });
  }
  return { ...seeded, candidate, deps, plane, workspace };
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

describe("通用Product Workflow终态监督", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Planning Runtime失败只收敛一次，后续Runtime证据不覆盖产品终态", async () => {
    const seeded = await seed();
    let snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const start = workflowStartFor(snapshot, seeded.productRunId);
    await updateOutboxStatus(seeded.deps, {
      commandId: "cmd_ackplanningterminal" as never,
      outboxId: start.outboxId,
      status: "acknowledged",
    });
    seeded.advance(2_000);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          schemaVersion: "chat-workflow-dispatch.v1",
          productRunId: seeded.productRunId,
          startBinding: "exists",
          runtimeRun: { state: "terminal", outcome: "failed" },
        }),
      )
      .mockResolvedValue(
        Response.json({
          schemaVersion: "chat-workflow-dispatch.v1",
          productRunId: seeded.productRunId,
          startBinding: "exists",
          runtimeRun: { state: "terminal", outcome: "cancelled" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const dispatcher = new OutboxDispatcher({
      deps: seeded.deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
      projectBootstrapEnabled: true,
    });

    await dispatcher.tick();
    snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const firstTerminal = snapshot.entities.runs[seeded.productRunId];
    expect(firstTerminal).toMatchObject({
      status: "failed",
      failure: { code: "workflow.runtime_failed_without_product_commit" },
    });
    await dispatcher.tick();
    const replayed = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(replayed.entities.runs[seeded.productRunId]).toEqual(firstTerminal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Direct Runtime失败使用同一监督命令收敛，且不创建第二个Workflow", async () => {
    const seeded = await seed();
    let snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const initialStart = workflowStartFor(snapshot, seeded.productRunId);
    await updateOutboxStatus(seeded.deps, {
      commandId: "cmd_disableinitialplanning" as never,
      outboxId: initialStart.outboxId,
      status: "failed_terminal",
    });
    const directRevision =
      snapshot.entities.workflowDefinitionRevisions[SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID];
    if (directRevision === undefined) throw new Error("缺少Direct Workflow Revision");
    const direct = await submitUserMessage(seeded.deps, {
      principalId: "usr_dispatchtest" as never,
      sessionId: seeded.sessionId as never,
      commandId: "cmd_submitdirectterminal" as never,
      payload: {
        text: "运行Direct Agent",
        workflowSelection: {
          kind: "published_revision",
          workflowDefinitionRevisionId: directRevision.workflowDefinitionRevisionId,
          definitionSha256: directRevision.definitionSha256,
        },
      },
    });
    snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const directStart = workflowStartFor(snapshot, direct.run.productRunId);
    await updateOutboxStatus(seeded.deps, {
      commandId: "cmd_ackdirectterminal" as never,
      outboxId: directStart.outboxId,
      status: "acknowledged",
    });
    seeded.advance(2_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          schemaVersion: "chat-workflow-dispatch.v1",
          productRunId: direct.run.productRunId,
          startBinding: "exists",
          runtimeRun: { state: "terminal", outcome: "failed" },
        }),
      ),
    );
    const dispatcher = new OutboxDispatcher({
      deps: seeded.deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
    });

    await dispatcher.tick();
    snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(snapshot.entities.runs[direct.run.productRunId]).toMatchObject({
      runKind: "direct_agent",
      status: "failed",
      failure: { code: "workflow.runtime_failed_without_product_commit" },
    });
    expect(
      Object.values(snapshot.outbox).filter(
        (entry) =>
          entry.kind === "workflow_start" && entry.productRunId === direct.run.productRunId,
      ),
    ).toHaveLength(1);
  });

  it("Runtime取消映射为Product cancelled，且保留同一Start Binding", async () => {
    const seeded = await seed();
    let snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const start = workflowStartFor(snapshot, seeded.productRunId);
    await updateOutboxStatus(seeded.deps, {
      commandId: "cmd_ackcancelledterminal" as never,
      outboxId: start.outboxId,
      status: "acknowledged",
    });
    seeded.advance(2_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          schemaVersion: "chat-workflow-dispatch.v1",
          productRunId: seeded.productRunId,
          startBinding: "exists",
          runtimeRun: { state: "terminal", outcome: "cancelled" },
        }),
      ),
    );
    const dispatcher = new OutboxDispatcher({
      deps: seeded.deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
    });

    await dispatcher.tick();
    snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(snapshot.entities.runs[seeded.productRunId]).toMatchObject({
      status: "cancelled",
      phase: "queued",
    });
    expect(snapshot.entities.runs[seeded.productRunId]?.failure).toBeUndefined();
    expect(snapshot.outbox[start.outboxId]).toMatchObject({
      status: "acknowledged",
      dispatchAttempts: 0,
    });
  });

  it("单个Workflow监督事务失败不会阻断同轮后续acknowledged条目", async () => {
    const seeded = await seed();
    seeded.advance(100);
    const second = await submitUserMessage(seeded.deps, {
      principalId: "usr_dispatchtest" as never,
      sessionId: seeded.sessionId as never,
      commandId: "cmd_secondpoisonisolation" as never,
      payload: { text: "第二个Workflow必须继续被监督" },
    });
    let snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const firstStart = workflowStartFor(snapshot, seeded.productRunId);
    const secondStart = workflowStartFor(snapshot, second.run.productRunId);
    await updateOutboxStatus(seeded.deps, {
      commandId: "cmd_ackfirstpoisonisolation" as never,
      outboxId: firstStart.outboxId,
      status: "acknowledged",
    });
    await updateOutboxStatus(seeded.deps, {
      commandId: "cmd_acksecondpoisonisolation" as never,
      outboxId: secondStart.outboxId,
      status: "acknowledged",
    });
    seeded.advance(2_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: string | URL | Request) => {
        const productRunId = new URL(String(request)).searchParams.get("productRunId");
        return Response.json({
          schemaVersion: "chat-workflow-dispatch.v1",
          productRunId,
          startBinding: "exists",
          runtimeRun: { state: "terminal", outcome: "cancelled" },
        });
      }),
    );
    const realStore = seeded.deps.store;
    let poisonCount = 1;
    const isolatedDeps: ApplicationDeps = {
      ...seeded.deps,
      store: {
        read: (query) => realStore.read(query),
        transact: (command) => {
          if (command.commandType === "SettleRunAfterTerminalWorkflow" && poisonCount > 0) {
            poisonCount -= 1;
            throw new Error("test.projection_poison");
          }
          return realStore.transact(command);
        },
      },
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dispatcher = new OutboxDispatcher({
      deps: isolatedDeps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
    });

    await dispatcher.tick();

    snapshot = (await realStore.read({ kind: "committedSnapshot" })).snapshot;
    expect(snapshot.entities.runs[seeded.productRunId]?.status).not.toBe("cancelled");
    expect(snapshot.entities.runs[second.run.productRunId]?.status).toBe("cancelled");
    expect(snapshot.outbox[firstStart.outboxId]?.status).toBe("acknowledged");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`durableId=${firstStart.outboxId}`),
    );
  });

  it("Planning validating可由Runtime取消终态经Application与Json Store收敛", async () => {
    const seeded = await seed();
    const planning = await compilePlanningInput(seeded.deps, {
      commandId: "cmd_compilevalidatingcancel" as never,
      productRunId: seeded.productRunId as never,
      planRevision: 1,
    });
    const review = await publishPlanForReview(seeded.deps, {
      commandId: "cmd_publishvalidatingcancel" as never,
      productRunId: seeded.productRunId as never,
      attemptId: planning.attemptId,
      expectedRunRevision: planning.inputRunRevision,
      inputManifestSha256: planning.inputManifestSha256,
      content: {
        objective: "验证取消阶段完整性",
        summary: "生成Approved Plan后模拟持久化validating中间态",
        assumptions: [],
        openQuestions: [],
        steps: [
          {
            stepId: "step-1",
            title: "验证结果",
            purpose: "形成可验证的Approved Plan",
            dependsOn: [],
            inputRefs: [],
            expectedOutput: "验证证据",
            successCriteria: ["验证完成"],
            requestedCapabilities: [],
            risk: "low",
          },
        ],
        completionCriteria: ["验证完成"],
        warnings: [],
      },
    });
    const approved = await submitPlanDecision(seeded.deps, {
      principalId: "usr_dispatchtest" as never,
      commandId: "cmd_approvevalidatingcancel" as never,
      productRunId: seeded.productRunId as never,
      expectedRunRevision: review.run.revision,
      payload: {
        approvalRequestId: review.approval.approvalRequestId,
        planId: review.plan.planId,
        planRevision: review.plan.planRevision,
        planSha256: review.plan.sha256,
        kind: "approve",
      },
    });
    await compileExecutionContract(seeded.deps, {
      commandId: "cmd_contractvalidatingcancel" as never,
      productRunId: seeded.productRunId as never,
      approvalDecisionId: approved.decision.decisionId,
    });
    let snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const resume = Object.values(snapshot.outbox).find(
      (entry) => entry.kind === "workflow_resume" && entry.productRunId === seeded.productRunId,
    );
    if (resume === undefined) throw new Error("Approved Plan缺少Resume Outbox");
    await updateOutboxStatus(seeded.deps, {
      commandId: "cmd_disablevalidatingresume" as never,
      outboxId: resume.outboxId,
      status: "failed_terminal",
    });
    await forceRunLifecycleForTerminalTest(seeded.deps, {
      commandId: "cmd_forcevalidatingcancel",
      productRunId: seeded.productRunId,
      status: "running",
      phase: "validating",
    });
    snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const start = workflowStartFor(snapshot, seeded.productRunId);
    await updateOutboxStatus(seeded.deps, {
      commandId: "cmd_ackvalidatingcancel" as never,
      outboxId: start.outboxId,
      status: "acknowledged",
    });
    seeded.advance(2_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          schemaVersion: "chat-workflow-dispatch.v1",
          productRunId: seeded.productRunId,
          startBinding: "exists",
          runtimeRun: { state: "terminal", outcome: "cancelled" },
        }),
      ),
    );
    const dispatcher = new OutboxDispatcher({
      deps: seeded.deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
    });

    await dispatcher.tick();
    snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(snapshot.entities.runs[seeded.productRunId]).toMatchObject({
      runKind: "planning",
      status: "cancelled",
      phase: "validating",
    });
  });

  it("Runtime active时多次tick不干预waiting_human Product Run", async () => {
    const seeded = await seed();
    const planning = await compilePlanningInput(seeded.deps, {
      commandId: "cmd_compilewaitingsupervision" as never,
      productRunId: seeded.productRunId as never,
      planRevision: 1,
    });
    const published = await publishPlanForReview(seeded.deps, {
      commandId: "cmd_publishwaitingsupervision" as never,
      productRunId: seeded.productRunId as never,
      attemptId: planning.attemptId,
      expectedRunRevision: planning.inputRunRevision,
      inputManifestSha256: planning.inputManifestSha256,
      content: {
        objective: "等待用户确认",
        summary: "验证Runtime active不会被监督器误判",
        assumptions: [],
        openQuestions: [],
        steps: [
          {
            stepId: "step-1",
            title: "等待确认",
            purpose: "保留人工审核",
            dependsOn: [],
            inputRefs: [],
            expectedOutput: "确认结果",
            successCriteria: ["用户已确认"],
            requestedCapabilities: [],
            risk: "low",
          },
        ],
        completionCriteria: ["用户已确认"],
        warnings: [],
      },
    });
    let snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const start = workflowStartFor(snapshot, seeded.productRunId);
    await updateOutboxStatus(seeded.deps, {
      commandId: "cmd_ackwaitingsupervision" as never,
      outboxId: start.outboxId,
      status: "acknowledged",
    });
    seeded.advance(2_000);
    const fetchMock = vi.fn(async () =>
      Response.json({
        schemaVersion: "chat-workflow-dispatch.v1",
        productRunId: seeded.productRunId,
        startBinding: "exists",
        runtimeRun: { state: "active" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const dispatcher = new OutboxDispatcher({
      deps: seeded.deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
    });

    await dispatcher.tick();
    await dispatcher.tick();
    snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(snapshot.entities.runs[seeded.productRunId]).toMatchObject({
      status: "waiting_human",
      phase: "plan_review",
      revision: published.run.revision,
    });

    fetchMock.mockResolvedValue(
      Response.json({
        schemaVersion: "chat-workflow-dispatch.v1",
        productRunId: seeded.productRunId,
        startBinding: "exists",
        runtimeRun: { state: "terminal", outcome: "outcome_unknown" },
      }),
    );
    await dispatcher.tick();
    snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(snapshot.entities.runs[seeded.productRunId]).toMatchObject({
      status: "outcome_unknown",
      phase: "plan_review",
    });
  });

  it("Direct prompt_review可由Runtime未知终态经Json Store收敛", async () => {
    const waiting = await seedPromptReviewWaiting();
    let snapshot = (await waiting.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const start = workflowStartFor(snapshot, waiting.published.promptReview.productRunId);
    await updateOutboxStatus(waiting.deps, {
      commandId: "cmd_ackdirectwaitingterminal" as never,
      outboxId: start.outboxId,
      status: "acknowledged",
    });
    waiting.advance(2_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          schemaVersion: "chat-workflow-dispatch.v1",
          productRunId: waiting.published.promptReview.productRunId,
          startBinding: "exists",
          runtimeRun: { state: "terminal", outcome: "outcome_unknown" },
        }),
      ),
    );
    const dispatcher = new OutboxDispatcher({
      deps: waiting.deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
    });

    await dispatcher.tick();
    snapshot = (await waiting.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(snapshot.entities.runs[waiting.published.promptReview.productRunId]).toMatchObject({
      status: "outcome_unknown",
      phase: "prompt_review",
    });
    expect(
      Object.values(snapshot.entities.workflowNodeRuns).filter(
        (node) =>
          node.productRunId === waiting.published.promptReview.productRunId &&
          (node.status === "running" || node.status === "waiting_human"),
      ),
    ).toEqual([]);
  });

  it("Note note_review可由Runtime未知终态经Json Store收敛", async () => {
    const seeded = await seed();
    let snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const planningStart = workflowStartFor(snapshot, seeded.productRunId);
    await updateOutboxStatus(seeded.deps, {
      commandId: "cmd_disablenoteplanning" as never,
      outboxId: planningStart.outboxId,
      status: "failed_terminal",
    });
    const noteRevision =
      snapshot.entities.workflowDefinitionRevisions[SYSTEM_NOTE_WORKFLOW_REVISION_ID];
    if (noteRevision === undefined) throw new Error("缺少Note Workflow Revision");
    const note = await submitUserMessage(seeded.deps, {
      principalId: "usr_dispatchtest" as never,
      sessionId: seeded.sessionId as never,
      commandId: "cmd_submitnoteterminal" as never,
      payload: {
        text: "把这段内容沉淀为Note",
        workflowSelection: {
          kind: "published_revision",
          workflowDefinitionRevisionId: noteRevision.workflowDefinitionRevisionId,
          definitionSha256: noteRevision.definitionSha256,
          businessInput: {
            kind: "note_capture",
            defaultKind: "general",
            suggestedTagLabels: [],
          },
        },
      },
    });
    await publishNoteCandidate(seeded.deps, {
      commandId: "cmd_publishnoteterminal" as never,
      productRunId: note.run.productRunId as never,
      proposed: {
        title: "待审核Note",
        kind: "general",
        contentMarkdown: "Runtime终止前形成的待审核Note。",
        tagLabels: [],
      },
    });
    snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const noteStart = workflowStartFor(snapshot, note.run.productRunId);
    await updateOutboxStatus(seeded.deps, {
      commandId: "cmd_acknoteterminal" as never,
      outboxId: noteStart.outboxId,
      status: "acknowledged",
    });
    seeded.advance(2_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          schemaVersion: "chat-workflow-dispatch.v1",
          productRunId: note.run.productRunId,
          startBinding: "exists",
          runtimeRun: { state: "terminal", outcome: "outcome_unknown" },
        }),
      ),
    );
    const dispatcher = new OutboxDispatcher({
      deps: seeded.deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
    });

    await dispatcher.tick();
    snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(snapshot.entities.runs[note.run.productRunId]).toMatchObject({
      runKind: "note_capture",
      status: "outcome_unknown",
      phase: "note_review",
    });
    expect(
      Object.values(snapshot.entities.workflowNodeRuns).filter(
        (node) =>
          node.productRunId === note.run.productRunId &&
          (node.status === "running" || node.status === "waiting_human"),
      ),
    ).toEqual([]);
    expect(
      Object.values(snapshot.entities.noteCandidates).find(
        (candidate) => candidate.productRunId === note.run.productRunId,
      ),
    ).toMatchObject({ status: "failed" });
    const current = await getCurrentNoteCandidate(seeded.deps, {
      principalId: "usr_dispatchtest" as never,
      productRunId: note.run.productRunId,
    });
    expect(current.candidate?.allowedActions).toEqual([]);
  });

  it.each(["extracting", "classifying", "committing"] as const)(
    "Note %s可由Runtime取消终态经Application与Json Store收敛",
    async (phase) => {
      const seeded = await seed();
      let snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
      const planningStart = workflowStartFor(snapshot, seeded.productRunId);
      await updateOutboxStatus(seeded.deps, {
        commandId: `cmd_disablenotecancel${phase}` as never,
        outboxId: planningStart.outboxId,
        status: "failed_terminal",
      });
      const noteRevision =
        snapshot.entities.workflowDefinitionRevisions[SYSTEM_NOTE_WORKFLOW_REVISION_ID];
      if (noteRevision === undefined) throw new Error("缺少Note Workflow Revision");
      const note = await submitUserMessage(seeded.deps, {
        principalId: "usr_dispatchtest" as never,
        sessionId: seeded.sessionId as never,
        commandId: `cmd_submitnotecancel${phase}` as never,
        payload: {
          text: `把${phase}阶段收敛为取消`,
          workflowSelection: {
            kind: "published_revision",
            workflowDefinitionRevisionId: noteRevision.workflowDefinitionRevisionId,
            definitionSha256: noteRevision.definitionSha256,
            businessInput: {
              kind: "note_capture",
              defaultKind: "general",
              suggestedTagLabels: [],
            },
          },
        },
      });
      await forceRunLifecycleForTerminalTest(seeded.deps, {
        commandId: `cmd_forcenotecancel${phase}`,
        productRunId: note.run.productRunId,
        status: "running",
        phase,
      });
      snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
      const noteStart = workflowStartFor(snapshot, note.run.productRunId);
      await updateOutboxStatus(seeded.deps, {
        commandId: `cmd_acknotecancel${phase}` as never,
        outboxId: noteStart.outboxId,
        status: "acknowledged",
      });
      seeded.advance(2_000);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            schemaVersion: "chat-workflow-dispatch.v1",
            productRunId: note.run.productRunId,
            startBinding: "exists",
            runtimeRun: { state: "terminal", outcome: "cancelled" },
          }),
        ),
      );
      const dispatcher = new OutboxDispatcher({
        deps: seeded.deps,
        workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
        credential: "rtk_test",
      });

      await dispatcher.tick();
      snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
      expect(snapshot.entities.runs[note.run.productRunId]).toMatchObject({
        runKind: "note_capture",
        status: "cancelled",
        phase,
      });
    },
  );

  it("长时间active后的单次查询抖动只开始新unknown窗口，恢复active会清除", async () => {
    const seeded = await seed();
    let snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const start = workflowStartFor(snapshot, seeded.productRunId);
    await updateOutboxStatus(seeded.deps, {
      commandId: "cmd_acktransientunknown" as never,
      outboxId: start.outboxId,
      status: "acknowledged",
    });
    seeded.advance(3_600_000);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient reconcile failure"))
      .mockResolvedValue(
        Response.json({
          schemaVersion: "chat-workflow-dispatch.v1",
          productRunId: seeded.productRunId,
          startBinding: "exists",
          runtimeRun: { state: "active" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const dispatcher = new OutboxDispatcher({
      deps: seeded.deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
    });

    await dispatcher.tick();
    snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(snapshot.entities.runs[seeded.productRunId]?.status).toBe("pending");
    expect(snapshot.outbox[start.outboxId]?.lastErrorCode).toBe("workflow.runtime_query_unknown");
    seeded.advance(2_000);
    await dispatcher.tick();
    snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(snapshot.entities.runs[seeded.productRunId]?.status).toBe("pending");
    expect(snapshot.outbox[start.outboxId]?.lastErrorCode).toBeUndefined();
  });

  it("Runtime查询长期未知只收敛为outcome_unknown，不重启或新增Binding", async () => {
    const seeded = await seed();
    let snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const start = workflowStartFor(snapshot, seeded.productRunId);
    await updateOutboxStatus(seeded.deps, {
      commandId: "cmd_ackunknownsupervision" as never,
      outboxId: start.outboxId,
      status: "acknowledged",
    });
    seeded.advance(31_000);
    const fetchMock = vi.fn(async () =>
      Response.json({
        schemaVersion: "chat-workflow-dispatch.v1",
        productRunId: seeded.productRunId,
        startBinding: "exists",
        runtimeRun: { state: "unknown" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const dispatcher = new OutboxDispatcher({
      deps: seeded.deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
    });

    await dispatcher.tick();
    snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(snapshot.entities.runs[seeded.productRunId]?.status).toBe("pending");
    expect(snapshot.outbox[start.outboxId]?.lastErrorCode).toBe("workflow.runtime_query_unknown");
    seeded.advance(31_000);
    await dispatcher.tick();
    snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(snapshot.entities.runs[seeded.productRunId]).toMatchObject({
      status: "outcome_unknown",
      failure: { code: "workflow.runtime_terminal_outcome_unknown" },
    });
    expect(
      Object.values(snapshot.outbox).filter(
        (entry) => entry.kind === "workflow_start" && entry.productRunId === seeded.productRunId,
      ),
    ).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("Project Bootstrap Outbox耐久执行", () => {
  it("默认关闭Provider时保留旧Bootstrap Outbox且不触达外部写", async () => {
    const seeded = await seedProjectBootstrapDispatch();
    await decideProjectBootstrapCandidate(seeded.deps, {
      principalId: "usr_dispatchtest" as never,
      commandId: "cmd_bootstrapdisabledconfirm" as never,
      projectBootstrapCandidateId: seeded.candidate.projectBootstrapCandidateId,
      candidateRevision: seeded.candidate.revision,
      candidateSha256: seeded.candidate.sha256,
      kind: "confirm",
    });
    const providerDisabledDeps = { ...seeded.deps };
    Reflect.deleteProperty(providerDisabledDeps, "projectManagementBootstrap");
    Reflect.deleteProperty(providerDisabledDeps, "projectWorkspaceProvisioner");
    const dispatcher = new OutboxDispatcher({
      deps: providerDisabledDeps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
      projectBootstrapEnabled: false,
    });

    await expect(dispatcher.tick()).resolves.toBeUndefined();

    const snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(
      Object.values(snapshot.outbox).find((entry) => entry.kind === "project_bootstrap_execute"),
    ).toMatchObject({ status: "pending", dispatchAttempts: 0 });
    expect(seeded.workspace.provision).not.toHaveBeenCalled();
    expect(seeded.plane.provision).not.toHaveBeenCalled();
  });

  it("确认事务原子创建Operation与Outbox，Dispatcher无Bridge收敛且幂等重放不重复建项", async () => {
    const seeded = await seedProjectBootstrapDispatch();
    const beforeDecision = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(seeded.workspace.provision).not.toHaveBeenCalled();
    expect(seeded.plane.provision).not.toHaveBeenCalled();

    const confirmation = {
      principalId: "usr_dispatchtest" as never,
      commandId: "cmd_bootstrapconfirm" as never,
      projectBootstrapCandidateId: seeded.candidate.projectBootstrapCandidateId,
      candidateRevision: seeded.candidate.revision,
      candidateSha256: seeded.candidate.sha256,
      kind: "confirm" as const,
    };
    const decided = await decideProjectBootstrapCandidate(seeded.deps, confirmation);
    const afterDecision = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const operations = Object.values(afterDecision.entities.projectBootstrapOperations);
    const bootstrapOutboxes = Object.values(afterDecision.outbox).filter(
      (entry) => entry.kind === "project_bootstrap_execute",
    );
    expect(afterDecision.storeRevision).toBe(beforeDecision.storeRevision + 1);
    expect(decided.operation).toMatchObject({ status: "queued", revision: 1 });
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ status: "queued", revision: 1 });
    expect(bootstrapOutboxes).toHaveLength(1);
    expect(bootstrapOutboxes[0]).toMatchObject({
      projectBootstrapOperationId: decided.operation?.projectBootstrapOperationId,
      mode: "execute",
      status: "pending",
      dispatchAttempts: 0,
    });

    const replayed = await decideProjectBootstrapCandidate(seeded.deps, confirmation);
    const afterReplay = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(afterReplay.storeRevision).toBe(afterDecision.storeRevision);
    expect(replayed.operation?.projectBootstrapOperationId).toBe(
      decided.operation?.projectBootstrapOperationId,
    );
    expect(Object.values(afterReplay.entities.projectBootstrapOperations)).toHaveLength(1);
    expect(
      Object.values(afterReplay.outbox).filter(
        (entry) => entry.kind === "project_bootstrap_execute",
      ),
    ).toHaveLength(1);

    const fetch = vi.fn(async () => {
      throw new Error("Project Bootstrap派发不应调用Bridge或Workflow HTTP");
    });
    vi.stubGlobal("fetch", fetch);
    const dispatcher = new OutboxDispatcher({
      deps: seeded.deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
      projectBootstrapEnabled: true,
    });
    await dispatcher.tick();
    await dispatcher.tick();

    const completed = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const operation = Object.values(completed.entities.projectBootstrapOperations)[0];
    const outbox = Object.values(completed.outbox).find(
      (entry) => entry.kind === "project_bootstrap_execute",
    );
    expect(operation).toMatchObject({
      status: "ready",
      workspaceStep: "completed",
      planeStep: "completed",
      bindingStep: "completed",
      planeProjectId: "66cf0460-84e0-4d3d-b1ef-d193b83b7562",
    });
    expect(
      completed.entities.projectBootstrapCandidates[seeded.candidate.projectBootstrapCandidateId],
    ).toMatchObject({ status: "ready" });
    expect(Object.values(completed.entities.projectWorkspaceBindings)).toEqual([
      expect.objectContaining({
        productSessionId: seeded.sessionId,
        projectBootstrapOperationId: operation?.projectBootstrapOperationId,
        providerKind: "plane_ce",
        planeWorkspaceSlug: "learning",
        planeProjectIdentifier: "AI2026",
        workspaceRootId: "root_code",
        directoryName: "ai-learning",
        status: "active",
      }),
    ]);
    expect(outbox).toMatchObject({ status: "acknowledged", dispatchAttempts: 1 });
    expect(fetch).not.toHaveBeenCalled();
    expect(seeded.workspace.provision).toHaveBeenCalledTimes(1);
    expect(seeded.plane.provision).toHaveBeenCalledTimes(1);
    expect(seeded.workspace.reconcile).not.toHaveBeenCalled();
    expect(seeded.plane.reconcile).not.toHaveBeenCalled();
  });

  it("两个Dispatcher重叠执行时活跃lease阻止第二次Provider写入", async () => {
    const seeded = await seedProjectBootstrapDispatch();
    await decideProjectBootstrapCandidate(seeded.deps, {
      principalId: "usr_dispatchtest" as never,
      commandId: "cmd_bootstrapconcurrentconfirm" as never,
      projectBootstrapCandidateId: seeded.candidate.projectBootstrapCandidateId,
      candidateRevision: seeded.candidate.revision,
      candidateSha256: seeded.candidate.sha256,
      kind: "confirm",
    });
    let releaseProvision!: () => void;
    let provisionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      provisionStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseProvision = resolve;
    });
    seeded.workspace.provision.mockImplementationOnce(async () => {
      provisionStarted();
      await blocked;
      return { status: "completed" as const, workspaceLabel: "Code/ai-learning" };
    });
    const first = new OutboxDispatcher({
      deps: seeded.deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
      projectBootstrapEnabled: true,
      dispatcherInstanceId: "dispatcher-a",
    });
    const second = new OutboxDispatcher({
      deps: seeded.deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
      projectBootstrapEnabled: true,
      dispatcherInstanceId: "dispatcher-b",
    });

    const firstTick = first.tick();
    await started;
    const activeProjection = await getCurrentProjectBootstrapForSession(seeded.deps, {
      principalId: "usr_dispatchtest" as never,
      productSessionId: seeded.sessionId as never,
    });
    if (activeProjection === null) throw new Error("活跃Operation缺少建项投影");
    expect(activeProjection.recovery).toEqual({
      canRecover: false,
      reason: "active_execution",
    });
    const secondTick = second.tick();
    await Promise.resolve();
    expect(seeded.workspace.provision).toHaveBeenCalledTimes(1);
    expect(seeded.workspace.reconcile).not.toHaveBeenCalled();
    expect(seeded.plane.provision).not.toHaveBeenCalled();

    releaseProvision();
    await Promise.all([firstTick, secondTick]);
    const completed = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(Object.values(completed.entities.projectBootstrapOperations)[0]?.status).toBe("ready");
    expect(seeded.workspace.provision).toHaveBeenCalledTimes(1);
    expect(seeded.plane.provision).toHaveBeenCalledTimes(1);
  });

  it("同一Dispatcher崩溃后在lease过期的新tick形成新attempt并先对账", async () => {
    const seeded = await seedProjectBootstrapDispatch();
    await decideProjectBootstrapCandidate(seeded.deps, {
      principalId: "usr_dispatchtest" as never,
      commandId: "cmd_bootstrapstaleconfirm" as never,
      projectBootstrapCandidateId: seeded.candidate.projectBootstrapCandidateId,
      candidateRevision: seeded.candidate.revision,
      candidateSha256: seeded.candidate.sha256,
      kind: "confirm",
    });
    seeded.workspace.provision.mockRejectedValueOnce(new Error("simulated process crash"));
    const crashed = new OutboxDispatcher({
      deps: seeded.deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
      projectBootstrapEnabled: true,
      dispatcherInstanceId: "dispatcher-crashed",
    });
    await expect(crashed.tick()).rejects.toThrow("simulated process crash");
    let snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const pending = Object.values(snapshot.outbox).find(
      (entry) => entry.kind === "project_bootstrap_execute",
    );
    expect(pending).toMatchObject({
      status: "pending",
      executionLease: { mode: "execute" },
    });
    expect(Object.values(snapshot.entities.projectBootstrapOperations)[0]?.status).toBe(
      "dispatching",
    );

    seeded.advance(600_001);
    await crashed.tick();
    snapshot = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(Object.values(snapshot.entities.projectBootstrapOperations)[0]?.status).toBe("ready");
    expect(seeded.workspace.provision).toHaveBeenCalledTimes(1);
    expect(seeded.plane.provision).not.toHaveBeenCalled();
    expect(seeded.workspace.reconcile).toHaveBeenCalledTimes(1);
    expect(seeded.plane.reconcile).toHaveBeenCalledTimes(1);
    expect(
      Object.values(snapshot.commandReceipts).filter(
        (receipt) => receipt.commandType === "ClaimProjectBootstrapOperation",
      ),
    ).toHaveLength(2);
  });

  it("旧attempt写前校验后暂停超过lease时，新Dispatcher必须等待其退出再对账", async () => {
    const seeded = await seedProjectBootstrapDispatch();
    await decideProjectBootstrapCandidate(seeded.deps, {
      principalId: "usr_dispatchtest" as never,
      commandId: "cmd_bootstrapfenceconfirm" as never,
      projectBootstrapCandidateId: seeded.candidate.projectBootstrapCandidateId,
      candidateRevision: seeded.candidate.revision,
      candidateSha256: seeded.candidate.sha256,
      kind: "confirm",
    });
    let releaseOldAttempt!: () => void;
    let oldAttemptValidated!: () => void;
    let externalWrites = 0;
    const validated = new Promise<void>((resolve) => {
      oldAttemptValidated = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseOldAttempt = resolve;
    });
    seeded.workspace.provision.mockImplementationOnce(async (input) => {
      await input.writeFence.assertCurrent("test.workspace.external-post");
      oldAttemptValidated();
      await blocked;
      externalWrites += 1;
      return { status: "completed" as const, workspaceLabel: "Code/ai-learning" };
    });
    seeded.workspace.reconcile.mockImplementation(async () =>
      externalWrites === 1
        ? { status: "completed" as const, workspaceLabel: "Code/ai-learning" }
        : ({ status: "failed", errorCode: "project_workspace_not_found" } as never),
    );

    const dispatcherA = new OutboxDispatcher({
      deps: seeded.deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
      projectBootstrapEnabled: true,
      dispatcherInstanceId: "dispatcher-fence-a",
    });
    const oldTick = dispatcherA.tick();
    await validated;
    seeded.advance(600_001);
    const dispatcherB = new OutboxDispatcher({
      deps: seeded.deps,
      workflowRuntimeBaseUrl: "http://127.0.0.1:43112",
      credential: "rtk_test",
      projectBootstrapEnabled: true,
      dispatcherInstanceId: "dispatcher-fence-b",
    });

    const takeoverTick = dispatcherB.tick();
    await Promise.resolve();
    expect(externalWrites).toBe(0);
    expect(seeded.workspace.provision).toHaveBeenCalledTimes(1);
    expect(seeded.workspace.reconcile).not.toHaveBeenCalled();

    releaseOldAttempt();
    await expect(oldTick).rejects.toMatchObject({ code: "revision_conflict" });
    await takeoverTick;
    const completed = (await seeded.deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(Object.values(completed.entities.projectBootstrapOperations)[0]?.status).toBe("ready");
    expect(externalWrites).toBe(1);
    expect(seeded.workspace.provision).toHaveBeenCalledTimes(1);
    expect(seeded.workspace.reconcile).toHaveBeenCalledTimes(1);
    expect(seeded.plane.provision).not.toHaveBeenCalled();
  });
});
