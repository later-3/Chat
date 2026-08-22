import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  approvalDtoSchema,
  agentProfileDtoSchema,
  agentProfilesDtoSchema,
  agentRuntimeBaselineDtoSchema,
  toAgentVersionHashInput,
  beginPlanningContextResponseSchema,
  decisionDtoSchema,
  messageResponseSchema,
  messageDtoSchema,
  planDtoSchema,
  preparePlanningContextResponseSchema,
  problemDetailSchema,
  runDtoSchema,
  sessionDtoSchema,
  cursorPageSchema,
  memoryBackendProfileDtoSchema,
  memoryImportDtoSchema,
  memoryImportResultResponseSchema,
  listMemoryProvidersResponseSchema,
  listMemoryWritesResponseSchema,
  memoryWriteResponseSchema,
  INTERNAL_RUNTIME_SCHEMA_VERSION,
  MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
  runContextDtoSchema,
  workflowRunViewDtoSchema,
  workflowNodeDetailDtoSchema,
  workflowDefinitionsDtoSchema,
  workflowDefinitionCommandResultDtoSchema,
  currentPromptReviewResponseSchema,
  promptAssemblyPreviewDtoSchema,
  promptConfigurationPreviewDtoSchema,
  promptTurnPreviewDtoSchema,
  promptWorkspacesDtoSchema,
  promptReviewDecisionDtoSchema,
  type CommandId,
  type PlanContent,
  type PrincipalId,
  type ProductRunId,
  type AgentKey,
  currentProjectBootstrapResponseSchema,
  prepareProjectBootstrapRuntimeResponseSchema,
  projectBootstrapDecisionResponseSchema,
  projectBootstrapOperationSchema,
} from "@chat/contracts";
import {
  beginDirectAgentAttempt,
  compilePlanningInput,
  normalizeMemoryQueryResult,
  markMemoryWriteDispatching,
  publishPromptReviewRequest,
  transitionConfigurablePlanningNode,
  updateOutboxStatus,
  publishPlanForReview as publishPlanForReviewUseCase,
  type ApplicationDeps,
  type DirectAgentIdFactory,
  type IdFactory,
  type RuleIdFactory,
  type PromptFragmentIdFactory,
  type ProjectBootstrapIdFactory,
} from "@chat/application";
import {
  SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID,
  SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID,
  SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
} from "@chat/application/workflow-system-definitions";
import {
  canonicalJsonStringify,
  computePromptReviewPayloadSha256,
  hashCanonical,
} from "@chat/domain";
import { JsonProductStore } from "@chat/product-store-json";
import { z } from "zod";
import { createApiApp, type ApiApp } from "./app.js";
import { DEBUG_PRINCIPAL_ID } from "./composition.js";
import { createFilePromptCatalog } from "./prompt-catalog.js";

/**
 * 公开产品API合同测试。
 *
 * 使用真实JsonProductStore（临时目录）；Plan发布属于Workflow私有命令（M2），
 * 测试通过Application用例直接播种，公开API只验证Query/Decision语义。
 */

const idCounter = 0;
const now = (): string =>
  new Date(Date.parse("2026-08-07T12:00:00.000Z") + idCounter * 1000).toISOString();

function testPiRuntimeBaseline(agentKey: AgentKey, workspaceRootId?: string) {
  const direct = agentKey === "direct";
  const bootstrap = agentKey === "project_bootstrap";
  const variants = direct
    ? [
        {
          variantKey: "pi_cli_default",
          tools: ["read", "bash", "edit", "write"],
        },
      ]
    : bootstrap
      ? [{ variantKey: "read_only", tools: ["read", "grep", "find", "ls"] }]
      : agentKey === "coding_executor"
        ? [
            { variantKey: "markdown_text_compose", tools: [] },
            {
              variantKey: "workspace_write_shell",
              tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
            },
          ]
        : [];
  if (variants.length === 0) return undefined;
  const baseline = agentRuntimeBaselineDtoSchema.parse({
    kind: "pi_coding_agent",
    title: "Pi Coding Agent",
    packageName: "@earendil-works/pi-coding-agent",
    packageVersion: "0.84.2",
    managedSource: "later-3/pi@codex/later-custom",
    managedSourceRevision: "1".repeat(40),
    compositionStrategy:
      "pi_runtime_then_agent_version_then_workflow_session_run_then_chat_context",
    chatRuntimeAppend: {
      bodyMarkdown: direct || bootstrap ? "Direct Runtime Contract" : "Coding Runtime Contract",
      sha256: "a".repeat(64),
      sourceRelativePath: "packages/pi-runtime/src/coding-agent-runtime-profile.ts",
      appliesToVariantKeys: variants.map((variant) => variant.variantKey),
    },
    variants: variants.map((variant) => ({
      variantKey: variant.variantKey,
      title: variant.variantKey,
      description: `测试能力 ${variant.variantKey}`,
      capabilityCatalogSha256: "2".repeat(64),
      enabledToolNames: variant.tools,
      piSystemPrompt: {
        bodyMarkdown: `You are an expert coding assistant operating inside pi. ${variant.variantKey}`,
        sha256: hashCanonical("test.pi-system.v1", variant),
        dynamicPlaceholders: ["WORKSPACE_ROOT"],
        sourceRelativePaths: ["pi/packages/coding-agent/src/core/system-prompt.ts"],
      },
      tools: variant.tools.map((name) => ({
        name,
        description: `${name} tool`,
        parametersJson: "{}",
        sourceRelativePath: `pi/packages/coding-agent/src/core/tools/${name}.ts`,
      })),
    })),
    finalReviewNote: "最终内容以发送前审核为准。",
  });
  if (agentKey !== "direct" || workspaceRootId !== "root_chat") return baseline;
  return agentRuntimeBaselineDtoSchema.parse({
    ...baseline,
    variants: baseline.variants.map((variant) => ({
      ...variant,
      capabilityCatalogSha256: "3".repeat(64),
      enabledToolNames: [...variant.enabledToolNames, "runtime_probe"],
      tools: [
        ...variant.tools,
        {
          name: "runtime_probe",
          description: "Workspace extension tool",
          parametersJson: "{}",
          sourceRelativePath: "<WORKSPACE_ROOT>/.pi/extensions/runtime-probe.ts",
        },
      ],
    })),
  });
}

async function testApp(): Promise<{ app: ApiApp; deps: ApplicationDeps }> {
  const filePath = join(mkdtempSync(join(tmpdir(), "chat-api-product-")), "store.json");
  const store = await JsonProductStore.open({ filePath, now });
  // 合法ID工厂：不同前缀分别生成
  let n = 0;
  const gen = (prefix: string) => `${prefix}_${(++n).toString(36).padStart(4, "0")}z`;
  const idFactory = {
    session: () => gen("psn"),
    message: () => gen("msg"),
    run: () => gen("run"),
    attempt: () => gen("att"),
    plan: () => gen("pln"),
    planRevision: () => gen("plr"),
    revisionInput: () => gen("rin"),
    approval: () => gen("apr"),
    decision: () => gen("dec"),
    executionContract: () => gen("exc"),
    executionCandidate: () => gen("xcd"),
    validationResult: () => gen("val"),
    artifact: () => gen("art"),
    outbox: () => gen("obx"),
  } as IdFactory;
  const ruleIds = {
    rule: () => gen("rul"),
    revision: () => gen("rrv"),
    tag: () => gen("rtg"),
    scope: () => gen("rsc"),
    decision: () => gen("rde"),
    selection: () => gen("rsl"),
  } as RuleIdFactory;
  const directAgentIds = {
    promptReviewRequest: () => gen("prr"),
    promptReviewDecision: () => gen("prd"),
    candidate: () => gen("drc"),
  } as DirectAgentIdFactory;
  const promptFragmentIds = {
    fragment: () => gen("pfg"),
    revision: () => gen("pfr"),
  } as PromptFragmentIdFactory;
  const promptFiles = new Map<
    string,
    { sourceRelativePath: string; sourceSha256: string; content: never }
  >();
  const projectBootstrapIds = {
    candidate: () => gen("pbc"),
    decision: () => gen("pbd"),
    operation: () => gen("pbo"),
    binding: () => gen("pwb"),
  } as ProjectBootstrapIdFactory;
  const promptCatalog = await createFilePromptCatalog();
  const backend = {
    describe: () => ({
      backendId: "mbk_memmy" as never,
      displayName: "memmy 本地记忆",
      kind: "memmy" as const,
      adapterContractVersion: "memmy-http-query.v1" as const,
      authMode: "bearer" as const,
      credentialRevision: "api-test-key-1",
      configurationFingerprint: "f".repeat(64),
      configured: true,
      capabilities: {
        query: true as const,
        tags: true as const,
        layers: ["L2"] as const,
        maxLimit: 20,
        maxContextBudget: 8192,
      },
    }),
    health: async () => ({ status: "ready" as const }),
    query: async () => ({
      externalQueryId: "search-test-1",
      hitCount: 1,
      tokenEstimate: 12,
      sections: [
        {
          externalObjectIds: ["memory-test-1"],
          title: "测试来源",
          kind: "trace" as const,
          memoryLayer: "L2" as const,
          content: "只用于API合同测试的记忆正文",
          tags: ["api-test"],
          score: 0.9,
          tokenEstimate: 12,
        },
      ],
    }),
    describeImport: () => ({
      descriptor: {
        backendId: "mbk_memmy" as never,
        displayName: "memmy 本地记忆",
        kind: "memmy" as const,
        adapterContractVersion: "memmy-http-import.v1" as const,
        authMode: "bearer" as const,
        credentialRevision: "api-test-key-1" as never,
        configurationFingerprint: "f".repeat(64) as never,
        configured: true,
        capabilities: {
          mode: "explicit_fact" as const,
          layers: ["L2"] as ["L2"],
          title: true as const,
          tags: true as const,
          maxContentChars: 50_000,
        },
      },
    }),
    import: async () => ({
      externalObjectId: "memory-import-api-1",
      responseSha256: "a".repeat(64),
    }),
    reconcile: async () => ({
      status: "outcome_unknown" as const,
      errorCode: "memory.import.test_unknown",
    }),
  };
  const tencentBackend = {
    describeProvider: () => ({
      schemaVersion: "memory-provider-descriptor.v1" as const,
      providerId: "mbk_tencentmemorycore" as never,
      displayName: "Tencent MemoryCore",
      providerKind: "tencent_memorycore",
      transport: "http" as const,
      adapterContractVersion: "tencent-memorycore-http.v2",
      configured: true,
      configurationFingerprint: "e".repeat(64) as never,
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
      credentialRevision: "api-test-memorycore-key-1",
    }),
    describe: () => ({
      backendId: "mbk_tencentmemorycore" as never,
      displayName: "Tencent MemoryCore",
      kind: "tencent_memorycore" as const,
      adapterContractVersion: "tencent-memorycore-http-query.v1" as const,
      authMode: "bearer" as const,
      credentialRevision: "api-test-memorycore-key-1",
      configurationFingerprint: "e".repeat(64),
      configured: true,
      capabilities: {
        query: true as const,
        tags: false as const,
        layers: ["L1"] as const,
        maxLimit: 20,
        maxContextBudget: 8192,
      },
    }),
    health: async () => ({ status: "ready" as const }),
    query: async () => ({
      externalQueryId: "memorycore-search-test-1",
      hitCount: 0,
      tokenEstimate: 0,
      sections: [],
    }),
    queryMemory: async () => ({
      externalQueryId: "memorycore-workflow-query-1",
      hitCount: 0,
      sections: [],
    }),
    writeMemory: async (input: { operationId: string; requestSha256: string }) => ({
      externalObjectId: `chat-import:${input.operationId}`,
      externalStatus: "l0_accepted",
      responseSha256: input.requestSha256,
    }),
    reconcileMemoryWrite: async (input: { operationId: string; requestSha256: string }) => ({
      status: "accepted" as const,
      accepted: {
        externalObjectId: `chat-import:${input.operationId}`,
        externalStatus: "l0_accepted",
        responseSha256: input.requestSha256,
      },
    }),
  };
  const deps: ApplicationDeps = {
    store,
    now,
    ids: idFactory,
    ruleIds,
    directAgentIds,
    promptFragmentIds,
    projectBootstrapIds,
    promptCatalog,
    agentRuntimeProfiles: {
      read: async (agentKey, workspaceRootId) => testPiRuntimeBaseline(agentKey, workspaceRootId),
    },
    promptFiles: {
      publishRevision: async (input) => {
        const sourceRelativePath =
          input.scope.kind === "global"
            ? `.data/prompts/global/${input.regionKey}/${input.promptFragmentId}/${input.promptFragmentRevisionId}.md`
            : `${input.scope.rootId}/.chat/prompts/${input.regionKey}/${input.promptFragmentId}/${input.promptFragmentRevisionId}.md`;
        const projection = {
          sourceRelativePath,
          sourceSha256: hashCanonical("test.prompt-file.v1", input),
          content: structuredClone(input.content) as never,
        };
        const current = promptFiles.get(input.promptFragmentRevisionId);
        if (current !== undefined && JSON.stringify(current) !== JSON.stringify(projection)) {
          throw new Error("测试Prompt文件冲突");
        }
        promptFiles.set(input.promptFragmentRevisionId, projection);
        return projection;
      },
      readRevision: async (input) => {
        const projection = promptFiles.get(input.promptFragmentRevisionId);
        if (projection === undefined) throw new Error("测试Prompt文件不存在");
        return projection;
      },
    },
    projectWorkspaceProvisioner: {
      listRoots: () => [{ rootId: "root_code" as never, displayName: "Code" }],
      preflight: async ({ directoryName }) => ({
        root: { rootId: "root_code" as never, displayName: "Code" },
        directoryName,
        workspaceLabel: `Code/${directoryName}`,
      }),
      provision: async ({ proposal }) => ({
        status: "completed" as const,
        workspaceLabel: `Code/${proposal.directoryName}`,
      }),
      reconcile: async ({ proposal }) => ({
        status: "completed" as const,
        workspaceLabel: `Code/${proposal.directoryName}`,
      }),
    },
    projectManagementBootstrap: {
      describe: () => ({
        providerKind: "plane_ce" as const,
        providerVersion: "1.4.1",
        providerWebBaseUrl: "http://127.0.0.1:8088",
        allowedWorkspaceSlugs: ["learning"],
      }),
      preflight: async ({ projectIdentifier }) => ({
        planeProjectLabel: `learning/${projectIdentifier}`,
      }),
      provision: async () => ({
        status: "completed" as const,
        planeProjectId: "66cf0460-84e0-4d3d-b1ef-d193b83b7562" as never,
      }),
      reconcile: async () => ({
        status: "completed" as const,
        planeProjectId: "66cf0460-84e0-4d3d-b1ef-d193b83b7562" as never,
      }),
    },
    projectRoots: {
      list: () => [
        {
          rootId: "root_chat",
          displayName: "Chat",
          enabledAdapters: [] as const,
        },
      ],
      observe: async () => {
        throw new Error("本API合同测试不读取真实Workspace");
      },
    },
    memoryBackends: {
      list: () => [backend, tencentBackend],
      get: (backendId) => {
        if (backendId === "mbk_memmy") return backend;
        if (backendId === "mbk_tencentmemorycore") return tencentBackend;
        return undefined;
      },
    },
    memoryImportBackends: {
      list: () => [backend],
      get: (backendId) => (backendId === "mbk_memmy" ? backend : undefined),
    },
    workflowMemoryProviders: {
      list: () => [tencentBackend.describeProvider()],
      getQuery: (providerId) =>
        providerId === "mbk_tencentmemorycore" ? tencentBackend : undefined,
      getWrite: (providerId) =>
        providerId === "mbk_tencentmemorycore" ? tencentBackend : undefined,
    },
    executionTraceReader: {
      read: async ({ productRunId, afterSequence }) => ({
        schemaVersion: "chat-execution-trace.v1",
        productRunId,
        items: [],
        nextCursor: afterSequence,
        hasMore: false,
      }),
    },
  };
  const app = createApiApp({
    traceSink: null,
    product: { deps, principalId: DEBUG_PRINCIPAL_ID },
    internalRuntime: { credential: "rtk_test" },
  });
  return { app, deps };
}

const planContent: PlanContent = {
  objective: "整理项目进展并生成Markdown周报",
  summary: "先归纳输入，再产出周报",
  assumptions: [],
  openQuestions: [],
  steps: [
    {
      stepId: "step-1",
      title: "整理进展",
      purpose: "结构化原始输入",
      dependsOn: [],
      inputRefs: [],
      expectedOutput: "要点清单",
      successCriteria: ["覆盖全部输入要点"],
      requestedCapabilities: [],
      risk: "low",
    },
  ],
  completionCriteria: ["周报包含风险与下一步"],
  warnings: [],
};

let cmdCounter = 0;
const nextCmd = (): CommandId => `cmd_${(++cmdCounter).toString(36)}x` as CommandId;

async function postJson(app: ApiApp, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postInternal(app: ApiApp, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-chat-runtime-key": "rtk_test" },
    body: JSON.stringify(body),
  });
}

async function publishPlanForReview(
  deps: ApplicationDeps,
  input: { productRunId: ProductRunId; commandId: CommandId; content: PlanContent },
) {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const planRevision =
    Object.values(snapshot.entities.plans).filter(
      (plan) => plan.productRunId === input.productRunId,
    ).length + 1;
  const planning = await compilePlanningInput(deps, {
    commandId: nextCmd(),
    productRunId: input.productRunId,
    planRevision,
  });
  return publishPlanForReviewUseCase(deps, {
    ...input,
    attemptId: planning.attemptId,
    expectedRunRevision: planning.inputRunRevision,
    inputManifestSha256: planning.inputManifestSha256,
  });
}

describe("公开产品API", () => {
  it("首轮只提交Message，Chat后端原子创建Product Session并派生标题", async () => {
    const { app, deps } = await testApp();
    const commandId = nextCmd();
    const response = await postJson(app, "/api/messages", {
      commandId,
      payload: { text: "  这是\n一个Chat项目  " },
    });
    expect(response.status).toBe(201);
    const started = z
      .object({ session: sessionDtoSchema, message: messageDtoSchema, run: runDtoSchema })
      .strict()
      .parse(await response.json());
    expect(started.session.title).toBe("这是 一个Chat项目");
    expect(started.message.sessionId).toBe(started.session.sessionId);
    expect(started.run.sessionId).toBe(started.session.sessionId);

    const replay = await postJson(app, "/api/messages", {
      commandId,
      payload: { text: "  这是\n一个Chat项目  " },
    });
    expect(replay.status).toBe(201);
    const replayed = z
      .object({ session: sessionDtoSchema, message: messageDtoSchema, run: runDtoSchema })
      .strict()
      .parse(await replay.json());
    expect(replayed.session.sessionId).toBe(started.session.sessionId);
    expect(replayed.message.messageId).toBe(started.message.messageId);
    expect(replayed.run.productRunId).toBe(started.run.productRunId);

    const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    expect(Object.values(snapshot.entities.sessions)).toHaveLength(1);
    expect(Object.values(snapshot.entities.messages)).toHaveLength(1);
    expect(Object.values(snapshot.entities.runs)).toHaveLength(1);
  });

  it("受控建项API从Direct Agent候选经显式确认推进到Plane与Workspace绑定", async () => {
    const { app, deps } = await testApp();
    const configuration = await app.request("/api/project-bootstrap/configuration");
    expect(configuration.status).toBe(200);
    expect(await configuration.json()).toMatchObject({
      enabled: true,
      providerKind: "plane_ce",
      providerVersion: "1.4.1",
      planeWorkspaceSlugs: ["learning"],
      creationRoots: [{ rootId: "root_code", displayName: "Code" }],
    });

    const created = await postJson(app, "/api/sessions", {
      commandId: nextCmd(),
      payload: {},
    });
    const session = sessionDtoSchema.parse(
      ((await created.json()) as { session: unknown }).session,
    );
    const { snapshot: seeded } = await deps.store.read({ kind: "committedSnapshot" });
    const directRevision =
      seeded.entities.workflowDefinitionRevisions[SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID];
    if (directRevision === undefined) throw new Error("缺少Direct Agent系统Definition");
    const sent = await postJson(app, `/api/sessions/${session.sessionId}/messages`, {
      commandId: nextCmd(),
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
    expect(sent.status).toBe(201);
    const submitted = z
      .object({ message: messageDtoSchema, run: runDtoSchema })
      .strict()
      .parse(await sent.json());
    const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    const workflowAttempt = Object.values(snapshot.entities.attempts).find(
      (attempt) =>
        attempt.productRunId === submitted.run.productRunId && attempt.kind === "workflow",
    );
    if (workflowAttempt === undefined) throw new Error("缺少Direct Workflow Attempt");
    await beginDirectAgentAttempt(deps, {
      commandId: nextCmd(),
      productRunId: submitted.run.productRunId,
      workflowAttemptId: workflowAttempt.attemptId,
    });

    const proposal = {
      name: "AI学习",
      objective: "学习公开课程、论文和开源项目，并形成自己的实践项目。",
      planeWorkspaceSlug: "learning",
      planeProjectIdentifier: "AI2026",
      workspaceRootId: "root_code",
      directoryName: "ai-learning",
      initializerProfile: "ai_learning" as const,
      initialModules: ["公开课", "论文", "开源项目", "实践项目"],
    };
    const prepared = await postInternal(app, "/internal/runtime/v1/prepare-project-bootstrap", {
      schemaVersion: "chat-internal-runtime.v1",
      commandId: nextCmd(),
      productRunId: submitted.run.productRunId,
      proposal,
    });
    expect(prepared.status, await prepared.clone().text()).toBe(201);
    const candidate = prepareProjectBootstrapRuntimeResponseSchema.parse(
      await prepared.json(),
    ).candidate;

    const beforeDecision = currentProjectBootstrapResponseSchema.parse(
      await (
        await app.request(`/api/sessions/${session.sessionId}/project-bootstrap/current`)
      ).json(),
    );
    expect(beforeDecision.projectBootstrap).toMatchObject({
      candidate: { status: "prepared", preview: { gitAction: "initialize" } },
    });

    const decided = await postJson(
      app,
      `/api/project-bootstrap/candidates/${candidate.projectBootstrapCandidateId}/decision`,
      {
        commandId: nextCmd(),
        payload: {
          projectBootstrapCandidateId: candidate.projectBootstrapCandidateId,
          candidateRevision: candidate.revision,
          candidateSha256: candidate.sha256,
          kind: "confirm",
        },
      },
    );
    expect(decided.status, await decided.clone().text()).toBe(201);
    const operation = projectBootstrapDecisionResponseSchema.parse(await decided.json()).operation;
    if (operation === undefined) throw new Error("确认后缺少建项Operation");
    const executed = await postJson(
      app,
      `/api/project-bootstrap/operations/${operation.projectBootstrapOperationId}/execute`,
      {
        commandId: nextCmd(),
        payload: { projectBootstrapOperationId: operation.projectBootstrapOperationId },
      },
    );
    expect(executed.status, await executed.clone().text()).toBe(200);
    expect(
      projectBootstrapOperationSchema.parse(
        ((await executed.json()) as { operation: unknown }).operation,
      ),
    ).toMatchObject({ status: "ready", bindingStep: "completed" });

    const ready = currentProjectBootstrapResponseSchema.parse(
      await (
        await app.request(`/api/sessions/${session.sessionId}/project-bootstrap/current`)
      ).json(),
    );
    expect(ready.projectBootstrap).toMatchObject({
      candidate: { status: "ready" },
      operation: { status: "ready" },
      binding: {
        providerKind: "plane_ce",
        planeWorkspaceSlug: "learning",
        planeProjectIdentifier: "AI2026",
        workspaceRootId: "root_code",
        directoryName: "ai-learning",
      },
    });
  });

  it("普通Planning与Memory Planning作为两个独立选项发布，选择Memory后Run绑定独立轨迹", async () => {
    const { app } = await testApp();
    const definitionsResponse = await app.request("/api/workflow/definitions");
    expect(definitionsResponse.status).toBe(200);
    const definitionsEnvelope = z
      .object({ definitions: workflowDefinitionsDtoSchema })
      .strict()
      .parse(await definitionsResponse.json());
    const ordinary = definitionsEnvelope.definitions.definitions.find(
      (definition) =>
        definition.workflowDefinitionRevisionId === SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
    );
    const memory = definitionsEnvelope.definitions.definitions.find(
      (definition) =>
        definition.workflowDefinitionRevisionId === SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID,
    );
    const direct = definitionsEnvelope.definitions.definitions.find(
      (definition) => definition.blueprintKey === "direct",
    );
    expect(
      definitionsEnvelope.definitions.definitions.map((definition) => definition.title),
    ).toEqual(["规划执行工作流", "Memory 增强规划与执行", "执行 Agent（逐次提示词审核）"]);
    expect(ordinary?.nodes.map((node) => node.nodeType)).not.toContain("memory.query");
    expect(ordinary?.nodes.map((node) => node.nodeType)).not.toContain("memory.write");
    expect(memory).toMatchObject({
      title: "Memory 增强规划与执行",
      blueprintKey: "planning",
      ownerKind: "system",
    });
    expect(memory?.nodes.map((node) => node.nodeType)).toEqual(
      expect.arrayContaining(["memory.query", "memory.write"]),
    );
    expect(direct?.nodes).toMatchObject([
      {
        definitionNodeId: "direct.agent",
        displayName: "执行 Agent",
        runConfigFields: [
          {
            name: "agentKey",
            type: "enum_select",
            label: "Agent 模板",
            defaultValue: "direct",
            options: ["direct", "project_bootstrap"],
          },
          {
            name: "agentPromptOverride",
            type: "long_text",
            label: "节点 System Prompt",
            defaultValue: "",
            maximumLength: 65_536,
          },
          {
            name: "capabilityMode",
            type: "enum_select",
            label: "能力模式",
            defaultValue: "pi_cli_default",
            options: ["pi_cli_default", "read_only", "project_bootstrap"],
          },
          {
            name: "promptReviewMode",
            type: "enum_select",
            label: "发送前审核提示词",
            defaultValue: "manual",
            options: ["manual", "off"],
          },
        ],
      },
    ]);
    if (memory === undefined) throw new Error("缺少独立Memory Workflow公开选项");

    const sessionResponse = await postJson(app, "/api/sessions", {
      commandId: nextCmd(),
      payload: {},
    });
    const session = sessionDtoSchema.parse(
      ((await sessionResponse.json()) as { session: unknown }).session,
    );
    const submitResponse = await postJson(app, `/api/sessions/${session.sessionId}/messages`, {
      commandId: nextCmd(),
      payload: {
        text: "使用独立Memory Workflow处理本次请求",
        workflowSelection: {
          kind: "published_revision",
          workflowDefinitionRevisionId: memory.workflowDefinitionRevisionId,
          definitionSha256: memory.definitionSha256,
        },
      },
    });
    expect(submitResponse.status).toBe(201);
    const submitted = z
      .object({ message: messageDtoSchema, run: runDtoSchema })
      .strict()
      .parse(await submitResponse.json());
    const viewResponse = await app.request(`/api/runs/${submitted.run.productRunId}/workflow-view`);
    const view = workflowRunViewDtoSchema.parse(await viewResponse.json());
    expect(view.definitionNodes.map((node) => node.definitionNodeId).slice(0, 2)).toEqual([
      "memory-planning.query",
      "memory-planning.write",
    ]);
  });

  it("Direct Prompt Review公开Query/Decision校验权限、no-store与revision", async () => {
    const { app, deps } = await testApp();
    const created = await postJson(app, "/api/sessions", {
      commandId: nextCmd(),
      payload: {},
    });
    const session = sessionDtoSchema.parse(
      ((await created.json()) as { session: unknown }).session,
    );
    const { snapshot: seeded } = await deps.store.read({ kind: "committedSnapshot" });
    const directRevision =
      seeded.entities.workflowDefinitionRevisions[SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID];
    if (directRevision === undefined) throw new Error("缺少Direct Agent系统Definition");
    const sent = await postJson(app, `/api/sessions/${session.sessionId}/messages`, {
      commandId: nextCmd(),
      payload: {
        text: "只读检查项目并报告结论",
        workflowSelection: {
          kind: "published_revision",
          workflowDefinitionRevisionId: directRevision.workflowDefinitionRevisionId,
          definitionSha256: directRevision.definitionSha256,
        },
      },
    });
    expect(sent.status).toBe(201);
    const submitted = z
      .object({ message: messageDtoSchema, run: runDtoSchema })
      .strict()
      .parse(await sent.json());
    expect(submitted.run).toMatchObject({ status: "pending", phase: "queued" });

    const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    expect(snapshot.entities.runs[submitted.run.productRunId]?.runKind).toBe("direct_agent");
    const assembly = Object.values(snapshot.entities.promptAssemblies).find(
      (candidate) => candidate.productRunId === submitted.run.productRunId,
    );
    expect(assembly?.schemaVersion).toBe("prompt-assembly.v2");
    if (assembly?.schemaVersion !== "prompt-assembly.v2") {
      throw new Error("Direct新Run必须冻结Prompt Assembly V2");
    }
    expect(assembly.regions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ regionKey: "agent_identity", mode: "default" }),
      ]),
    );
    expect(assembly.messages.at(-1)?.text).toBe("只读检查项目并报告结论");
    const workflowAttempt = Object.values(snapshot.entities.attempts).find(
      (attempt) =>
        attempt.productRunId === submitted.run.productRunId && attempt.kind === "workflow",
    );
    if (workflowAttempt === undefined) throw new Error("缺少Direct Workflow Attempt");
    const begun = await beginDirectAgentAttempt(deps, {
      commandId: nextCmd(),
      productRunId: submitted.run.productRunId,
      workflowAttemptId: workflowAttempt.attemptId,
    });
    const directRun = snapshot.entities.runs[submitted.run.productRunId];
    if (directRun?.workflowRunSpecId === undefined) {
      throw new Error("Direct Run缺少Workflow RunSpec");
    }
    const workflowRunSpecId = directRun.workflowRunSpecId;
    await transitionConfigurablePlanningNode(deps, {
      commandId: nextCmd(),
      productRunId: submitted.run.productRunId,
      workflowRunSpecId,
      definitionNodeId: "direct.agent",
      executionPath: [],
      attemptNumber: 1,
      toStatus: "running",
      publicSummary: "正在推进直接Agent，等待下一处Provider边界",
    });
    const canonicalPayloadJson = canonicalJsonStringify({
      messages: [
        { content: "只读检查项目并报告结论", role: "user" },
        {
          content: "",
          role: "assistant",
          tool_calls: [{ id: "tool_1", type: "function" }],
        },
      ],
      model: "qwen3.7-plus",
    });
    const published = await publishPromptReviewRequest(deps, {
      commandId: nextCmd(),
      productRunId: submitted.run.productRunId,
      directAgentAttemptId: begun.directAgentAttemptId,
      expectedRunRevision: begun.runRevision,
      requestIndex: 1,
      requestKind: "agent_turn",
      providerId: "dashscope-coding",
      modelId: "qwen3.7-plus",
      endpointHost: "dashscope.aliyuncs.com",
      canonicalPayloadJson,
      payloadSha256: computePromptReviewPayloadSha256(canonicalPayloadJson),
    });
    await transitionConfigurablePlanningNode(deps, {
      commandId: nextCmd(),
      productRunId: submitted.run.productRunId,
      workflowRunSpecId,
      definitionNodeId: "direct.agent",
      executionPath: [],
      attemptNumber: 1,
      toStatus: "waiting_human",
      publicSummary: "等待审核第1次Provider完整提示词",
    });

    const current = await app.request(
      `/api/runs/${submitted.run.productRunId}/prompt-reviews/current`,
    );
    expect(current.status).toBe(200);
    expect(current.headers.get("cache-control")).toBe("private, no-store");
    const currentBody = currentPromptReviewResponseSchema.parse(await current.json());
    expect(currentBody.promptReview?.canonicalPayloadJson).toBe(canonicalPayloadJson);
    expect(currentBody.promptReview?.readablePrompt).toContain("tool_calls");
    expect(currentBody.promptReview?.allowedActions).toEqual(["approve", "reject"]);
    const queryRejected = await app.request(
      `/api/runs/${submitted.run.productRunId}/prompt-reviews/current?include=runtime`,
    );
    expect(queryRejected.status).toBe(400);

    const otherPrincipalApp = createApiApp({
      traceSink: null,
      product: { deps, principalId: "usr_other" as never },
      internalRuntime: { credential: "rtk_test" },
    });
    const unauthorizedRead = await otherPrincipalApp.request(
      `/api/runs/${submitted.run.productRunId}/prompt-reviews/current`,
    );
    expect(unauthorizedRead.status).toBe(403);

    const decisionPath = `/api/runs/${submitted.run.productRunId}/prompt-review-decisions`;
    const decisionPayload = {
      promptReviewRequestId: published.promptReview.promptReviewRequestId,
      requestRevision: published.promptReview.requestRevision,
      reviewSha256: published.promptReview.reviewSha256,
      payloadSha256: published.promptReview.payloadSha256,
      kind: "approve" as const,
    };
    const missingRevision = await postJson(app, decisionPath, {
      commandId: nextCmd(),
      payload: decisionPayload,
    });
    expect(missingRevision.status).toBe(400);
    const unauthorizedDecision = await postJson(otherPrincipalApp, decisionPath, {
      commandId: nextCmd(),
      expectedRevision: published.runRevision,
      payload: decisionPayload,
    });
    expect(unauthorizedDecision.status).toBe(403);

    const decisionCommandId = nextCmd();
    const approved = await postJson(app, decisionPath, {
      commandId: decisionCommandId,
      expectedRevision: published.runRevision,
      payload: decisionPayload,
    });
    expect(approved.status).toBe(201);
    const approvedBody = z
      .object({ decision: promptReviewDecisionDtoSchema, run: runDtoSchema })
      .strict()
      .parse(await approved.json());
    expect(approvedBody.decision.kind).toBe("approve");
    expect(approvedBody.run).toMatchObject({ status: "running", phase: "executing" });
    const replay = await postJson(app, decisionPath, {
      commandId: decisionCommandId,
      expectedRevision: published.runRevision,
      payload: decisionPayload,
    });
    expect(replay.status).toBe(201);
    expect(
      z
        .object({ decision: promptReviewDecisionDtoSchema, run: runDtoSchema })
        .strict()
        .parse(await replay.json()).decision.promptReviewDecisionId,
    ).toBe(approvedBody.decision.promptReviewDecisionId);
    const stale = await postJson(app, decisionPath, {
      commandId: nextCmd(),
      expectedRevision: published.runRevision,
      payload: decisionPayload,
    });
    expect(stale.status).toBe(409);
    const noCurrent = currentPromptReviewResponseSchema.parse(
      await (
        await app.request(`/api/runs/${submitted.run.productRunId}/prompt-reviews/current`)
      ).json(),
    );
    expect(noCurrent.promptReview).toBeNull();
  });

  it("完整链路：建Session -> 发消息 -> 查消息/运行 -> 决定", async () => {
    const { app, deps } = await testApp();

    const created = await postJson(app, "/api/sessions", { commandId: nextCmd(), payload: {} });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: unknown };
    const sessionDto = sessionDtoSchema.parse(session);

    const commandId = nextCmd();
    const sent = await postJson(app, `/api/sessions/${sessionDto.sessionId}/messages`, {
      commandId,
      payload: { text: "根据我输入的项目进展生成周报" },
    });
    expect(sent.status).toBe(201);
    const sentBody = (await sent.json()) as { message: unknown; run: unknown };
    const message = messageDtoSchema.parse(sentBody.message);
    const run = runDtoSchema.parse(sentBody.run);
    expect(message.role).toBe("user");
    expect(run.status).toBe("pending");
    expect(run.phase).toBe("queued");

    // 相同commandId重试：不新增Message/Run
    const retried = await postJson(app, `/api/sessions/${sessionDto.sessionId}/messages`, {
      commandId,
      payload: { text: "根据我输入的项目进展生成周报" },
    });
    expect(retried.status).toBe(201);
    const retriedBody = (await retried.json()) as {
      message: { messageId: string };
      run: { productRunId: string };
    };
    expect(retriedBody.message.messageId).toBe(message.messageId);
    expect(retriedBody.run.productRunId).toBe(run.productRunId);

    // 相同commandId不同payload：409 COMMAND_ID_REUSED
    const conflict = await postJson(app, `/api/sessions/${sessionDto.sessionId}/messages`, {
      commandId,
      payload: { text: "不同内容" },
    });
    expect(conflict.status).toBe(409);
    expect(problemDetailSchema.parse(await conflict.json()).code).toBe("command_id_reused");

    // 消息列表：服务端cursor分页
    const messages = await app.request(`/api/sessions/${sessionDto.sessionId}/messages`);
    expect(messages.status).toBe(200);
    const page = cursorPageSchema(messageDtoSchema).parse(await messages.json());
    expect(page.items).toHaveLength(1);

    const exactMessage = await app.request(
      `/api/sessions/${sessionDto.sessionId}/messages/${message.messageId}`,
    );
    expect(exactMessage.status).toBe(200);
    expect(messageResponseSchema.parse(await exactMessage.json()).message).toEqual(message);
    const exactWithQuery = await app.request(
      `/api/sessions/${sessionDto.sessionId}/messages/${message.messageId}?include=runtime`,
    );
    expect(exactWithQuery.status).toBe(400);
    const missingMessage = await app.request(
      `/api/sessions/${sessionDto.sessionId}/messages/msg_missing`,
    );
    expect(missingMessage.status).toBe(404);

    const otherCreated = await postJson(app, "/api/sessions", {
      commandId: nextCmd(),
      payload: {},
    });
    const otherSession = sessionDtoSchema.parse(
      ((await otherCreated.json()) as { session: unknown }).session,
    );
    const wrongSession = await app.request(
      `/api/sessions/${otherSession.sessionId}/messages/${message.messageId}`,
    );
    expect(wrongSession.status).toBe(404);

    for (const query of [
      "limit=1junk",
      "limit=1.5",
      "limit=%201",
      "limit=1&limit=2",
      "cursor=",
      "unknown=1",
    ]) {
      const invalidPage = await app.request(
        `/api/sessions/${sessionDto.sessionId}/messages?${query}`,
      );
      expect(invalidPage.status, query).toBe(400);
      expect(problemDetailSchema.parse(await invalidPage.json()).code).toBe("validation_failed");
    }

    // 播种Plan v1（私有命令路径，M2由Workflow调用）
    const published = await publishPlanForReview(deps, {
      productRunId: run.productRunId,
      commandId: nextCmd(),
      content: planContent,
    });

    const runRes = await app.request(`/api/runs/${run.productRunId}`);
    const runDetail = runDtoSchema.parse(((await runRes.json()) as { run: unknown }).run);
    expect(runDetail.status).toBe("waiting_human");
    expect(runDetail.phase).toBe("plan_review");
    expect(runDetail.allowedActions).toEqual(["request_revision", "approve", "reject"]);
    expect(runDetail.currentPlan?.planRevision).toBe(1);

    const traceRes = await app.request(
      `/api/runs/${run.productRunId}/execution-trace?afterSequence=0&limit=100`,
    );
    expect(traceRes.status).toBe(200);
    expect(await traceRes.json()).toEqual({
      schemaVersion: "chat-execution-trace.v1",
      productRunId: run.productRunId,
      items: [],
      nextCursor: 0,
      hasMore: false,
    });
    for (const query of ["afterSequence=-1", "limit=0", "limit=101", "unknown=1"]) {
      const invalidTrace = await app.request(
        `/api/runs/${run.productRunId}/execution-trace?${query}`,
      );
      expect(invalidTrace.status, query).toBe(400);
    }

    const plansRes = await app.request(`/api/runs/${run.productRunId}/plans`);
    const plans = z.object({ items: z.array(planDtoSchema) }).parse(await plansRes.json());
    expect(plans.items).toHaveLength(1);

    const approvalRes = await app.request(`/api/runs/${run.productRunId}/approvals/current`);
    const approvalBody = z
      .object({ approval: approvalDtoSchema.nullable() })
      .parse(await approvalRes.json());
    expect(approvalBody.approval?.status).toBe("open");

    const workflowViewResponse = await app.request(`/api/runs/${run.productRunId}/workflow-view`);
    expect(workflowViewResponse.status).toBe(200);
    const workflowEtag = workflowViewResponse.headers.get("etag");
    expect(workflowEtag).toMatch(/^"[a-f0-9]{64}"$/u);
    const workflowView = workflowRunViewDtoSchema.parse(await workflowViewResponse.json());
    expect(workflowView.definitionNodes.map((node) => node.definitionNodeId)).toEqual([
      "planning.plan",
      "planning.review",
      "planning.execute",
      "planning.validate",
      "planning.commit",
    ]);
    const reviewNode = workflowView.nodeRuns.find(
      (node) => node.nodeType === "human.plan_review" && node.status === "waiting_human",
    );
    expect(reviewNode?.allowedActions).toEqual(["inspect", "submit_decision"]);
    const notModified = await app.request(`/api/runs/${run.productRunId}/workflow-view`, {
      headers: { "if-none-match": workflowEtag ?? "" },
    });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");

    const otherPrincipalApp = createApiApp({
      traceSink: null,
      product: { deps, principalId: "usr_other" as never },
      internalRuntime: { credential: "rtk_test" },
    });
    const unauthorizedView = await otherPrincipalApp.request(
      `/api/runs/${run.productRunId}/workflow-view`,
    );
    expect(unauthorizedView.status).toBe(404);
    expect(problemDetailSchema.parse(await unauthorizedView.json()).code).toBe("not_found");

    if (reviewNode === undefined) throw new Error("缺少等待审核Node Run");
    const detailResponse = await app.request(
      `/api/runs/${run.productRunId}/workflow-nodes/${reviewNode.workflowNodeRunId}`,
    );
    const detail = workflowNodeDetailDtoSchema.parse(await detailResponse.json());
    expect(detail.node.status).toBe("waiting_human");
    expect(detail.input?.slots.flatMap((slot) => slot.refs).map((ref) => ref.kind)).toContain(
      "approval_request",
    );
    expect(detail.timeline?.at(-1)?.toStatus).toBe("waiting_human");
    expect(JSON.stringify(detail)).not.toMatch(/hook|token|provider|prompt|pi[_-]?session/iu);
    const unauthorizedDetail = await otherPrincipalApp.request(
      `/api/runs/${run.productRunId}/workflow-nodes/${reviewNode.workflowNodeRunId}`,
    );
    expect(unauthorizedDetail.status).toBe(404);
    const summaryOnlyResponse = await app.request(
      `/api/runs/${run.productRunId}/workflow-nodes/${reviewNode.workflowNodeRunId}?include=summary`,
    );
    const summaryOnly = workflowNodeDetailDtoSchema.parse(await summaryOnlyResponse.json());
    expect(summaryOnly.timeline).toBeUndefined();
    expect(summaryOnly.input).toBeUndefined();
    const invalidInclude = await app.request(
      `/api/runs/${run.productRunId}/workflow-nodes/${reviewNode.workflowNodeRunId}?include=runtime`,
    );
    expect(invalidInclude.status).toBe(400);

    // 缺少expectedRevision：400
    const missingRevision = await postJson(app, `/api/runs/${run.productRunId}/decisions`, {
      commandId: nextCmd(),
      payload: {
        approvalRequestId: published.approval.approvalRequestId,
        planId: published.plan.planId,
        planRevision: 1,
        planSha256: published.plan.sha256,
        kind: "approve",
      },
    });
    expect(missingRevision.status).toBe(400);
    expect(problemDetailSchema.parse(await missingRevision.json()).code).toBe("validation_failed");

    // 正常approve：201 + running/executing
    const decided = await postJson(app, `/api/runs/${run.productRunId}/decisions`, {
      commandId: nextCmd(),
      expectedRevision: runDetail.revision,
      payload: {
        approvalRequestId: published.approval.approvalRequestId,
        planId: published.plan.planId,
        planRevision: 1,
        planSha256: published.plan.sha256,
        kind: "approve",
      },
    });
    expect(decided.status, await decided.clone().text()).toBe(201);
    const decidedBody = (await decided.json()) as { decision: unknown; run: unknown };
    decisionDtoSchema.parse(decidedBody.decision);
    const decidedRun = runDtoSchema.parse(decidedBody.run);
    expect(decidedRun.status).toBe("running");
    expect(decidedRun.phase).toBe("executing");

    const workflowAfterDecisionResponse = await app.request(
      `/api/runs/${run.productRunId}/workflow-view`,
    );
    expect(workflowAfterDecisionResponse.headers.get("etag")).not.toBe(workflowEtag);
    const workflowAfterDecision = workflowRunViewDtoSchema.parse(
      await workflowAfterDecisionResponse.json(),
    );
    expect(
      workflowAfterDecision.nodeRuns.find(
        (node) => node.workflowNodeRunId === reviewNode.workflowNodeRunId,
      ),
    ).toMatchObject({ status: "succeeded", outcomeCode: "approve" });

    // 旧Approval重复决定：409 APPROVAL_ALREADY_DECIDED
    const duplicated = await postJson(app, `/api/runs/${run.productRunId}/decisions`, {
      commandId: nextCmd(),
      expectedRevision: decidedRun.revision,
      payload: {
        approvalRequestId: published.approval.approvalRequestId,
        planId: published.plan.planId,
        planRevision: 1,
        planSha256: published.plan.sha256,
        kind: "approve",
      },
    });
    expect(duplicated.status).toBe(409);
    expect(problemDetailSchema.parse(await duplicated.json()).code).toBe(
      "approval_already_decided",
    );
  });

  it("浏览器指定Provider/模型被validation_failed拒绝", async () => {
    const { app } = await testApp();
    const created = await postJson(app, "/api/sessions", { commandId: nextCmd(), payload: {} });
    const { session } = (await created.json()) as { session: { sessionId: string } };
    const res = await postJson(app, `/api/sessions/${session.sessionId}/messages`, {
      commandId: nextCmd(),
      payload: { text: "hi", provider: "bailian", model: "qwen3.7-plus" },
    });
    expect(res.status).toBe(400);
    expect(problemDetailSchema.parse(await res.json()).code).toBe("validation_failed");
  });

  it("显式导入Message原子创建Intent/Result/Outbox，并按command与语义双重幂等", async () => {
    const { app, deps } = await testApp();
    const created = await postJson(app, "/api/sessions", {
      commandId: nextCmd(),
      payload: {},
    });
    const { session } = (await created.json()) as { session: { sessionId: string } };
    const sent = await postJson(app, `/api/sessions/${session.sessionId}/messages`, {
      commandId: nextCmd(),
      payload: { text: "M2 canary：发布前必须完成真实浏览器验收。" },
    });
    const message = messageDtoSchema.parse(((await sent.json()) as { message: unknown }).message);
    expect(message.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const payload = {
      sourceSelection: {
        kind: "full_message" as const,
        sourceMessageId: message.messageId,
        sourceMessageSha256: message.sha256!,
      },
      backendId: "mbk_memmy",
      title: " M2 验收规则 ",
      tags: ["Release", "m2", "release"],
    };
    const commandId = nextCmd();
    const imported = await postJson(app, "/api/memory-imports", { commandId, payload });
    expect(imported.status, await imported.clone().text()).toBe(201);
    const first = memoryImportDtoSchema.parse(
      ((await imported.json()) as { memoryImport: unknown }).memoryImport,
    );
    expect(first).toMatchObject({
      status: "queued",
      sourceMessageId: message.messageId,
      title: "M2 验收规则",
      tags: ["m2", "release"],
      allowedActions: [],
    });

    const replayed = await postJson(app, "/api/memory-imports", { commandId, payload });
    expect(
      memoryImportDtoSchema.parse(
        ((await replayed.json()) as { memoryImport: unknown }).memoryImport,
      ).memoryImportIntentId,
    ).toBe(first.memoryImportIntentId);
    const semanticDuplicate = await postJson(app, "/api/memory-imports", {
      commandId: nextCmd(),
      payload,
    });
    expect(
      memoryImportDtoSchema.parse(
        ((await semanticDuplicate.json()) as { memoryImport: unknown }).memoryImport,
      ).memoryImportIntentId,
    ).toBe(first.memoryImportIntentId);

    const listed = await app.request(`/api/sessions/${session.sessionId}/memory-imports`);
    const listedBody = (await listed.json()) as { memoryImports: unknown[] };
    expect(listedBody.memoryImports).toHaveLength(1);
    expect(JSON.stringify(listedBody)).not.toContain("api-test-key-1");
    expect(JSON.stringify(listedBody)).not.toContain("configurationFingerprint");

    const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
    const intent = snapshot.entities.memoryImportIntents[first.memoryImportIntentId];
    if (intent === undefined) throw new Error("缺少Memory Import Intent");
    expect(Object.keys(snapshot.entities.memoryImportIntents)).toHaveLength(1);
    expect(Object.keys(snapshot.entities.memoryImportResults)).toHaveLength(1);
    expect(
      Object.values(snapshot.outbox).filter((entry) => entry.kind === "memory_import_start"),
    ).toHaveLength(1);

    const wrongIdentity = await postInternal(
      app,
      "/internal/runtime/v1/memory-import/mark-dispatching",
      {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
        commandId: nextCmd(),
        memoryImportIntentId: "mii_wrongidentity1",
        memoryImportResultId: first.memoryImportResultId,
        requestSha256: intent.requestSha256,
        expectedRevision: 1,
      },
    );
    expect(wrongIdentity.status).toBe(409);

    const mark = await postInternal(app, "/internal/runtime/v1/memory-import/mark-dispatching", {
      schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
      workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
      commandId: nextCmd(),
      memoryImportIntentId: first.memoryImportIntentId,
      memoryImportResultId: first.memoryImportResultId,
      requestSha256: intent.requestSha256,
      expectedRevision: 1,
    });
    const dispatching = memoryImportResultResponseSchema.parse(await mark.json()).result;
    expect(dispatching).toMatchObject({ status: "dispatching", revision: 2, dispatchAttempts: 1 });

    const acceptedResponse = await postInternal(
      app,
      "/internal/runtime/v1/memory-import/commit-accepted",
      {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
        commandId: nextCmd(),
        memoryImportIntentId: first.memoryImportIntentId,
        memoryImportResultId: first.memoryImportResultId,
        requestSha256: intent.requestSha256,
        expectedRevision: dispatching.revision,
        accepted: {
          externalObjectId: "memory-api-1",
          externalStatus: "activated",
          responseSha256: "b".repeat(64),
        },
      },
    );
    const acceptedResult = memoryImportResultResponseSchema.parse(
      await acceptedResponse.json(),
    ).result;
    expect(acceptedResult).toMatchObject({ status: "accepted", revision: 3 });
    expect("dispatchStartedAt" in acceptedResult).toBe(false);

    const overwriteAcceptedIdentity = await postInternal(
      app,
      "/internal/runtime/v1/memory-import/commit-materialized",
      {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
        commandId: nextCmd(),
        memoryImportIntentId: first.memoryImportIntentId,
        memoryImportResultId: first.memoryImportResultId,
        requestSha256: intent.requestSha256,
        expectedRevision: acceptedResult.revision,
        accepted: {
          externalObjectId: "memory-api-overwrite",
          externalStatus: "activated",
          responseSha256: "b".repeat(64),
        },
        verificationKind: "read_by_id_and_search",
        verificationSha256: "c".repeat(64),
      },
    );
    expect(overwriteAcceptedIdentity.status).toBe(409);

    const firstReconcile = await postJson(
      app,
      `/api/memory-imports/${first.memoryImportIntentId}/reconcile`,
      {
        commandId: nextCmd(),
        expectedRevision: acceptedResult.revision,
        payload: {},
      },
    );
    expect(firstReconcile.status).toBe(202);
    let afterReconcile = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const reconcileOutbox = Object.values(afterReconcile.outbox).find(
      (entry) => entry.kind === "memory_import_reconcile",
    );
    expect(reconcileOutbox).toBeDefined();
    await updateOutboxStatus(deps, {
      commandId: nextCmd(),
      outboxId: reconcileOutbox!.outboxId,
      status: "acknowledged",
      incrementDispatchAttempts: true,
    });
    const duplicateReconcile = await postJson(
      app,
      `/api/memory-imports/${first.memoryImportIntentId}/reconcile`,
      {
        commandId: nextCmd(),
        expectedRevision: acceptedResult.revision,
        payload: {},
      },
    );
    expect(duplicateReconcile.status).toBe(202);
    afterReconcile = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(
      Object.values(afterReconcile.outbox).filter(
        (entry) => entry.kind === "memory_import_reconcile",
      ),
    ).toHaveLength(1);

    const materializedResponse = await postInternal(
      app,
      "/internal/runtime/v1/memory-import/commit-materialized",
      {
        schemaVersion: INTERNAL_RUNTIME_SCHEMA_VERSION,
        workflowDefinitionVersion: MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION,
        commandId: nextCmd(),
        memoryImportIntentId: first.memoryImportIntentId,
        memoryImportResultId: first.memoryImportResultId,
        requestSha256: intent.requestSha256,
        expectedRevision: acceptedResult.revision,
        accepted: {
          externalObjectId: "memory-api-1",
          externalStatus: "activated",
          responseSha256: "b".repeat(64),
        },
        verificationKind: "read_by_id_and_search",
        verificationSha256: "c".repeat(64),
        reconciled: true,
      },
    );
    const materializedResult = memoryImportResultResponseSchema.parse(
      await materializedResponse.json(),
    ).result;
    expect(materializedResult).toMatchObject({
      status: "materialized",
      revision: 4,
      reconcileAttempts: 1,
    });
  });

  it("Workflow Memory公开面只暴露Provider能力与显式Write事实，不泄漏服务配置", async () => {
    const { app, deps } = await testApp();
    const providersResponse = await app.request("/api/memory/providers");
    expect(providersResponse.status).toBe(200);
    const providers = listMemoryProvidersResponseSchema.parse(await providersResponse.json());
    expect(providers.providers).toHaveLength(1);
    expect(providers.providers[0]).toMatchObject({
      providerId: "mbk_tencentmemorycore",
      providerKind: "tencent_memorycore",
      transport: "http",
      configured: true,
      capabilities: { query: { maxResults: 20 }, write: { materialization: "asynchronous" } },
    });
    expect(JSON.stringify(providers)).not.toMatch(/token|serviceId|teamId|baseUrl|L0|L1/u);
    expect((await app.request("/api/memory/providers?debug=1")).status).toBe(400);

    const created = await postJson(app, "/api/sessions", {
      commandId: nextCmd(),
      payload: {},
    });
    const session = sessionDtoSchema.parse(
      ((await created.json()) as { session: unknown }).session,
    );
    const sent = await postJson(app, `/api/sessions/${session.sessionId}/messages`, {
      commandId: nextCmd(),
      payload: { text: "发布前必须完成真实端到端测试。" },
    });
    const message = messageDtoSchema.parse(((await sent.json()) as { message: unknown }).message);
    const beforeWrite = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const currentSession = beforeWrite.entities.sessions[session.sessionId];
    if (currentSession === undefined) throw new Error("测试Session不存在");
    const payload = {
      productSessionId: session.sessionId,
      providerId: "mbk_tencentmemorycore",
      sourceSelection: {
        kind: "full_message",
        sourceMessageId: message.messageId,
        sourceMessageSha256: message.sha256,
      },
      expectedSessionRevision: currentSession.revision,
    };
    const writeResponse = await postJson(app, "/api/memory-writes", {
      commandId: nextCmd(),
      payload,
    });
    expect(writeResponse.status, await writeResponse.clone().text()).toBe(201);
    const createdWrite = memoryWriteResponseSchema.parse(await writeResponse.json()).memoryWrite;
    expect(createdWrite).toMatchObject({
      productSessionId: session.sessionId,
      providerId: "mbk_tencentmemorycore",
      result: { status: "queued", revision: 1 },
      canReconcile: false,
    });
    expect(JSON.stringify(createdWrite)).not.toContain("发布前必须完成");

    const exact = memoryWriteResponseSchema.parse(
      await (await app.request(`/api/memory-writes/${createdWrite.memoryWriteIntentId}`)).json(),
    );
    expect(exact.memoryWrite.memoryWriteIntentId).toBe(createdWrite.memoryWriteIntentId);
    const listed = listMemoryWritesResponseSchema.parse(
      await (await app.request(`/api/sessions/${session.sessionId}/memory-writes`)).json(),
    );
    expect(listed.memoryWrites.map((item) => item.memoryWriteIntentId)).toEqual([
      createdWrite.memoryWriteIntentId,
    ]);

    const snapshot = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const intent = snapshot.entities.memoryWriteIntents[createdWrite.memoryWriteIntentId];
    if (intent === undefined) throw new Error("Memory Write Intent不存在");
    const dispatching = await markMemoryWriteDispatching(deps, {
      commandId: nextCmd(),
      memoryWriteIntentId: intent.memoryWriteIntentId,
      memoryWriteResultId: createdWrite.memoryWriteResultId,
      requestSha256: intent.requestSha256,
      expectedRevision: createdWrite.result.revision,
    });
    const reconcile = await postJson(
      app,
      `/api/memory-writes/${createdWrite.memoryWriteIntentId}/reconcile`,
      {
        commandId: nextCmd(),
        payload: { expectedResultRevision: dispatching.revision },
      },
    );
    expect(reconcile.status).toBe(202);
    expect(memoryWriteResponseSchema.parse(await reconcile.json()).memoryWrite.canReconcile).toBe(
      false,
    );
    const after = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(
      Object.values(after.outbox).filter((entry) => entry.kind === "memory_write_start"),
    ).toHaveLength(1);
    expect(
      Object.values(after.outbox).filter((entry) => entry.kind === "memory_write_reconcile"),
    ).toHaveLength(1);
  });

  it("浏览器不能向Memory Import注入layer、endpoint、operationId、状态或凭据", async () => {
    const { app } = await testApp();
    const response = await postJson(app, "/api/memory-imports", {
      commandId: nextCmd(),
      payload: {
        sourceSelection: {
          kind: "full_message",
          sourceMessageId: "msg_injected",
          sourceMessageSha256: "a".repeat(64),
        },
        backendId: "mbk_memmy",
        title: "非法注入",
        tags: [],
        layer: "L3",
        endpoint: "https://attacker.invalid",
        operationId: "mii_attacker",
        status: "materialized",
        token: "never-accept",
      },
    });
    expect(response.status).toBe(400);
    expect(problemDetailSchema.parse(await response.json()).code).toBe("validation_failed");
  });

  it("Project推进入口拒绝浏览器指定Provider、模型和Workflow私有身份", async () => {
    const { app } = await testApp();
    const response = await postJson(app, "/api/project-advancements", {
      commandId: nextCmd(),
      payload: {
        sessionId: "psn_injected",
        projectId: "prj_injected",
        text: "推进项目",
        provider: "bailian",
        model: "qwen3.7-plus",
        workflowRunId: "wfr_private",
        hookToken: "secret",
      },
    });
    expect(response.status).toBe(400);
    expect(problemDetailSchema.parse(await response.json()).code).toBe("validation_failed");
  });

  it("安全列出Memory后端并恢复Run Context来源，不暴露服务配置", async () => {
    const { app, deps } = await testApp();
    const backendsResponse = await app.request("/api/memory-backends");
    expect(backendsResponse.status).toBe(200);
    const backendBody = z
      .object({ backends: z.array(memoryBackendProfileDtoSchema) })
      .parse(await backendsResponse.json());
    expect(backendBody.backends[0]?.backendId).toBe("mbk_memmy");
    expect(backendBody.backends[1]).toMatchObject({
      backendId: "mbk_tencentmemorycore",
      kind: "tencent_memorycore",
      capabilities: { tags: false, layers: ["L1"] },
    });
    expect(JSON.stringify(backendBody)).not.toContain("baseUrl");
    expect(JSON.stringify(backendBody)).not.toContain("token");
    expect(JSON.stringify(backendBody)).not.toContain("authMode");
    expect(JSON.stringify(backendBody)).not.toContain("api-test-key-1");

    const created = await postJson(app, "/api/sessions", {
      commandId: nextCmd(),
      payload: {},
    });
    const { session } = (await created.json()) as { session: { sessionId: string } };
    const sent = await postJson(app, `/api/sessions/${session.sessionId}/messages`, {
      commandId: nextCmd(),
      payload: {
        text: "使用测试记忆规划",
        context: {
          memory: {
            backendId: "mbk_memmy",
            requirement: "required",
            tags: ["api-test"],
            layers: ["L2"],
            limit: 3,
            contextBudget: 512,
          },
        },
      },
    });
    expect(sent.status).toBe(201);
    const { run } = (await sent.json()) as { run: { productRunId: ProductRunId } };
    const snapshot = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const workflowAttempt = Object.values(snapshot.entities.attempts).find(
      (attempt) => attempt.productRunId === run.productRunId && attempt.kind === "workflow",
    );
    expect(workflowAttempt).toBeDefined();
    if (workflowAttempt === undefined) throw new Error("缺少Workflow Attempt");
    const beginResponse = await postInternal(app, "/internal/runtime/v1/begin-planning-context", {
      schemaVersion: "chat-internal-runtime.v1",
      commandId: nextCmd(),
      productRunId: run.productRunId,
      attemptId: workflowAttempt.attemptId,
      planRevision: 1,
    });
    expect(beginResponse.status).toBe(200);
    const begun = beginPlanningContextResponseSchema.parse(await beginResponse.json());
    // begin只冻结派发意图；若Router直接调用外部Memory，这里会错误地返回ready。
    if (begun.status !== "dispatch_required") throw new Error("缺少Memory查询派发");
    const backend = deps.memoryBackends?.get(begun.query.backendId);
    if (backend === undefined) throw new Error("缺少Memory测试后端");
    const output = await backend.query({
      operationId: begun.query.memoryQueryId,
      productRunId: begun.query.productRunId,
      productSessionId: begun.query.productSessionId,
      query: begun.query.queryText,
      tags: begun.query.tags,
      layers: begun.query.layers,
      limit: begun.query.limit,
      contextBudget: begun.query.contextBudget,
    });
    const persistResponse = await postInternal(
      app,
      "/internal/runtime/v1/persist-planning-context-result",
      {
        schemaVersion: "chat-internal-runtime.v1",
        commandId: nextCmd(),
        productRunId: run.productRunId,
        attemptId: workflowAttempt.attemptId,
        memoryQueryId: begun.query.memoryQueryId,
        result: normalizeMemoryQueryResult(begun.query, output),
      },
    );
    const persistBody: unknown = await persistResponse.clone().json();
    expect(persistResponse.status, JSON.stringify(persistBody)).toBe(200);
    expect(preparePlanningContextResponseSchema.parse(await persistResponse.json()).status).toBe(
      "ready",
    );

    const contextResponse = await app.request(`/api/runs/${run.productRunId}/context`);
    expect(contextResponse.status).toBe(200);
    const context = runContextDtoSchema.parse(
      ((await contextResponse.json()) as { context: unknown }).context,
    );
    expect(context.memory?.queryStatus).toBe("completed");
    expect(context.contextPackage?.sources).toHaveLength(1);
    expect(context.contextPackage?.sources[0]?.title).toBe("测试来源");
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("只用于API合同测试的记忆正文");
    expect(serialized).not.toContain("memory-test-1");
  });

  it("Memory选择拒绝浏览器提交endpoint、Token和namespace", async () => {
    const { app } = await testApp();
    const created = await postJson(app, "/api/sessions", { commandId: nextCmd(), payload: {} });
    const { session } = (await created.json()) as { session: { sessionId: string } };
    const response = await postJson(app, `/api/sessions/${session.sessionId}/messages`, {
      commandId: nextCmd(),
      payload: {
        text: "非法配置",
        context: {
          memory: {
            backendId: "mbk_memmy",
            requirement: "optional",
            tags: [],
            layers: ["L2"],
            limit: 3,
            contextBudget: 512,
            endpoint: "https://evil.example",
            token: "secret",
            namespace: { userId: "other" },
          },
        },
      },
    });
    expect(response.status).toBe(400);
    expect(problemDetailSchema.parse(await response.json()).code).toBe("validation_failed");
  });

  it("未知资源返回not_found；公开响应不携带Runtime私有身份", async () => {
    const { app, deps } = await testApp();
    const res = await app.request("/api/runs/run_nonexistent");
    expect(res.status).toBe(404);
    expect(problemDetailSchema.parse(await res.json()).code).toBe("not_found");

    const created = await postJson(app, "/api/sessions", { commandId: nextCmd(), payload: {} });
    const { session } = (await created.json()) as { session: { sessionId: string } };
    const sent = await postJson(app, `/api/sessions/${session.sessionId}/messages`, {
      commandId: nextCmd(),
      payload: { text: "hi" },
    });
    const { run } = (await sent.json()) as { run: { productRunId: string } };
    await publishPlanForReview(deps, {
      productRunId: run.productRunId as ProductRunId,
      commandId: nextCmd(),
      content: planContent,
    });
    for (const path of [
      `/api/runs/${run.productRunId}`,
      `/api/runs/${run.productRunId}/plans`,
      `/api/runs/${run.productRunId}/approvals/current`,
      `/api/sessions/${session.sessionId}/messages`,
    ]) {
      const queryRes = await app.request(path);
      const text = await queryRes.text();
      expect(text).not.toContain("workflowRunId");
      expect(text).not.toContain("hookToken");
      expect(text).not.toContain("piSessionId");
      expect(text).not.toContain("dashscope");
    }
  });

  it("Note查询严格拒绝未知、重复和非整数参数", async () => {
    const { app } = await testApp();
    for (const path of [
      "/api/notes?unknown=1",
      "/api/notes?limit=1&limit=2",
      "/api/notes?limit=1.5",
      "/api/notes?limit=0",
    ]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(400);
      expect(problemDetailSchema.parse(await response.json()).code, path).toBe("validation_failed");
    }
  });

  it("Note Decision公开命令必须携带expectedRevision", async () => {
    const { app } = await testApp();
    const response = await postJson(app, "/api/runs/run_notecasmissing1/note-decisions", {
      commandId: nextCmd(),
      payload: {},
    });
    expect(response.status).toBe(400);
    expect(problemDetailSchema.parse(await response.json()).code).toBe("validation_failed");
  });

  it("Rule公开API使用strict Query/Command、ETag、CAS并且摘要不返回正文", async () => {
    const { app } = await testApp();
    const tagResponse = await postJson(app, "/api/rule-tags", {
      commandId: nextCmd(),
      payload: { name: "Quality" },
    });
    expect(tagResponse.status).toBe(201);
    const tag = (await tagResponse.json()) as { tag: { ruleTagId: string } };
    const createResponse = await postJson(app, "/api/rules", {
      commandId: nextCmd(),
      payload: {
        title: "交付前验证",
        priority: 500,
        revision: {
          body: "交付前必须运行测试。",
          rationale: "完成需要证据。",
          appliesWhen: [],
          doesNotApplyWhen: [],
          positiveExamples: [],
          negativeExamples: [],
          scopes: [{ kind: "global" }],
          tagIds: [tag.tag.ruleTagId],
          conflictsWithRuleIds: [],
          risk: "low",
          sourceCases: [],
        },
      },
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as {
      rule: {
        ruleId: string;
        revision: number;
        currentRevision: { ruleRevisionId: string; sha256: string };
      };
    };

    const list = await app.request("/api/rules");
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(listText).not.toContain("交付前必须运行测试");
    const etag = list.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(
      (
        await app.request("/api/rules", {
          headers: { "if-none-match": etag ?? "" },
        })
      ).status,
    ).toBe(304);
    expect((await app.request("/api/rules?unknown=1")).status).toBe(400);
    expect((await app.request("/api/rules?limit=1&limit=2")).status).toBe(400);

    const missingCas = await postJson(app, `/api/rules/${created.rule.ruleId}/lifecycle`, {
      commandId: nextCmd(),
      payload: {
        boundRevisionId: created.rule.currentRevision.ruleRevisionId,
        boundRevisionSha256: created.rule.currentRevision.sha256,
        toLifecycle: "trial",
        reason: "试用",
      },
    });
    expect(missingCas.status).toBe(400);
  });

  it("骨架模式（无产品上下文）下产品路由返回not_found", async () => {
    const app = createApiApp({ traceSink: null });
    const res = await app.request("/api/runs/run_1");
    expect(res.status).toBe(404);
  });

  it("Agent Version API创建全局/Workspace不可变版本并把精确版本发布为新Workflow Revision", async () => {
    const { app, deps } = await testApp();
    const inheritedResources = {
      contextFiles: "inherit_runtime_default",
      skills: "inherit_runtime_default",
      promptTemplates: "inherit_runtime_default",
      extensions: "inherit_runtime_default",
    } as const;
    const firstCommandId = nextCmd();
    const firstPayload = {
      title: "Pi CLI 默认版本",
      description: "继承Pi CLI默认System Prompt与编码能力。",
      scope: { kind: "global" as const },
      runtime: { kind: "pi_coding_agent" as const, baseVariantKey: "pi_cli_default" },
      systemPrompt: { mode: "inherit_runtime" as const },
      enabledToolNames: ["read", "bash", "edit", "write"] as const,
      resources: inheritedResources,
    };
    const firstResponse = await postJson(app, "/api/agent-profiles/direct/versions", {
      commandId: firstCommandId,
      payload: firstPayload,
    });
    expect(firstResponse.status, await firstResponse.clone().text()).toBe(201);
    const firstProfile = agentProfileDtoSchema.parse(await firstResponse.json());
    expect(firstProfile.versions).toHaveLength(1);
    const first = firstProfile.versions[0]!;
    expect(first).toMatchObject({
      agentKey: "direct",
      ownerPrincipalId: DEBUG_PRINCIPAL_ID,
      scope: { kind: "global" },
      version: 1,
      runtime: { kind: "pi_coding_agent", baseVariantKey: "pi_cli_default" },
      systemPrompt: { mode: "inherit_runtime" },
      enabledToolNames: ["read", "bash", "edit", "write"],
      resources: inheritedResources,
    });
    expect(first.sha256).toBe(hashCanonical("agent-version.v1", toAgentVersionHashInput(first)));

    const replayResponse = await postJson(app, "/api/agent-profiles/direct/versions", {
      commandId: firstCommandId,
      payload: firstPayload,
    });
    expect(replayResponse.status).toBe(201);
    const replayed = agentProfileDtoSchema.parse(await replayResponse.json());
    expect(replayed.versions.map((version) => version.agentVersionId)).toEqual([
      first.agentVersionId,
    ]);

    const workspaceBody = "你是Chat工作区专用的编码Agent。";
    const workspaceResponse = await postJson(app, "/api/agent-profiles/direct/versions", {
      commandId: nextCmd(),
      payload: {
        title: "Chat Workspace版本",
        description: "只允许在root_chat工作区使用。",
        scope: { kind: "workspace", rootId: "root_chat" },
        runtime: { kind: "pi_coding_agent", baseVariantKey: "pi_cli_default" },
        systemPrompt: { mode: "replace", bodyMarkdown: workspaceBody },
        enabledToolNames: ["read"],
        resources: {
          contextFiles: "disabled",
          skills: "disabled",
          promptTemplates: "disabled",
          extensions: "disabled",
        },
      },
    });
    expect(workspaceResponse.status, await workspaceResponse.clone().text()).toBe(201);
    const workspaceProfile = agentProfileDtoSchema.parse(await workspaceResponse.json());
    const workspace = workspaceProfile.versions.find((version) => version.version === 2);
    if (workspace === undefined || workspace.systemPrompt.mode !== "replace") {
      throw new Error("缺少Workspace Agent Version");
    }
    expect(workspace.scope).toEqual({ kind: "workspace", rootId: "root_chat" });
    expect(workspace.systemPrompt.sha256).toBe(
      hashCanonical("agent-system-prompt.v1", { bodyMarkdown: workspaceBody }),
    );
    expect(workspace.sha256).toBe(
      hashCanonical("agent-version.v1", toAgentVersionHashInput(workspace)),
    );
    expect(
      workspaceProfile.runtimeBaseline?.variants
        .find((variant) => variant.variantKey === "pi_cli_default")
        ?.tools.map((tool) => tool.name),
    ).toContain("runtime_probe");

    const globalOnlyProfile = agentProfileDtoSchema.parse(
      await (await app.request("/api/agent-profiles/direct")).json(),
    );
    expect(globalOnlyProfile.versions.map((version) => version.scope.kind)).toEqual(["global"]);
    expect(
      globalOnlyProfile.runtimeBaseline?.variants
        .find((variant) => variant.variantKey === "pi_cli_default")
        ?.tools.map((tool) => tool.name),
    ).not.toContain("runtime_probe");
    const scopedReadResponse = await app.request(
      "/api/agent-profiles/direct?workspaceRootId=root_chat",
    );
    expect(scopedReadResponse.status).toBe(200);
    const scopedReadProfile = agentProfileDtoSchema.parse(await scopedReadResponse.json());
    expect(scopedReadProfile.versions.map((version) => version.scope.kind).sort()).toEqual([
      "global",
      "workspace",
    ]);

    const unknownRootProfile = await app.request(
      "/api/agent-profiles/direct?workspaceRootId=root_missing",
    );
    expect(unknownRootProfile.status).toBe(403);
    const unknownQuery = await app.request("/api/agent-profiles?unknown=1");
    expect(unknownQuery.status).toBe(400);
    const repeatedQuery = await app.request(
      "/api/agent-profiles?workspaceRootId=root_chat&workspaceRootId=root_chat",
    );
    expect(repeatedQuery.status).toBe(400);

    const derivedBody = "你是从全局默认版本派生的发布Agent。";
    const derivedResponse = await postJson(app, "/api/agent-profiles/direct/versions", {
      commandId: nextCmd(),
      payload: {
        title: "全局派生版本",
        description: "用于Workflow精确绑定。",
        scope: { kind: "global" },
        runtime: { kind: "pi_coding_agent", baseVariantKey: "pi_cli_default" },
        systemPrompt: { mode: "replace", bodyMarkdown: derivedBody },
        enabledToolNames: ["read", "bash"],
        resources: inheritedResources,
        basedOnVersionId: first.agentVersionId,
        basedOnVersionSha256: first.sha256,
      },
    });
    expect(derivedResponse.status, await derivedResponse.clone().text()).toBe(201);
    const derivedProfile = agentProfileDtoSchema.parse(await derivedResponse.json());
    const derived = derivedProfile.versions.find((version) => version.version === 3);
    if (derived === undefined) throw new Error("缺少全局派生Agent Version");
    expect(derived).toMatchObject({
      basedOnVersionId: first.agentVersionId,
      scope: { kind: "global" },
      enabledToolNames: ["read", "bash"],
    });
    expect(derived.sha256).toBe(
      hashCanonical("agent-version.v1", toAgentVersionHashInput(derived)),
    );

    const beforeBinding = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const source = structuredClone(
      beforeBinding.entities.workflowDefinitionRevisions[SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID],
    );
    if (source === undefined) throw new Error("缺少Direct系统Workflow Revision");
    const bindResponse = await postJson(
      app,
      "/api/workflow/definitions/agent-node-configurations",
      {
        commandId: nextCmd(),
        payload: {
          sourceWorkflowDefinitionRevisionId: source.workflowDefinitionRevisionId,
          sourceDefinitionSha256: source.definitionSha256,
          definitionNodeId: "direct.agent",
          agentKey: "direct",
          agentVersionId: derived.agentVersionId,
          agentVersionSha256: derived.sha256,
        },
      },
    );
    expect(bindResponse.status, await bindResponse.clone().text()).toBe(201);
    const bound = workflowDefinitionCommandResultDtoSchema.parse(await bindResponse.json());
    expect(bound.affectedRevision?.state).toBe("published");
    expect(bound.affectedRevision?.definitionRevision).toBe(1);
    expect(bound.definition.ownerKind).toBe("principal");
    expect(bound.definition.publishedRevision?.workflowDefinitionRevisionId).toBe(
      bound.affectedRevision?.workflowDefinitionRevisionId,
    );

    const afterBinding = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(
      afterBinding.entities.workflowDefinitionRevisions[source.workflowDefinitionRevisionId],
    ).toEqual(source);
    const published =
      afterBinding.entities.workflowDefinitionRevisions[
        bound.affectedRevision!.workflowDefinitionRevisionId
      ];
    if (published === undefined) throw new Error("缺少新发布Workflow Revision");
    const directNode = published.semanticRoot.elements[0];
    if (directNode?.kind !== "composite") throw new Error("新Workflow缺少Direct节点");
    expect(directNode.config).toMatchObject({
      capabilityMode: "pi_cli_default",
      promptReviewMode: "manual",
      agentKey: "direct",
      agentVersionId: derived.agentVersionId,
      agentVersionSha256: derived.sha256,
    });
    expect(published.basedOnRevisionId).toBe(source.workflowDefinitionRevisionId);
    expect(published.definitionSha256).not.toBe(source.definitionSha256);

    const codingProfileResponse = await app.request("/api/agent-profiles/coding_executor");
    expect(codingProfileResponse.status).toBe(200);
    const codingProfile = agentProfileDtoSchema.parse(await codingProfileResponse.json());
    expect(codingProfile.allowedActions).not.toContain("create_version");
    const unsupportedVersion = await postJson(app, "/api/agent-profiles/coding_executor/versions", {
      commandId: nextCmd(),
      payload: firstPayload,
    });
    expect(unsupportedVersion.status).toBe(403);

    const bootstrapProfileResponse = await app.request("/api/agent-profiles/project_bootstrap");
    expect(bootstrapProfileResponse.status).toBe(200);
    const bootstrapProfile = agentProfileDtoSchema.parse(await bootstrapProfileResponse.json());
    expect(bootstrapProfile.allowedActions).not.toContain("create_version");
    const unsupportedBootstrapVersion = await postJson(
      app,
      "/api/agent-profiles/project_bootstrap/versions",
      { commandId: nextCmd(), payload: firstPayload },
    );
    expect(unsupportedBootstrapVersion.status).toBe(403);
  });

  it("Agent Version拒绝跨Principal、未知Workspace及跨Scope派生", async () => {
    const { app, deps } = await testApp();
    const resources = {
      contextFiles: "inherit_runtime_default",
      skills: "inherit_runtime_default",
      promptTemplates: "inherit_runtime_default",
      extensions: "inherit_runtime_default",
    } as const;
    const baseResponse = await postJson(app, "/api/agent-profiles/direct/versions", {
      commandId: nextCmd(),
      payload: {
        title: "全局基线",
        description: "用于拒绝越权派生。",
        scope: { kind: "global" },
        runtime: { kind: "pi_coding_agent", baseVariantKey: "pi_cli_default" },
        systemPrompt: { mode: "inherit_runtime" },
        enabledToolNames: ["read", "bash", "edit", "write"],
        resources,
      },
    });
    const base = agentProfileDtoSchema.parse(await baseResponse.json()).versions[0]!;
    const derivedPayload = {
      title: "越权派生",
      description: "该请求必须失败。",
      scope: { kind: "global" as const },
      runtime: { kind: "pi_coding_agent" as const, baseVariantKey: "pi_cli_default" },
      systemPrompt: { mode: "inherit_runtime" as const },
      enabledToolNames: ["read", "bash", "edit", "write"] as const,
      resources,
      basedOnVersionId: base.agentVersionId,
      basedOnVersionSha256: base.sha256,
    };
    const otherApp = createApiApp({
      traceSink: null,
      product: { deps, principalId: "usr_agentversionother" as never },
    });
    const foreign = await postJson(otherApp, "/api/agent-profiles/direct/versions", {
      commandId: "cmd_agentversionforeign1",
      payload: derivedPayload,
    });
    expect(foreign.status).toBe(409);
    expect(problemDetailSchema.parse(await foreign.json()).code).toBe("revision_conflict");

    const unknownWorkspace = await postJson(app, "/api/agent-profiles/direct/versions", {
      commandId: nextCmd(),
      payload: {
        ...derivedPayload,
        scope: { kind: "workspace", rootId: "root_missing" },
        basedOnVersionId: undefined,
        basedOnVersionSha256: undefined,
      },
    });
    expect(unknownWorkspace.status).toBe(403);
    expect(problemDetailSchema.parse(await unknownWorkspace.json()).code).toBe("forbidden");

    const crossScope = await postJson(app, "/api/agent-profiles/direct/versions", {
      commandId: nextCmd(),
      payload: {
        ...derivedPayload,
        scope: { kind: "workspace", rootId: "root_chat" },
      },
    });
    expect(crossScope.status).toBe(409);
    expect(problemDetailSchema.parse(await crossScope.json()).code).toBe("revision_conflict");
  });

  it("会话Prompt与Agent Prompt独立管理，Workflow节点只冻结Agent绑定", async () => {
    const { app, deps } = await testApp();
    const regions = await app.request("/api/prompt-regions");
    expect(regions.status).toBe(200);
    const regionsBody = (await regions.json()) as {
      items: { regionKey: string; userManageable: boolean; sourceRelativePath: string }[];
    };
    expect(regionsBody.items).toContainEqual(
      expect.objectContaining({
        regionKey: "agent_identity",
        userManageable: false,
        sourceRelativePath: "prompts/regions/catalog.md",
      }),
    );
    expect(regionsBody.items).toContainEqual(
      expect.objectContaining({ regionKey: "tools", userManageable: false }),
    );

    const workspaces = await app.request("/api/prompt-workspaces");
    expect(workspaces.status).toBe(200);
    expect(promptWorkspacesDtoSchema.parse(await workspaces.json()).items).toEqual([
      expect.objectContaining({ rootId: "root_chat", title: "Chat" }),
    ]);

    const previewResponse = await postJson(app, "/api/prompt-assembly-previews", {
      text: "检查Prompt管理纵向",
      selection: {
        schemaVersion: "prompt-turn-selection-input.v1",
        workspaceRootId: "root_chat",
        regions: [],
      },
    });
    expect(previewResponse.status, await previewResponse.clone().text()).toBe(200);
    const preview = promptAssemblyPreviewDtoSchema.parse(await previewResponse.json());
    expect(preview.userPrompt).toContain("检查Prompt管理纵向");
    expect(preview.regions.map((region) => region.regionKey)).not.toContain("agent_identity");

    const configurationResponse = await postJson(app, "/api/prompt-configuration-previews", {
      selection: {
        schemaVersion: "prompt-turn-selection-input.v1",
        workspaceRootId: "root_chat",
        regions: [],
      },
    });
    expect(configurationResponse.status, await configurationResponse.clone().text()).toBe(200);
    const configuration = promptConfigurationPreviewDtoSchema.parse(
      await configurationResponse.json(),
    );
    expect(configuration.regions.map((region) => region.regionKey)).not.toContain("agent_identity");
    expect(configuration).not.toHaveProperty("userPrompt");

    const profilesResponse = await app.request("/api/agent-profiles");
    expect(profilesResponse.status).toBe(200);
    const profiles = agentProfilesDtoSchema.parse(await profilesResponse.json());
    expect(profiles.items.map((item) => item.agentKey)).toEqual([
      "planner",
      "direct",
      "project_bootstrap",
      "coding_executor",
      "note_extractor",
    ]);
    const directProfile = profiles.items.find((item) => item.agentKey === "direct");
    if (directProfile === undefined) throw new Error("缺少Direct Agent Profile");
    expect(directProfile.systemPrompt).toMatchObject({
      source: "runtime_default",
      mode: "inherit",
      runtimeVariantKey: "pi_cli_default",
    });
    expect(directProfile.tools.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write"]);
    const projectBootstrapProfile = profiles.items.find(
      (item) => item.agentKey === "project_bootstrap",
    );
    expect(projectBootstrapProfile).toMatchObject({
      systemPrompt: { source: "builtin", mode: "replace" },
      runtimeBaseline: { kind: "pi_coding_agent" },
    });

    const genericIdentityCreate = await postJson(app, "/api/prompt-fragments", {
      commandId: nextCmd(),
      payload: {
        scope: { kind: "global" },
        revision: {
          regionKey: "agent_identity",
          title: "错误的会话身份",
          content: { kind: "markdown", bodyMarkdown: "不应通过会话Prompt管理。" },
        },
      },
    });
    expect(genericIdentityCreate.status).toBe(400);

    const revisedResponse = await postJson(app, "/api/agent-profiles/direct/prompt-revisions", {
      commandId: nextCmd(),
      payload: {
        expectedAggregateRevision: directProfile.systemPrompt.aggregateRevision,
        bodyMarkdown: "# Direct Agent\n\n你是独立配置的Direct Agent。",
      },
    });
    expect(revisedResponse.status, await revisedResponse.clone().text()).toBe(200);
    const revisedAgent = agentProfileDtoSchema.parse(await revisedResponse.json());
    expect(revisedAgent.systemPrompt).toMatchObject({
      source: "principal_override",
      mode: "replace",
      revision: 1,
      aggregateRevision: 1,
    });
    if (revisedAgent.systemPrompt.source !== "principal_override") {
      throw new Error("Direct Agent自定义没有形成覆盖Revision");
    }
    const revisedPromptFragmentId = revisedAgent.systemPrompt.promptFragmentId;
    const revisedPromptFragmentRevisionId = revisedAgent.systemPrompt.promptFragmentRevisionId;
    const product = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const storedRevisions = Object.values(product.entities.promptFragmentRevisions).filter(
      (revision) => revision.promptFragmentId === revisedPromptFragmentId,
    );
    expect(storedRevisions).toHaveLength(1);
    expect(
      storedRevisions.every((revision) => revision.schemaVersion === "prompt-fragment-revision.v2"),
    ).toBe(true);
    expect(JSON.stringify(storedRevisions)).not.toContain("独立配置的Direct Agent");
    expect(JSON.stringify(storedRevisions)).toContain("sourceRelativePath");

    const otherPrincipal = "usr_agentprofileother" as PrincipalId;
    const otherApp = createApiApp({
      traceSink: null,
      product: { deps, principalId: otherPrincipal },
    });
    const otherProfiles = agentProfilesDtoSchema.parse(
      await (await otherApp.request("/api/agent-profiles")).json(),
    );
    const otherDirect = otherProfiles.items.find((item) => item.agentKey === "direct");
    if (otherDirect === undefined) throw new Error("第二用户缺少Direct Agent");
    expect(otherDirect.systemPrompt.source).toBe("runtime_default");
    const otherRevisedResponse = await postJson(
      otherApp,
      "/api/agent-profiles/direct/prompt-revisions",
      {
        commandId: "cmd_agentprofileother1",
        payload: {
          expectedAggregateRevision: 0,
          bodyMarkdown: "# Other Direct Agent\n\n这是另一个用户的默认Agent。",
        },
      },
    );
    expect(otherRevisedResponse.status, await otherRevisedResponse.clone().text()).toBe(200);
    const otherRevised = agentProfileDtoSchema.parse(await otherRevisedResponse.json());
    if (otherRevised.systemPrompt.source !== "principal_override") {
      throw new Error("第二用户的Direct Agent自定义没有形成覆盖Revision");
    }
    expect(otherRevised.systemPrompt.promptFragmentId).not.toBe(revisedPromptFragmentId);
    const originalAfterOther = agentProfileDtoSchema.parse(
      await (await app.request("/api/agent-profiles/direct")).json(),
    );
    expect(originalAfterOther.systemPrompt.bodyMarkdown).toContain("独立配置的Direct Agent");

    const directDefinitions = z
      .object({ definitions: workflowDefinitionsDtoSchema })
      .strict()
      .parse(await (await app.request("/api/workflow/definitions")).json());
    const direct = directDefinitions.definitions.definitions.find(
      (definition) =>
        definition.workflowDefinitionRevisionId === SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID,
    );
    if (direct === undefined) throw new Error("缺少Direct Workflow");
    const sessionResponse = await postJson(app, "/api/sessions", {
      commandId: nextCmd(),
      payload: { title: "Prompt V2 Direct体验" },
    });
    const session = sessionDtoSchema.parse(
      ((await sessionResponse.json()) as { session: unknown }).session,
    );
    const directMessagePayload = {
      text: "检查当前项目",
      workflowSelection: {
        kind: "published_revision" as const,
        workflowDefinitionRevisionId: direct.workflowDefinitionRevisionId,
        definitionSha256: direct.definitionSha256,
      },
      promptSelection: {
        schemaVersion: "prompt-turn-selection-input.v1" as const,
        workspaceRootId: "root_chat",
        regions: [],
      },
    };
    const beforeTurnPreview = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const firstTurnPreviewResponse = await postJson(app, "/api/prompt-turn-previews", {
      message: directMessagePayload,
    });
    expect(firstTurnPreviewResponse.status, await firstTurnPreviewResponse.clone().text()).toBe(
      200,
    );
    const firstTurnPreview = promptTurnPreviewDtoSchema.parse(
      await firstTurnPreviewResponse.json(),
    );
    expect(firstTurnPreview.currentInput).toBe("检查当前项目");
    expect((await deps.store.read({ kind: "committedSnapshot" })).snapshot).toEqual(
      beforeTurnPreview,
    );
    const turnPreviewResponse = await postJson(app, "/api/prompt-turn-previews", {
      sessionId: session.sessionId,
      message: directMessagePayload,
    });
    expect(turnPreviewResponse.status, await turnPreviewResponse.clone().text()).toBe(200);
    const turnPreview = promptTurnPreviewDtoSchema.parse(await turnPreviewResponse.json());
    expect(turnPreview.currentInput).toBe("检查当前项目");
    expect(turnPreview.nodes).toEqual([
      expect.objectContaining({
        nodeType: "agent.direct",
        agent: expect.objectContaining({ agentKey: "direct" }),
      }),
    ]);
    expect(turnPreview.assembly.schemaVersion).toBe("prompt-assembly.v2");
    if (turnPreview.assembly.schemaVersion !== "prompt-assembly.v2") {
      throw new Error("Direct发送前预览没有形成V2 Assembly");
    }
    expect(turnPreview.assembly.piSystemPrompt).toMatchObject({
      kind: "pi_coding_agent",
      mode: "replace",
      bodyMarkdown: expect.stringContaining("你是独立配置的Direct Agent"),
    });
    const afterTurnPreview = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    expect(afterTurnPreview).toEqual(beforeTurnPreview);

    const sent = await postJson(app, `/api/sessions/${session.sessionId}/messages`, {
      commandId: nextCmd(),
      payload: directMessagePayload,
    });
    expect(sent.status, await sent.clone().text()).toBe(201);
    const afterSend = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const assembly = Object.values(afterSend.entities.promptAssemblies).find(
      (candidate) => candidate.productSessionId === session.sessionId,
    );
    expect(assembly?.schemaVersion).toBe("prompt-assembly.v2");
    if (assembly?.schemaVersion !== "prompt-assembly.v2") {
      throw new Error("Direct提交没有形成V2 Assembly");
    }
    expect(assembly.messages.at(-1)).toMatchObject({
      role: "user",
      text: "检查当前项目",
      source: { kind: "current_input" },
    });
    expect(assembly.systemPromptAppend).not.toContain("你是独立配置的Direct Agent");
    expect(assembly.piSystemPrompt).toMatchObject({
      kind: "pi_coding_agent",
      mode: "replace",
      bodyMarkdown: expect.stringContaining("你是独立配置的Direct Agent"),
    });
    expect(assembly.piSystemPrompt).toEqual(turnPreview.assembly.piSystemPrompt);
    expect(assembly.systemPromptAppend).toBe(turnPreview.assembly.systemPromptAppend);
    expect(assembly.regions).toEqual(turnPreview.assembly.regions);
    expect(assembly.tools).toEqual(turnPreview.assembly.tools);
    expect(assembly.requestOptions).toEqual(turnPreview.assembly.requestOptions);
    expect(assembly.regions[0]?.fragments[0]?.sourceRelativePath).toContain(
      ".data/prompts/global/agent_identity/",
    );

    const planning = directDefinitions.definitions.definitions.find(
      (definition) =>
        definition.workflowDefinitionRevisionId === SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
    );
    if (planning === undefined) throw new Error("缺少Planning Workflow");
    const planningNode = planning.nodes.find((node) => node.nodeType === "agent.plan");
    const executionNode = planning.nodes.find((node) => node.nodeType === "execute.plan");
    if (planningNode === undefined || executionNode === undefined) {
      throw new Error("Planning Workflow缺少Prompt节点");
    }
    const planningSessionResponse = await postJson(app, "/api/sessions", {
      commandId: nextCmd(),
      payload: { title: "Prompt V3 Planning体验" },
    });
    const planningSession = sessionDtoSchema.parse(
      ((await planningSessionResponse.json()) as { session: unknown }).session,
    );
    const planningSent = await postJson(
      app,
      `/api/sessions/${planningSession.sessionId}/messages`,
      {
        commandId: nextCmd(),
        payload: {
          text: "先规划，再执行",
          workflowSelection: {
            kind: "published_revision",
            workflowDefinitionRevisionId: planning.workflowDefinitionRevisionId,
            definitionSha256: planning.definitionSha256,
          },
          promptSelection: {
            schemaVersion: "prompt-turn-selection-input.v2",
            workspaceRootId: "root_chat",
            workflowDefinitionRevisionId: planning.workflowDefinitionRevisionId,
            regions: [],
            nodeSelections: [
              {
                definitionNodeId: executionNode.definitionNodeId,
                regions: [
                  {
                    regionKey: "agent_identity",
                    mode: "replace",
                    selected: [
                      {
                        promptFragmentRevisionId: revisedPromptFragmentRevisionId,
                        sha256: revisedAgent.systemPrompt.sha256,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    );
    expect(planningSent.status, await planningSent.clone().text()).toBe(201);
    const afterPlanning = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const workflowAssembly = Object.values(afterPlanning.entities.promptAssemblies).find(
      (candidate) => candidate.productSessionId === planningSession.sessionId,
    );
    expect(workflowAssembly?.schemaVersion).toBe("prompt-assembly.v3");
    if (workflowAssembly?.schemaVersion !== "prompt-assembly.v3") {
      throw new Error("Planning提交没有形成V3 Assembly");
    }
    expect(workflowAssembly.nodes.map((node) => node.definitionNodeId).sort()).toEqual(
      [planningNode.definitionNodeId, executionNode.definitionNodeId].sort(),
    );
    expect(
      workflowAssembly.nodes.find(
        (node) => node.definitionNodeId === executionNode.definitionNodeId,
      )?.systemPromptAppend,
    ).not.toContain("你是独立配置的Direct Agent");

    const noSelectionSessionResponse = await postJson(app, "/api/sessions", {
      commandId: nextCmd(),
      payload: { title: "无Prompt Selection的V3体验" },
    });
    const noSelectionSession = sessionDtoSchema.parse(
      ((await noSelectionSessionResponse.json()) as { session: unknown }).session,
    );
    const runOverridePrompt = "你是这一次Run临时使用的规划Agent。";
    const noSelectionSent = await postJson(
      app,
      `/api/sessions/${noSelectionSession.sessionId}/messages`,
      {
        commandId: nextCmd(),
        payload: {
          text: "不提交Prompt Selection也必须冻结V3",
          workflowSelection: {
            kind: "published_revision",
            workflowDefinitionRevisionId: planning.workflowDefinitionRevisionId,
            definitionSha256: planning.definitionSha256,
            runConfiguration: {
              schemaVersion: "workflow-run-configuration.v1",
              overrides: [
                {
                  kind: "node_config",
                  definitionNodeId: planningNode.definitionNodeId,
                  field: "agentPromptOverride",
                  value: runOverridePrompt,
                },
              ],
            },
          },
        },
      },
    );
    expect(noSelectionSent.status, await noSelectionSent.clone().text()).toBe(201);
    const afterNoSelection = (await deps.store.read({ kind: "committedSnapshot" })).snapshot;
    const noSelectionAssembly = Object.values(afterNoSelection.entities.promptAssemblies).find(
      (candidate) => candidate.productSessionId === noSelectionSession.sessionId,
    );
    expect(noSelectionAssembly?.schemaVersion).toBe("prompt-assembly.v3");
    if (noSelectionAssembly?.schemaVersion !== "prompt-assembly.v3") {
      throw new Error("省略Prompt Selection没有形成V3 Assembly");
    }
    expect(
      noSelectionAssembly.nodes.find(
        (node) => node.definitionNodeId === planningNode.definitionNodeId,
      )?.systemPromptAppend,
    ).toContain(runOverridePrompt);

    const stale = await postJson(app, "/api/agent-profiles/direct/prompt-revisions", {
      commandId: nextCmd(),
      payload: {
        expectedAggregateRevision: 0,
        bodyMarkdown: "不会覆盖成功版本",
      },
    });
    expect(stale.status).toBe(409);

    const restoredResponse = await postJson(app, "/api/agent-profiles/direct/restore-default", {
      commandId: nextCmd(),
      payload: {
        expectedAggregateRevision: revisedAgent.systemPrompt.aggregateRevision,
        currentRevisionId: revisedAgent.systemPrompt.promptFragmentRevisionId,
        currentRevisionSha256: revisedAgent.systemPrompt.sha256,
      },
    });
    expect(restoredResponse.status, await restoredResponse.clone().text()).toBe(200);
    expect(agentProfileDtoSchema.parse(await restoredResponse.json()).systemPrompt.source).toBe(
      "runtime_default",
    );
  });
});
