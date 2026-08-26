import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import {
  agentRuntimeBaselineDtoSchema,
  startSessionMessageResponseSchema,
  submitMessageResponseSchema,
  type AgentKey,
} from "@chat/contracts";
import { computeWorkspaceGrantSha256 } from "@chat/domain";
import {
  beginDirectAgentAttempt,
  commitDirectAgentResult,
  createInProcessProjectBootstrapExecutionCoordinator,
  persistDirectAgentCandidate,
  prepareProjectBootstrapCandidate,
  updateOutboxStatus,
  type ApplicationDeps,
} from "@chat/application";
import { JsonProductStore } from "@chat/product-store-json";
import { createApiApp } from "../src/app.js";
import {
  DEBUG_PRINCIPAL_ID,
  createDirectAgentIdFactory,
  createIdFactory,
  createProjectBootstrapIdFactory,
} from "../src/composition.js";
import { OutboxDispatcher } from "../src/outbox-dispatcher.js";
import { createFilePromptCatalog } from "../src/prompt-catalog.js";
import { runtimeToolFixture } from "../src/runtime-profile-test-fixture.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const port = Number.parseInt(process.env.PORT ?? "45411", 10);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
  throw new Error("建项DSH E2E PORT必须是有效的非特权端口");
}
const dataRoot = resolve(repoRoot, ".data/e2e/dsh-project-bootstrap-real");
const productStorePath = process.env.CHAT_PRODUCT_STORE_PATH?.trim();
if (productStorePath !== resolve(dataRoot, "product-store.v1.json")) {
  throw new Error("建项DSH E2E只能写入受管Product Store fixture");
}
const workspaceRoot = resolve(dataRoot, "workspace-root");
const workspaceTarget = resolve(workspaceRoot, "ai-learning");
const planeProjectId = "66cf0460-84e0-4d3d-b1ef-d193b83b7562";
const submittedBodies: unknown[] = [];
const submissionBindings: Array<{ productSessionId: string; productRunId: string }> = [];
const providerCalls = {
  workspaceProvision: 0,
  workspaceReconcile: 0,
  planeProvision: 0,
  planeReconcile: 0,
};
let providerReleased = false;
let decisionCommandCount = 0;
let dispatcherStarted = false;
const releaseWaiters = new Set<() => void>();

async function waitForProviderRelease(): Promise<void> {
  if (providerReleased) return;
  await new Promise<void>((resolveRelease) => releaseWaiters.add(resolveRelease));
}

function releaseProvider(): void {
  providerReleased = true;
  for (const release of releaseWaiters) release();
  releaseWaiters.clear();
}

function runtimeProfile(agentKey: AgentKey) {
  if (agentKey !== "direct" && agentKey !== "project_bootstrap" && agentKey !== "coding_executor") {
    return undefined;
  }
  const variants =
    agentKey === "direct"
      ? [
          { variantKey: "pi_cli_default", tools: ["read", "bash", "edit", "write"] },
          { variantKey: "project_bootstrap", tools: ["project_bootstrap_prepare"] },
        ]
      : agentKey === "project_bootstrap"
        ? [
            { variantKey: "read_only", tools: ["read", "grep", "find", "ls"] },
            { variantKey: "project_bootstrap", tools: ["project_bootstrap_prepare"] },
          ]
        : [
            {
              variantKey: "workspace_write_shell",
              tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
            },
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
      description: "建项浏览器门确定性Pi能力合同",
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
          name === "project_bootstrap_prepare" ? {} : { workspaceRootId: "root_chat" },
        ),
      ),
    })),
    finalReviewNote: "发送前复核。",
  });
}

await mkdir(workspaceRoot, { recursive: true });
const store = await JsonProductStore.open({
  filePath: productStorePath,
  now: () => new Date().toISOString(),
});
const workspace = {
  listRoots: () => [{ rootId: "root_code" as never, displayName: "Code" }],
  preflight: async () => ({
    root: { rootId: "root_code" as never, displayName: "Code" },
    directoryName: "ai-learning",
    workspaceLabel: "Code/ai-learning",
  }),
  provision: async () => {
    providerCalls.workspaceProvision += 1;
    await waitForProviderRelease();
    await mkdir(workspaceTarget, { recursive: true });
    return { status: "completed" as const, workspaceLabel: "Code/ai-learning" };
  },
  reconcile: async () => {
    providerCalls.workspaceReconcile += 1;
    await waitForProviderRelease();
    await mkdir(workspaceTarget, { recursive: true });
    return { status: "completed" as const, workspaceLabel: "Code/ai-learning" };
  },
};
const plane = {
  describe: () => ({
    providerKind: "plane_ce" as const,
    providerVersion: "deterministic-e2e.v1",
    providerWebBaseUrl: "http://127.0.0.1:45499",
    allowedWorkspaceSlugs: ["learning"],
  }),
  preflight: async () => ({ planeProjectLabel: "Learning/AI2026" }),
  provision: async () => {
    providerCalls.planeProvision += 1;
    return { status: "completed" as const, planeProjectId: planeProjectId as never };
  },
  reconcile: async () => {
    providerCalls.planeReconcile += 1;
    return { status: "completed" as const, planeProjectId: planeProjectId as never };
  },
};
const deps: ApplicationDeps = {
  store,
  now: () => new Date().toISOString(),
  ids: createIdFactory(),
  directAgentIds: createDirectAgentIdFactory(),
  projectBootstrapIds: createProjectBootstrapIdFactory(),
  projectBootstrapExecutionCoordinator: createInProcessProjectBootstrapExecutionCoordinator(),
  promptCatalog: await createFilePromptCatalog(repoRoot),
  agentRuntimeProfiles: {
    read: async (agentKey) =>
      agentKey === "governance_reviewer" ? undefined : runtimeProfile(agentKey),
  },
  projectRoots: {
    list: () => [
      {
        rootId: "root_chat",
        displayName: "Chat",
        enabledAdapters: ["local-git-workspace.v1" as const],
        // 真实DSH Host把当前受管Chat worktree作为root_chat；确定性E2E必须提供与
        // 生产Registry相同算法的授权指纹，不能用缺字段的旧Task 02 fixture绕过Task 01。
        grantSha256: computeWorkspaceGrantSha256(repoRoot),
      },
    ],
    observe: async () => {
      throw new Error("建项E2E首轮不应观察Project Workspace资源");
    },
  },
  projectWorkspaceProvisioner: workspace,
  projectManagementBootstrap: plane,
};

const api = createApiApp({ traceSink: null, product: { deps, principalId: DEBUG_PRINCIPAL_ID } });
let submissionCount = 0;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

const dispatcher = new OutboxDispatcher({
  deps,
  workflowRuntimeBaseUrl: "http://127.0.0.1:1",
  credential: "rtk_dshprojectbootstrape2e000000",
  intervalMs: 50,
  dispatcherInstanceId: "dsh-project-bootstrap-e2e",
});

async function disableWorkflowStart(productRunId: string, suffix: string): Promise<void> {
  const snapshot = (await store.read({ kind: "committedSnapshot" })).snapshot;
  const entries = Object.values(snapshot.outbox).filter(
    (entry) =>
      entry.kind === "workflow_start" &&
      entry.productRunId === productRunId &&
      entry.status === "pending",
  );
  for (const [index, entry] of entries.entries()) {
    await updateOutboxStatus(deps, {
      commandId: `cmd_dshbootstrapdisable${suffix}${String(index + 1)}` as never,
      outboxId: entry.outboxId,
      status: "failed_terminal",
    });
  }
}

/**
 * E2E只替代未启动的模型/Workflow Runtime：Session、Message、Run、Candidate和最终
 * Assistant Message全部经过真实Router与Application提交，且始终绑定首轮返回的同一Run。
 */
async function settleFirstProjectBootstrapSubmission(
  productSessionId: string,
  productRunId: string,
): Promise<void> {
  await disableWorkflowStart(productRunId, "first");
  const snapshot = (await store.read({ kind: "committedSnapshot" })).snapshot;
  const workflowAttempt = Object.values(snapshot.entities.attempts).find(
    (attempt) => attempt.productRunId === productRunId && attempt.kind === "workflow",
  );
  if (workflowAttempt === undefined) throw new Error("首轮真实Run缺少Workflow Attempt");
  const begun = await beginDirectAgentAttempt(deps, {
    commandId: "cmd_dshbootstrapbeginfirst" as never,
    productRunId: productRunId as never,
    workflowAttemptId: workflowAttempt.attemptId,
  });
  const candidate = await prepareProjectBootstrapCandidate(deps, {
    principalId: DEBUG_PRINCIPAL_ID,
    productSessionId: productSessionId as never,
    productRunId: productRunId as never,
    commandId: "cmd_dshbootstrappreparefirst" as never,
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
  const directCandidate = await persistDirectAgentCandidate(deps, {
    commandId: "cmd_dshbootstrapdirectcandidatefirst" as never,
    productRunId: productRunId as never,
    directAgentAttemptId: begun.directAgentAttemptId,
    output: { format: "markdown", text: "项目方案已准备，请确认。" },
  });
  await commitDirectAgentResult(deps, {
    commandId: "cmd_dshbootstrapcommitfirst" as never,
    productRunId: productRunId as never,
    directAgentAttemptId: begun.directAgentAttemptId,
    directAgentCandidateId: directCandidate.directAgentCandidateId,
    candidateSha256: directCandidate.sha256,
  });
  const committed = (await store.read({ kind: "committedSnapshot" })).snapshot;
  const persistedCandidate =
    committed.entities.projectBootstrapCandidates[candidate.projectBootstrapCandidateId];
  if (
    persistedCandidate?.sourceProductSessionId !== productSessionId ||
    persistedCandidate.sourceProductRunId !== productRunId
  ) {
    throw new Error("首轮Product Session/Run/Candidate绑定不一致");
  }
  if (!dispatcherStarted) {
    dispatcherStarted = true;
    dispatcher.start();
  }
}

async function realSubmission(request: Request, includeSession: boolean): Promise<Response> {
  const body = (await request.clone().json()) as unknown;
  submittedBodies.push(body);
  submissionCount += 1;
  // 第二轮发生在bootstrap ready之后；本fixture没有普通Workflow Runtime，
  // 在真实Router提交前停止建项Dispatcher，避免它竞争消费新的workflow_start。
  if (!includeSession) dispatcher.stop();
  const response = await api.fetch(request);
  if (!response.ok) return response;
  if (includeSession) {
    const submitted = startSessionMessageResponseSchema.parse(await response.clone().json());
    submissionBindings.push({
      productSessionId: submitted.session.sessionId,
      productRunId: submitted.run.productRunId,
    });
    await settleFirstProjectBootstrapSubmission(
      submitted.session.sessionId,
      submitted.run.productRunId,
    );
  } else {
    const submitted = submitMessageResponseSchema.parse(await response.clone().json());
    submissionBindings.push({
      productSessionId: submitted.message.sessionId,
      productRunId: submitted.run.productRunId,
    });
    // 第二轮只验证一次性Workflow已恢复；未配置的Runtime不应被Dispatcher调用。
    await disableWorkflowStart(submitted.run.productRunId, `later${String(submissionCount)}`);
  }
  return response;
}

const fetch = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/api/project-bootstrap/messages") {
    return realSubmission(request, true);
  }
  if (request.method === "POST" && /^\/api\/sessions\/[^/]+\/messages$/u.test(url.pathname)) {
    return realSubmission(request, false);
  }
  if (request.method === "POST" && url.pathname === "/__project-bootstrap/release") {
    releaseProvider();
    return json({ released: true });
  }
  if (
    request.method === "POST" &&
    /^\/api\/project-bootstrap\/candidates\/[^/]+\/decision$/u.test(url.pathname)
  ) {
    decisionCommandCount += 1;
    return api.fetch(request);
  }
  if (request.method === "GET" && url.pathname === "/__project-bootstrap/state") {
    const snapshot = (await store.read({ kind: "committedSnapshot" })).snapshot;
    return json({
      providerReleased,
      providerCalls,
      decisionCommandCount,
      submissions: submittedBodies,
      submissionBindings,
      candidate: Object.values(snapshot.entities.projectBootstrapCandidates)[0] ?? null,
      operation: Object.values(snapshot.entities.projectBootstrapOperations)[0] ?? null,
      binding: Object.values(snapshot.entities.projectWorkspaceBindings)[0] ?? null,
      bootstrapOutbox:
        Object.values(snapshot.outbox).find(
          (entry) => entry.kind === "project_bootstrap_execute",
        ) ?? null,
    });
  }
  return api.fetch(request);
};

const server = serve({ fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(
    `chat project-bootstrap DSH E2E API listening on http://127.0.0.1:${String(info.port)}`,
  );
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    dispatcher.stop();
    server.close();
  });
}
