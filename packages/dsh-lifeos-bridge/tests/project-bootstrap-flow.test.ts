import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProjectBootstrapSessionProjection } from "@chat/contracts/public";
import {
  createUserMessage,
  LlmError,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { LifeosLlmAdapter, stableCommandId } from "../src/adapter.ts";
import { BridgeRequestError, LifeosBridgeService } from "../src/bridge-service.ts";
import { ChatProductApiError, type ChatProductClient } from "../src/chat-client.ts";
import type { BridgeChatDispatchPlan, ChatRun, WorkflowSelection } from "../src/contracts.ts";
import { AtomicBridgeStateStore } from "../src/state-store.ts";

const dshSessionId = "dsh-project-bootstrap";
const productSessionId = "psn_projectbootstrap1";
const candidateId = "pbc_projectbootstrap1";
const operationId = "pbo_projectbootstrap1";
const candidateSha256 = "a".repeat(64);
const timestamp = "2026-08-21T00:00:00.000Z";

function bootstrapWorkflowSelection(): WorkflowSelection {
  return {
    workflowDefinitionRevisionId: "wfr_systemdirectagentv1" as never,
    definitionSha256: "d".repeat(64) as never,
    title: "创建项目",
    blueprintKey: "direct",
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
  };
}

async function collect(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
}

test("普通Workflow写命令在State和Bridge服务端都不能绕过一次性入口", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-project-bootstrap-guard-"));
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const selection = bootstrapWorkflowSelection();
    await assert.rejects(
      state.selectWorkflow(
        "dsh-bootstrap-guard",
        stableCommandId("create-session", "dsh-bootstrap-guard"),
        selection,
        "session",
      ),
      /dedicated lifecycle/u,
    );
    const service = new LifeosBridgeService({} as ChatProductClient, state);
    for (const scope of ["session", "new_sessions", "session_and_new_sessions"] as const) {
      await assert.rejects(
        service.selectWorkflow("dsh-bootstrap-guard", selection, scope),
        (error) =>
          error instanceof BridgeRequestError &&
          error.code === "lifeos_project_bootstrap_dedicated_entry_required",
      );
    }
    assert.equal(await state.readSession("dsh-bootstrap-guard"), undefined);
    assert.equal(await state.readNewSessionWorkflowPreference(), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("项目初始化响应未知期间拒绝不同消息创建第二个Bootstrap Run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-project-bootstrap-unknown-guard-"));
  try {
    const sessionId = "dsh-bootstrap-unknown-guard";
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    await state.initializeProjectBootstrapSession(
      sessionId,
      stableCommandId("create-session", sessionId),
      bootstrapWorkflowSelection(),
      { schemaVersion: "prompt-turn-selection-input.v1", regions: [] },
    );
    let submissions = 0;
    const chat = {
      submitFirstMessageFromDispatch: async () => {
        submissions += 1;
        throw new ChatProductApiError(
          503,
          "chat_api_unreachable",
          true,
          "retry_same_command",
          "response lost after Product commit",
        );
      },
    } as unknown as ChatProductClient;
    const adapter = new LifeosLlmAdapter(chat, state);
    const input = (text: string): GenerateOptions => ({
      provider: "lifeos",
      model: "workflow",
      sessionId: sessionId as never,
      messages: [
        createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text }],
        }),
      ],
    });

    await assert.rejects(
      adapter.stream(input("消息A：创建项目"))[Symbol.asyncIterator]().next(),
      (error) => error instanceof LlmError && error.code === "TRANSPORT",
    );
    const afterUnknown = await state.readSession(sessionId);
    const originalRequestKey = afterUnknown?.currentRequestKey;
    assert.equal(Object.keys(afterUnknown?.requests ?? {}).length, 1);

    await assert.rejects(
      adapter.stream(input("消息B：另建一个项目"))[Symbol.asyncIterator]().next(),
      (error) =>
        error instanceof LlmError && error.code === "LIFEOS_PROJECT_BOOTSTRAP_REQUEST_PENDING",
    );
    const afterBlocked = await state.readSession(sessionId);
    assert.equal(afterBlocked?.currentRequestKey, originalRequestKey);
    assert.equal(Object.keys(afterBlocked?.requests ?? {}).length, 1);
    assert.equal(submissions, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("项目初始化非retryable 500仍按响应未知保留原Request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-project-bootstrap-500-unknown-"));
  try {
    const sessionId = "dsh-bootstrap-500-unknown";
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    await state.initializeProjectBootstrapSession(
      sessionId,
      stableCommandId("create-session", sessionId),
      bootstrapWorkflowSelection(),
      { schemaVersion: "prompt-turn-selection-input.v1", regions: [] },
    );
    let submissions = 0;
    const chat = {
      submitFirstMessageFromDispatch: async () => {
        submissions += 1;
        throw new ChatProductApiError(
          500,
          "store_corrupted",
          false,
          "contact_support",
          "response may have failed after Product commit",
        );
      },
    } as unknown as ChatProductClient;
    const adapter = new LifeosLlmAdapter(chat, state);
    const input = (text: string): GenerateOptions => ({
      provider: "lifeos",
      model: "workflow",
      sessionId: sessionId as never,
      messages: [
        createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text }],
        }),
      ],
    });

    await assert.rejects(
      adapter.stream(input("消息A：创建项目"))[Symbol.asyncIterator]().next(),
      (error) => error instanceof LlmError && error.code === "LIFEOS_STORE_CORRUPTED",
    );
    const afterFailure = await state.readSession(sessionId);
    const requestKey = afterFailure?.currentRequestKey;
    assert.equal(afterFailure?.projectBootstrapLifecycle?.status, "active");

    await assert.rejects(
      adapter.stream(input("消息B：不能旁路"))[Symbol.asyncIterator]().next(),
      (error) =>
        error instanceof LlmError && error.code === "LIFEOS_PROJECT_BOOTSTRAP_REQUEST_PENDING",
    );
    const afterBlocked = await state.readSession(sessionId);
    assert.equal(afterBlocked?.currentRequestKey, requestKey);
    assert.equal(submissions, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("项目初始化首轮确定性失败会退出lifecycle并允许下一条普通消息", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-project-bootstrap-definite-failure-"));
  try {
    const sessionId = "dsh-bootstrap-definite-failure";
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const normalWorkflow: WorkflowSelection = {
      workflowDefinitionRevisionId: "wfr_systemplanningv1" as never,
      definitionSha256: "c".repeat(64) as never,
      title: "规划工作流",
      blueprintKey: "planning",
      runConfiguration: { schemaVersion: "workflow-run-configuration.v1", overrides: [] },
    };
    const createCommandId = stableCommandId("create-session", sessionId);
    await state.selectWorkflow(sessionId, createCommandId, normalWorkflow, "session");
    await state.initializeProjectBootstrapSession(
      sessionId,
      createCommandId,
      bootstrapWorkflowSelection(),
      { schemaVersion: "prompt-turn-selection-input.v1", regions: [] },
    );
    const submittedPaths: string[] = [];
    const chat = {
      submitFirstMessageFromDispatch: async (plan: BridgeChatDispatchPlan["submitMessage"]) => {
        submittedPaths.push(plan.path);
        if (plan.path === "/api/project-bootstrap/messages") {
          throw new ChatProductApiError(
            409,
            "revision_conflict",
            false,
            "rehydrate_and_retry",
            "Project Bootstrap能力未配置",
          );
        }
        return {
          session: { sessionId: "psn_afterdefinitefailure1" },
          message: {
            messageId: "msg_afterdefinitefailureuser1",
            sessionId: "psn_afterdefinitefailure1",
          },
          run: {
            productRunId: "run_afterdefinitefailure1",
            sourceMessageId: "msg_afterdefinitefailureuser1",
            status: "succeeded",
            finalMessageId: "msg_afterdefinitefailureassistant1",
          } as ChatRun,
        };
      },
      getMessage: async () => ({
        messageId: "msg_afterdefinitefailureassistant1",
        role: "assistant",
        content: { text: "已退出项目初始化" },
      }),
    } as unknown as ChatProductClient;
    const adapter = new LifeosLlmAdapter(chat, state);
    const input = (text: string): GenerateOptions => ({
      provider: "lifeos",
      model: "workflow",
      sessionId: sessionId as never,
      messages: [
        createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text }],
        }),
      ],
    });

    await assert.rejects(
      adapter.stream(input("创建项目"))[Symbol.asyncIterator]().next(),
      (error) => error instanceof LlmError && error.code === "LIFEOS_REVISION_CONFLICT",
    );
    const failed = await state.readSession(sessionId);
    assert.equal(failed?.projectBootstrapLifecycle?.status, "failed_terminal");
    assert.deepEqual(failed?.sessionWorkflowSelection, normalWorkflow);

    const chunks = await collect(adapter.stream(input("继续普通任务")));
    assert.ok(chunks.some((chunk) => chunk.type === "finish"));
    assert.deepEqual(submittedPaths, ["/api/project-bootstrap/messages", "/api/messages"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Adapter发送前直接恢复终态lifecycle，不携带已消费的bootstrap能力", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-project-bootstrap-presend-"));
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const normalWorkflow: WorkflowSelection = {
      workflowDefinitionRevisionId: "wfr_systemplanningv1" as never,
      definitionSha256: "c".repeat(64) as never,
      title: "规划工作流",
      blueprintKey: "planning",
      runConfiguration: { schemaVersion: "workflow-run-configuration.v1", overrides: [] },
    };
    const createCommandId = stableCommandId("create-session", "dsh-bootstrap-presend");
    await state.selectWorkflow("dsh-bootstrap-presend", createCommandId, normalWorkflow, "session");
    await state.initializeProjectBootstrapSession(
      "dsh-bootstrap-presend",
      createCommandId,
      bootstrapWorkflowSelection(),
      { schemaVersion: "prompt-turn-selection-input.v1", regions: [] },
    );
    await state.mutateSession("dsh-bootstrap-presend", createCommandId, (binding) => {
      binding.chatSessionId = productSessionId;
    });

    const readyOperation = {
      schemaVersion: "project-bootstrap.v1" as const,
      projectBootstrapOperationId: operationId as never,
      projectBootstrapCandidateId: candidateId as never,
      projectBootstrapDecisionId: "pbd_projectbootstrap1" as never,
      candidateSha256: candidateSha256 as never,
      ownerPrincipalId: "usr_debug" as never,
      status: "ready" as const,
      workspaceStep: "completed" as const,
      planeStep: "completed" as const,
      bindingStep: "completed" as const,
      planeProjectId: "66cf0460-84e0-4d3d-b1ef-d193b83b7562" as never,
      revision: 3,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const current: ProjectBootstrapSessionProjection = {
      candidate: { ...preparedProjection().candidate, status: "ready", revision: 4 },
      operation: readyOperation,
      recovery: { canRecover: false, reason: "terminal" },
    };
    let submittedPlan: BridgeChatDispatchPlan["submitMessage"] | undefined;
    const chat = {
      getCurrentProjectBootstrap: async () => current,
      submitMessageFromDispatch: async (
        sessionId: string,
        plan: BridgeChatDispatchPlan["submitMessage"],
      ) => {
        assert.equal(sessionId, productSessionId);
        submittedPlan = plan;
        return {
          message: { messageId: "msg_presenduser1", sessionId: productSessionId },
          run: {
            productRunId: "run_presendnormal1",
            sourceMessageId: "msg_presenduser1",
            status: "succeeded",
            finalMessageId: "msg_presendassistant1",
          },
        };
      },
      getMessage: async () => ({
        messageId: "msg_presendassistant1",
        role: "assistant",
        content: { text: "已回到普通工作流" },
      }),
    } as unknown as ChatProductClient;
    const input: GenerateOptions = {
      provider: "lifeos",
      model: "workflow",
      sessionId: "dsh-bootstrap-presend" as never,
      messages: [
        createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: "继续普通任务" }],
        }),
      ],
    };

    const chunks = await collect(new LifeosLlmAdapter(chat, state).stream(input));
    assert.equal(
      chunks.find((chunk) => chunk.type === "text-delta")?.type === "text-delta"
        ? chunks.find((chunk) => chunk.type === "text-delta")?.text
        : undefined,
      "已回到普通工作流",
    );
    assert.equal(
      submittedPlan?.payload.workflowSelection?.workflowDefinitionRevisionId,
      normalWorkflow.workflowDefinitionRevisionId,
    );
    assert.doesNotMatch(JSON.stringify(submittedPlan), /project_bootstrap/u);
    const completed = await state.readSession("dsh-bootstrap-presend");
    assert.equal(completed?.projectBootstrapLifecycle?.status, "ready");
    assert.deepEqual(completed?.sessionWorkflowSelection, normalWorkflow);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("专用Run在Candidate出现前失败时退出lifecycle并让下一条消息恢复普通Workflow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-project-bootstrap-run-failed-"));
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const sessionId = "dsh-bootstrap-run-failed";
    const normalWorkflow: WorkflowSelection = {
      workflowDefinitionRevisionId: "wfr_systemplanningv1" as never,
      definitionSha256: "c".repeat(64) as never,
      title: "规划工作流",
      blueprintKey: "planning",
      runConfiguration: { schemaVersion: "workflow-run-configuration.v1", overrides: [] },
    };
    const createCommandId = stableCommandId("create-session", sessionId);
    await state.selectWorkflow(sessionId, createCommandId, normalWorkflow, "session");
    await state.initializeProjectBootstrapSession(
      sessionId,
      createCommandId,
      bootstrapWorkflowSelection(),
      { schemaVersion: "prompt-turn-selection-input.v1", regions: [] },
    );
    await state.mutateSession(sessionId, createCommandId, (binding) => {
      binding.chatSessionId = productSessionId;
      binding.currentRequestKey = "bootstrap-failed-request";
      binding.requests["bootstrap-failed-request"] = {
        dshMessageId: "msg_dshbootstrapfailed1",
        userTextSha256: "b".repeat(64),
        messageCommandId: stableCommandId("submit-message", "bootstrap-failed-request"),
        submissionTarget: "existing_session",
        submissionStatus: "bound",
        productRunId: "run_bootstrapfailed1",
        workflowSelection: bootstrapWorkflowSelection(),
      };
    });

    let submittedPlan: BridgeChatDispatchPlan["submitMessage"] | undefined;
    const chat = {
      getCurrentProjectBootstrap: async () => null,
      getRun: async (productRunId: string) => {
        assert.equal(productRunId, "run_bootstrapfailed1");
        return {
          productRunId,
          status: "failed",
          failure: { summary: "Provider启动前失败" },
        } as ChatRun;
      },
      submitMessageFromDispatch: async (
        session: string,
        plan: BridgeChatDispatchPlan["submitMessage"],
      ) => {
        assert.equal(session, productSessionId);
        submittedPlan = plan;
        return {
          message: { messageId: "msg_afterbootstrapfailure1", sessionId: productSessionId },
          run: {
            productRunId: "run_afterbootstrapfailure1",
            sourceMessageId: "msg_afterbootstrapfailure1",
            status: "succeeded",
            finalMessageId: "msg_afterbootstrapfailureassistant1",
          },
        };
      },
      getMessage: async () => ({
        messageId: "msg_afterbootstrapfailureassistant1",
        role: "assistant",
        content: { text: "已恢复普通工作流" },
      }),
    } as unknown as ChatProductClient;
    const input: GenerateOptions = {
      provider: "lifeos",
      model: "workflow",
      sessionId: sessionId as never,
      messages: [
        createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: "继续普通任务" }],
        }),
      ],
    };

    await collect(new LifeosLlmAdapter(chat, state).stream(input));
    assert.equal(submittedPlan?.path, `/api/sessions/${productSessionId}/messages`);
    assert.doesNotMatch(JSON.stringify(submittedPlan), /project_bootstrap/u);
    const completed = await state.readSession(sessionId);
    assert.equal(completed?.projectBootstrapLifecycle?.status, "failed_terminal");
    assert.deepEqual(completed?.sessionWorkflowSelection, normalWorkflow);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function preparedProjection(): ProjectBootstrapSessionProjection {
  return {
    candidate: {
      schemaVersion: "project-bootstrap.v1",
      projectBootstrapCandidateId: candidateId as never,
      ownerPrincipalId: "usr_debug" as never,
      sourceProductSessionId: productSessionId as never,
      sourceProductRunId: "run_projectbootstrap1" as never,
      proposal: {
        name: "AI学习",
        objective: "学习公开课程、论文和开源项目，并形成自己的实践项目。",
        planeWorkspaceSlug: "learning",
        planeProjectIdentifier: "AI2026",
        workspaceRootId: "root_code" as never,
        directoryName: "ai-learning",
        initializerProfile: "ai_learning",
        initialModules: ["公开课", "论文", "开源项目", "实践项目"],
      },
      preview: {
        planeProjectLabel: "学习项目/AI2026",
        workspaceLabel: "Code/ai-learning",
        gitAction: "initialize",
        initialModules: ["公开课", "论文", "开源项目", "实践项目"],
      },
      status: "prepared",
      sha256: candidateSha256 as never,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    recovery: { canRecover: false, reason: "not_applicable" },
  };
}

test("专用入口冻结一次性能力，确认只写一次且后台ready后恢复普通Workflow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-project-bootstrap-"));
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    let current = preparedProjection();
    const calls: string[] = [];
    const configuration = {
      enabled: true as const,
      providerKind: "plane_ce" as const,
      providerVersion: "1.4.1",
      providerWebBaseUrl: "http://127.0.0.1:8088",
      planeWorkspaceSlugs: ["learning"],
      creationRoots: [{ rootId: "root_code" as never, displayName: "Code" }],
    };
    const chat = {
      getProjectBootstrapConfiguration: async () => configuration,
      listWorkflows: async () => [
        {
          workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
          definitionSha256: "b".repeat(64),
          title: "执行 Agent（逐次提示词审核）",
          blueprintKey: "direct",
          ownerKind: "system",
          configurableNodes: [
            {
              definitionNodeId: "direct.agent",
              fields: [{ name: "capabilityMode" }],
            },
          ],
        },
      ],
      getCurrentProjectBootstrap: async () => current,
      decideProjectBootstrap: async () => {
        calls.push("decide");
        const operation = {
          schemaVersion: "project-bootstrap.v1" as const,
          projectBootstrapOperationId: operationId as never,
          projectBootstrapCandidateId: candidateId as never,
          projectBootstrapDecisionId: "pbd_projectbootstrap1" as never,
          candidateSha256: candidateSha256 as never,
          ownerPrincipalId: "usr_debug" as never,
          status: "queued" as const,
          workspaceStep: "pending" as const,
          planeStep: "pending" as const,
          bindingStep: "pending" as const,
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        current = {
          candidate: { ...current.candidate, status: "confirmed", revision: 2 },
          decision: {
            schemaVersion: "project-bootstrap.v1",
            projectBootstrapDecisionId: "pbd_projectbootstrap1" as never,
            projectBootstrapCandidateId: candidateId as never,
            candidateRevision: 1,
            candidateSha256: candidateSha256 as never,
            decidedByPrincipalId: "usr_debug" as never,
            kind: "confirm",
            decidedAt: timestamp,
          },
          operation,
          recovery: { canRecover: false, reason: "background_dispatch_pending" },
        };
        return { candidate: current.candidate, operation };
      },
      requestProjectBootstrapRetry: async () => {
        calls.push("retry");
        return current.operation!;
      },
    } as unknown as ChatProductClient;
    const service = new LifeosBridgeService(chat, state, undefined, undefined, {
      resolve: () => null,
      resolveCreationTarget: async (rootId, directoryName) => {
        assert.equal(rootId, "root_code");
        assert.equal(directoryName, "ai-learning");
        return "/srv/code/ai-learning";
      },
    });

    const preset = await service.projectBootstrapPreset();
    assert.equal(preset.enabled, true);
    if (!preset.enabled) throw new Error("项目初始化应已启用");
    assert.deepEqual(preset.workflowSelection.runConfiguration?.overrides, [
      {
        kind: "node_config",
        definitionNodeId: "direct.agent",
        field: "capabilityMode",
        value: "project_bootstrap",
      },
    ]);
    assert.deepEqual(preset.promptSelection.regions, []);

    const normalWorkflow = {
      ...preset.workflowSelection,
      title: "普通执行Agent",
      runConfiguration: {
        schemaVersion: "workflow-run-configuration.v1" as const,
        overrides: [],
      },
    };
    await state.selectWorkflow(
      dshSessionId,
      stableCommandId("create-session", dshSessionId),
      normalWorkflow,
      "session",
    );
    await service.initializeProjectBootstrapSession(dshSessionId);
    const initialized = await state.readSession(dshSessionId);
    assert.equal(initialized?.sessionWorkflowSelection?.blueprintKey, "direct");
    assert.equal(initialized?.projectBootstrapLifecycle?.status, "active");
    assert.deepEqual(
      initialized?.projectBootstrapLifecycle?.returnWorkflowSelection,
      normalWorkflow,
    );
    assert.deepEqual(initialized?.promptSelection?.regions, []);
    await state.mutateSession(
      dshSessionId,
      stableCommandId("create-session", dshSessionId),
      (binding) => {
        binding.chatSessionId = productSessionId;
      },
    );

    const confirmed = await service.decideProjectBootstrap(dshSessionId, {
      kind: "confirm",
      binding: {
        projectBootstrapCandidateId: candidateId as never,
        candidateRevision: 1,
        candidateSha256: candidateSha256 as never,
      },
    });
    assert.deepEqual(calls, ["decide"]);
    assert.equal(confirmed.projectBootstrap?.operation?.status, "queued");

    const operation = {
      ...current.operation!,
      status: "ready" as const,
      workspaceStep: "completed" as const,
      planeStep: "completed" as const,
      bindingStep: "completed" as const,
      planeProjectId: "66cf0460-84e0-4d3d-b1ef-d193b83b7562" as never,
      revision: 3,
    };
    current = {
      ...current,
      candidate: { ...current.candidate, status: "ready", revision: 4 },
      operation,
      recovery: { canRecover: false, reason: "terminal" },
      binding: {
        schemaVersion: "project-bootstrap.v1",
        projectWorkspaceBindingId: "pwb_projectbootstrap1" as never,
        ownerPrincipalId: "usr_debug" as never,
        productSessionId: productSessionId as never,
        projectBootstrapOperationId: operationId as never,
        providerKind: "plane_ce",
        planeWorkspaceSlug: "learning",
        planeProjectId: "66cf0460-84e0-4d3d-b1ef-d193b83b7562" as never,
        planeProjectIdentifier: "AI2026",
        workspaceRootId: "root_code" as never,
        directoryName: "ai-learning",
        status: "active",
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    };
    const ready = await service.projection(dshSessionId);
    assert.equal(ready.projectBootstrap?.operation?.status, "ready");
    assert.deepEqual(ready.projectBootstrapTargets, {
      workspaceCwd: "/srv/code/ai-learning",
    });
    const completed = await state.readSession(dshSessionId);
    assert.equal(completed?.projectBootstrapLifecycle?.status, "ready");
    assert.deepEqual(completed?.sessionWorkflowSelection, normalWorkflow);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const terminalStatus of ["rejected", "failed_terminal"] as const) {
  test(`项目初始化${terminalStatus}后消费专用能力并恢复冻结的普通Workflow`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-dsh-project-bootstrap-terminal-"));
    try {
      const state = new AtomicBridgeStateStore(join(directory, "state.json"));
      await state.ready();
      const normalWorkflow = {
        workflowDefinitionRevisionId: "wfr_systemplanningv1" as never,
        definitionSha256: "c".repeat(64) as never,
        title: "规划工作流",
        blueprintKey: "planning" as const,
        runConfiguration: {
          schemaVersion: "workflow-run-configuration.v1" as const,
          overrides: [],
        },
      };
      const bootstrapWorkflow = {
        workflowDefinitionRevisionId: "wfr_systemdirectagentv1" as never,
        definitionSha256: "d".repeat(64) as never,
        title: "创建项目",
        blueprintKey: "direct" as const,
        runConfiguration: {
          schemaVersion: "workflow-run-configuration.v1" as const,
          overrides: [
            {
              kind: "node_config" as const,
              definitionNodeId: "direct.agent",
              field: "capabilityMode",
              value: "project_bootstrap",
            },
          ],
        },
      };
      const commandId = stableCommandId("create-session", `${dshSessionId}-${terminalStatus}`);

      await state.selectWorkflow(
        `${dshSessionId}-${terminalStatus}`,
        commandId,
        normalWorkflow,
        "session",
      );
      await state.initializeProjectBootstrapSession(
        `${dshSessionId}-${terminalStatus}`,
        commandId,
        bootstrapWorkflow,
        { schemaVersion: "prompt-turn-selection-input.v1", regions: [] },
      );
      await state.completeProjectBootstrapLifecycle(
        `${dshSessionId}-${terminalStatus}`,
        commandId,
        terminalStatus,
      );

      const completed = await state.readSession(`${dshSessionId}-${terminalStatus}`);
      assert.equal(completed?.projectBootstrapLifecycle?.status, terminalStatus);
      assert.deepEqual(completed?.sessionWorkflowSelection, normalWorkflow);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
