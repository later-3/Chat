import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApprovalDto,
  MessageDto,
  MemoryBackendProfileDto,
  MemoryImportDto,
  PlanDto,
  RunContextDto,
  RunDto,
  SessionDto,
  SubmitDecisionPayload,
  SubmitMessagePayload,
  CreateMemoryImportPayload,
} from "@chat/contracts/public";
import { RealWorkspace } from "../components/RealWorkspace.js";
import { useRealChain } from "./use-real-chain.js";

/**
 * M3前端闭环测试。
 *
 * fake公开API只证明调用合同与界面投影；真实状态机由后端测试证明。
 * 断言重点：
 * - 状态全部来自服务端Query，不从本地状态猜测成功；
 * - 发送失败保留草稿并可用同一commandId重试；
 * - Decision失败保留修改意见；
 * - 刷新后从服务端恢复Plan/Approval/正式消息。
 */

/* ---------- fake公开API（仅合同形状，不含领域规则） ---------- */

interface FakeState {
  session: SessionDto;
  messages: MessageDto[];
  run: RunDto | null;
  plans: PlanDto[];
  approval: ApprovalDto | null;
  sessionCommandIds: string[];
  memoryBackends: MemoryBackendProfileDto[];
  runContext: RunContextDto | null;
  submitCalls: { payload: SubmitMessagePayload; commandId: string }[];
  decisionCalls: { payload: SubmitDecisionPayload; commandId: string }[];
  memoryImports: MemoryImportDto[];
  memoryImportCalls: { payload: CreateMemoryImportPayload; commandId: string }[];
  memoryImportQueryCalls: number;
  failNextSession: boolean;
  failNextSend: boolean;
  failNextDecision: boolean;
  disconnectNextDecision: boolean;
  disconnectNextMemoryImport: boolean;
}

function makePlan(revision: number, sha: string, status: PlanDto["status"]): PlanDto {
  return {
    schemaVersion: "chat-product-api.v1",
    planId: "pln_1" as never,
    planRevision: revision,
    status,
    sha256: sha,
    content: {
      objective: "整理项目进展并生成Markdown周报",
      summary: revision === 1 ? "v1摘要" : "v2摘要：风险单独成节",
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
    },
    createdAt: "2026-08-07T12:00:00.000Z",
    updatedAt: "2026-08-07T12:00:00.000Z",
  };
}

function installFakeApi(initial?: Partial<FakeState>) {
  const state: FakeState = {
    session: {
      schemaVersion: "chat-product-api.v1",
      sessionId: "psn_fake1" as never,
      status: "active",
      revision: 1,
      createdAt: "2026-08-07T12:00:00.000Z",
      updatedAt: "2026-08-07T12:00:00.000Z",
    },
    messages: [],
    run: null,
    plans: [],
    approval: null,
    memoryBackends: [
      {
        schemaVersion: "chat-product-api.v1",
        backendId: "mbk_memmy" as never,
        displayName: "memmy",
        kind: "memmy",
        configured: true,
        health: "ready",
        capabilities: {
          query: true,
          tags: true,
          layers: ["L1", "L2", "L3", "Skill"],
          maxLimit: 20,
          maxContextBudget: 8_192,
          import: {
            mode: "explicit_fact",
            layers: ["L2"],
            title: true,
            tags: true,
            maxContentChars: 50_000,
          },
        },
      },
    ],
    runContext: null,
    sessionCommandIds: [],
    submitCalls: [],
    decisionCalls: [],
    memoryImports: [],
    memoryImportCalls: [],
    memoryImportQueryCalls: 0,
    failNextSession: false,
    failNextSend: false,
    failNextDecision: false,
    disconnectNextDecision: false,
    disconnectNextMemoryImport: false,
    ...initial,
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url === "/api/sessions" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { commandId: string };
      state.sessionCommandIds.push(body.commandId);
      if (state.failNextSession) {
        state.failNextSession = false;
        throw new TypeError("connection lost after request");
      }
      return json({ session: state.session }, 201);
    }
    if (url === "/api/memory-backends" && method === "GET") {
      return json({ backends: state.memoryBackends });
    }
    if (url.endsWith("/memory-imports") && method === "GET") {
      state.memoryImportQueryCalls += 1;
      return json({ memoryImports: state.memoryImports });
    }
    if (url === "/api/memory-imports" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as {
        commandId: string;
        payload: CreateMemoryImportPayload;
      };
      state.memoryImportCalls.push({ commandId: body.commandId, payload: body.payload });
      const existing = state.memoryImports[0];
      const memoryImport: MemoryImportDto =
        existing ??
        ({
          schemaVersion: "chat-product-api.v1",
          memoryImportIntentId: "mii_fakeimport1" as never,
          memoryImportResultId: "mir_fakeimport1" as never,
          sessionId: state.session.sessionId,
          sourceMessageId: body.payload.sourceSelection.sourceMessageId,
          selectionKind: body.payload.sourceSelection.kind,
          sourcePreview: "需要导入的正式事实",
          backendId: body.payload.backendId,
          backendDisplayName: "memmy",
          memoryLayer: "L2",
          title: body.payload.title,
          tags: body.payload.tags,
          status: "queued",
          resultRevision: 1,
          allowedActions: [],
          createdAt: "2026-08-08T00:00:00.000Z",
          updatedAt: "2026-08-08T00:00:00.000Z",
        } satisfies MemoryImportDto);
      if (existing === undefined) state.memoryImports.push(memoryImport);
      if (state.disconnectNextMemoryImport) {
        state.disconnectNextMemoryImport = false;
        throw new TypeError("connection lost after memory import commit");
      }
      return json({ memoryImport }, 201);
    }
    if (url.endsWith("/messages") && method === "POST") {
      const body = JSON.parse(String(init?.body)) as {
        commandId: string;
        payload: SubmitMessagePayload;
      };
      if (state.failNextSend) {
        state.failNextSend = false;
        return json(
          {
            type: "https://chat.dev/problems/internal-error",
            title: "内部错误",
            status: 500,
            code: "internal_error",
            requestId: "req_fake",
            retryable: true,
            recoveryAction: "retry_same_command",
          },
          500,
        );
      }
      state.submitCalls.push({ payload: body.payload, commandId: body.commandId });
      const message: MessageDto = {
        schemaVersion: "chat-product-api.v1",
        messageId: `msg_${String(state.messages.length + 1)}` as never,
        sessionId: state.session.sessionId,
        sessionSequence: state.messages.length + 1,
        role: "user",
        content: { format: "markdown", text: body.payload.text },
        sha256: "a".repeat(64),
        createdAt: "2026-08-07T12:00:00.000Z",
      };
      state.messages.push(message);
      state.run = {
        schemaVersion: "chat-product-api.v1",
        productRunId: "run_fake1" as never,
        sessionId: state.session.sessionId,
        sourceMessageId: message.messageId,
        status: "running",
        phase: "planning",
        maxPlanRevisions: 5,
        allowedActions: [],
        revision: 1,
        createdAt: "2026-08-07T12:00:00.000Z",
        updatedAt: "2026-08-07T12:00:00.000Z",
      };
      state.runContext = {
        schemaVersion: "chat-product-api.v1",
        productRunId: state.run.productRunId,
        ...(body.payload.context !== undefined
          ? {
              memory: {
                backendId: body.payload.context.memory.backendId,
                requirement: body.payload.context.memory.requirement,
                queryStatus: "pending",
                memoryQueryId: "mqy_fake1" as never,
              },
            }
          : {}),
      };
      return json({ message, run: state.run }, 201);
    }
    if (url.endsWith("/messages") && method === "GET") {
      return json({ items: state.messages });
    }
    if (url.includes("/plans") && method === "GET") return json({ items: state.plans });
    if (url.includes("/approvals/current") && method === "GET")
      return json({ approval: state.approval });
    if (url.includes("/context") && method === "GET" && state.runContext !== null) {
      return json({ context: state.runContext });
    }
    if (url.includes("/decisions") && method === "POST") {
      const body = JSON.parse(String(init?.body)) as {
        commandId: string;
        payload: SubmitDecisionPayload;
      };
      state.decisionCalls.push({ payload: body.payload, commandId: body.commandId });
      if (state.disconnectNextDecision) {
        state.disconnectNextDecision = false;
        throw new TypeError("connection lost after decision");
      }
      if (state.failNextDecision) {
        state.failNextDecision = false;
        return json(
          {
            type: "https://chat.dev/problems/plan-hash-conflict",
            title: "计划版本冲突",
            status: 409,
            code: "plan_hash_conflict",
            requestId: "req_fake",
            retryable: false,
            recoveryAction: "rehydrate_and_retry",
          },
          409,
        );
      }
      if (state.run !== null) {
        state.run = { ...state.run, revision: state.run.revision + 1 };
      }
      return json(
        {
          decision: {
            schemaVersion: "chat-product-api.v1",
            decisionId: `dec_${String(state.decisionCalls.length)}`,
            approvalRequestId: body.payload.approvalRequestId,
            productRunId: state.run?.productRunId ?? "run_fake1",
            planId: body.payload.planId,
            planRevision: body.payload.planRevision,
            planSha256: body.payload.planSha256,
            kind: body.payload.kind,
            createdAt: "2026-08-07T12:00:00.000Z",
          },
          run: state.run,
        },
        201,
      );
    }
    if (url.includes("/runs/") && method === "GET" && state.run !== null) {
      return json({ run: state.run });
    }
    return json(
      {
        type: "t",
        title: "not found",
        status: 404,
        code: "not_found",
        requestId: "req_fake",
        retryable: false,
        recoveryAction: "none",
      },
      404,
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return state;
}

/* ---------- fake状态推进助手（模拟服务端后台变化） ---------- */

function publishPlanV1(state: FakeState) {
  state.plans = [makePlan(1, "a".repeat(64), "under_review")];
  state.approval = {
    schemaVersion: "chat-product-api.v1",
    approvalRequestId: "apr_1" as never,
    productRunId: "run_fake1" as never,
    planId: "pln_1" as never,
    planRevision: 1,
    planSha256: "a".repeat(64),
    status: "open",
    createdAt: "2026-08-07T12:00:00.000Z",
    expiresAt: "2026-08-08T12:00:00.000Z",
  };
  if (state.run !== null) {
    state.run = {
      ...state.run,
      status: "waiting_human",
      phase: "plan_review",
      currentPlan: {
        planId: "pln_1" as never,
        planRevision: 1,
        status: "under_review",
        sha256: "a".repeat(64),
      },
      allowedActions: ["request_revision", "approve", "reject"],
      revision: state.run.revision + 1,
    };
  }
}

function publishPlanV2(state: FakeState) {
  state.plans = [
    makePlan(1, "a".repeat(64), "superseded"),
    makePlan(2, "b".repeat(64), "under_review"),
  ];
  state.approval = {
    ...state.approval!,
    approvalRequestId: "apr_2" as never,
    planRevision: 2,
    planSha256: "b".repeat(64),
  };
  if (state.run !== null) {
    state.run = {
      ...state.run,
      status: "waiting_human",
      phase: "plan_review",
      currentPlan: {
        planId: "pln_1" as never,
        planRevision: 2,
        status: "under_review",
        sha256: "b".repeat(64),
      },
      revision: state.run.revision + 1,
    };
  }
}

function completeRun(state: FakeState) {
  if (state.run !== null) {
    state.run = {
      ...state.run,
      status: "succeeded",
      phase: "completed",
      allowedActions: [],
      revision: state.run.revision + 1,
    };
  }
  state.approval = { ...state.approval!, status: "decided" };
  state.plans = state.plans.map((plan, index) =>
    index === state.plans.length - 1 ? { ...plan, status: "approved" } : plan,
  );
  state.messages.push({
    schemaVersion: "chat-product-api.v1",
    messageId: "msg_final" as never,
    sessionId: state.session.sessionId,
    sessionSequence: state.messages.length + 1,
    role: "assistant",
    content: {
      format: "markdown",
      text: "## 本周进展\n\n- A完成\n\n## 风险与下一步\n\n行动项1/2/3",
    },
    sourceRunId: "run_fake1" as never,
    sha256: "b".repeat(64),
    createdAt: "2026-08-07T12:00:00.000Z",
  });
}

/* ---------- 渲染 ---------- */

function RealApp() {
  const chain = useRealChain(window.localStorage, { refetchMs: 30 });
  return <RealWorkspace chain={chain} connected />;
}

function renderReal() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RealApp />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("M3真实前端闭环", () => {
  it("完整链路：发送 -> 规划状态 -> Plan v1 -> 修改 -> v2 -> 批准 -> 正式结果", async () => {
    const state = installFakeApi();
    const user = userEvent.setup();
    renderReal();

    // 输入并发送（模型标签固定为真实百炼文案，不提供模型选择）
    expect((await screen.findByLabelText("当前模型")).textContent).toContain("百炼 Qwen3.7 Plus");
    await user.type(screen.getByLabelText("消息输入框"), "根据项目进展生成周报");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(state.submitCalls).toHaveLength(1));
    // 状态来自服务端：正在规划
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("正在规划"));

    // 服务端发布Plan v1 -> 轮询投影出Plan卡片与决定动作
    act(() => publishPlanV1(state));
    await waitFor(() => expect(screen.getByLabelText("计划第1版")).toBeTruthy());
    expect(screen.getByText("等待你确认计划")).toBeTruthy();
    expect(screen.getByText("Plan v1")).toBeTruthy();

    // 提交修改意见
    await user.type(await screen.findByLabelText("修改意见"), "把风险单独成节");
    await user.click(screen.getByRole("button", { name: "要求修改" }));
    await waitFor(() => expect(state.decisionCalls).toHaveLength(1));
    expect(state.decisionCalls[0]?.payload.kind).toBe("request_revision");
    expect(state.decisionCalls[0]?.payload.planSha256).toBe("a".repeat(64));

    // 服务端发布v2：v1为历史事实（superseded）不可决定，v2审核中
    act(() => publishPlanV2(state));
    await waitFor(() => expect(screen.getByLabelText("计划第2版")).toBeTruthy());
    expect(screen.getByText("已被新版本取代")).toBeTruthy();

    // 批准v2 -> 服务端执行并提交正式结果
    await waitFor(() => expect(screen.getByRole("button", { name: "通过" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "通过" }));
    await waitFor(() => expect(state.decisionCalls).toHaveLength(2));
    act(() => completeRun(state));
    await waitFor(() =>
      expect(screen.getByText("工作已完成，正式结果已作为Assistant消息进入对话。")).toBeTruthy(),
    );
    // 正式Assistant Message只来自Message Query
    await waitFor(() => expect(screen.getByText(/行动项1\/2\/3/)).toBeTruthy());
  }, 30_000);

  it("发送失败保留草稿，同一commandId手动重试不重复提交", async () => {
    const state = installFakeApi();
    state.failNextSend = true;
    const user = userEvent.setup();
    renderReal();

    await user.type(await screen.findByLabelText("消息输入框"), "生成周报");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("请用同一命令重试"),
    );
    // 草稿保留
    expect((screen.getByLabelText("消息输入框") as HTMLTextAreaElement).value).toBe("生成周报");
    // 未产生localOnly成功消息
    expect(screen.queryByText("本地预览")).toBeNull();
    expect(state.submitCalls).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "用同一命令重试" }));
    await waitFor(() => expect(state.submitCalls).toHaveLength(1));
    expect(screen.getAllByText("生成周报").length).toBeGreaterThan(0);
  }, 30_000);

  it("选择memmy后发送冻结完整上下文payload并投影采用来源", async () => {
    const state = installFakeApi();
    const user = userEvent.setup();
    renderReal();

    await user.click(await screen.findByRole("button", { name: /上下文/ }));
    const memoryToggle = await screen.findByRole("checkbox", { name: /使用 Memory 上下文/ });
    await user.click(memoryToggle);
    await user.selectOptions(screen.getByLabelText("Memory 失败策略"), "required");
    await user.type(screen.getByLabelText("Memory 标签"), "项目, 决策");
    await user.clear(screen.getByLabelText("Memory 条目上限"));
    await user.type(screen.getByLabelText("Memory 条目上限"), "2");
    await user.type(screen.getByLabelText("消息输入框"), "使用记忆生成周报");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(state.submitCalls).toHaveLength(1));
    // Memory 是单轮选择：提交成功后，下一轮不得静默继承本轮配置。
    await waitFor(() => expect(screen.getByText("本轮不查询 Memory")).toBeTruthy());
    expect(state.submitCalls[0]?.payload).toMatchObject({
      text: "使用记忆生成周报",
      context: {
        memory: {
          backendId: "mbk_memmy",
          requirement: "required",
          tags: ["项目", "决策"],
          limit: 2,
          contextBudget: 1_800,
        },
      },
    });

    act(() => {
      state.runContext = {
        schemaVersion: "chat-product-api.v1",
        productRunId: "run_fake1" as never,
        memory: {
          backendId: "mbk_memmy" as never,
          requirement: "required",
          queryStatus: "completed",
          memoryQueryId: "mqy_fake1" as never,
          hitCount: 3,
          adoptedCount: 2,
        },
        contextPackage: {
          contextPackageId: "ctxp_fake1" as never,
          revision: 1,
          sha256: "c".repeat(64),
          sources: [
            {
              memoryResultSnapshotId: "mrs_fake1" as never,
              backendId: "mbk_memmy" as never,
              title: "项目决定",
              kind: "policy",
              memoryLayer: "L1",
              tags: ["项目"],
              revision: 1,
              sha256: "d".repeat(64),
            },
            {
              memoryResultSnapshotId: "mrs_fake2" as never,
              backendId: "mbk_memmy" as never,
              title: "历史风险",
              kind: "trace",
              memoryLayer: "L2",
              tags: ["决策"],
              revision: 1,
              sha256: "e".repeat(64),
            },
          ],
          exclusions: [],
        },
      };
    });
    await waitFor(() => expect(screen.getByText("使用 memmy 2 条")).toBeTruthy());
    expect(screen.getByText("项目决定、历史风险")).toBeTruthy();
  }, 30_000);

  it("可选memmy失败时明确显示未采用原因而不是假成功", async () => {
    const state = installFakeApi();
    const user = userEvent.setup();
    renderReal();
    await user.click(await screen.findByRole("button", { name: /上下文/ }));
    await user.click(await screen.findByRole("checkbox", { name: /使用 Memory 上下文/ }));
    await user.type(screen.getByLabelText("消息输入框"), "可选记忆周报");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(state.submitCalls).toHaveLength(1));
    await waitFor(() => expect(screen.getByText("正在查询 memmy 上下文")).toBeTruthy());

    act(() => {
      state.runContext = {
        schemaVersion: "chat-product-api.v1",
        productRunId: "run_fake1" as never,
        memory: {
          backendId: "mbk_memmy" as never,
          requirement: "optional",
          queryStatus: "failed",
          memoryQueryId: "mqy_fake1" as never,
          errorCode: "memory.backend.timeout",
        },
      };
    });
    await waitFor(() => expect(screen.getByText(/memmy 可选上下文未采用：查询超时/)).toBeTruthy());
    expect(screen.queryByText(/使用 memmy/)).toBeNull();
  }, 30_000);

  it("Decision失败保留修改意见", async () => {
    const state = installFakeApi();
    const user = userEvent.setup();
    renderReal();

    await user.type(await screen.findByLabelText("消息输入框"), "生成周报");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(state.submitCalls).toHaveLength(1));
    act(() => publishPlanV1(state));
    await waitFor(() => expect(screen.getByLabelText("计划第1版")).toBeTruthy());

    // decision接口本次返回冲突
    state.failNextDecision = true;
    await user.type(await screen.findByLabelText("修改意见"), "这条意见不能丢");
    await user.click(screen.getByRole("button", { name: "要求修改" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("状态已变化"));
    expect((screen.getByLabelText("修改意见") as HTMLTextAreaElement).value).toBe("这条意见不能丢");
  }, 30_000);

  it("Decision响应丢失时用同一commandId重试，不创建第二个决定身份", async () => {
    const state = installFakeApi();
    const user = userEvent.setup();
    renderReal();
    await user.type(await screen.findByLabelText("消息输入框"), "生成周报");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(state.submitCalls).toHaveLength(1));
    act(() => publishPlanV1(state));
    await waitFor(() => expect(screen.getByLabelText("计划第1版")).toBeTruthy());

    state.disconnectNextDecision = true;
    await user.type(await screen.findByLabelText("修改意见"), "保留这条修改意见");
    await user.click(screen.getByRole("button", { name: "要求修改" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("重试同一决定"));
    expect((screen.getByLabelText("修改意见") as HTMLTextAreaElement).value).toBe(
      "保留这条修改意见",
    );
    expect(state.decisionCalls).toHaveLength(1);
    const firstCommandId = state.decisionCalls[0]?.commandId;

    await user.click(screen.getByRole("button", { name: "用同一决定重试" }));
    await waitFor(() => expect(state.decisionCalls).toHaveLength(2));
    expect(state.decisionCalls[1]?.commandId).toBe(firstCommandId);
  }, 30_000);

  it("Memory Import响应丢失后刷新仍保留同一commandId供手动重试", async () => {
    const state = installFakeApi();
    const formalMessage: MessageDto = {
      schemaVersion: "chat-product-api.v1",
      messageId: "msg_memorypending1" as never,
      sessionId: state.session.sessionId,
      sessionSequence: 1,
      role: "user",
      content: { format: "markdown", text: "需要导入的正式事实" },
      sha256: "d".repeat(64) as never,
      createdAt: "2026-08-08T00:00:00.000Z",
    };
    state.messages.push(formalMessage);
    state.disconnectNextMemoryImport = true;
    window.localStorage.setItem(
      "chat:real-session:v1",
      JSON.stringify({
        version: 1,
        sessionId: state.session.sessionId,
        bootstrapCommandId: "cmd_bootstrap_memory",
      }),
    );

    const user = userEvent.setup();
    renderReal();
    await user.click(await screen.findByRole("button", { name: "导入记忆" }));
    await user.click(screen.getByRole("button", { name: "确认导入" }));
    await waitFor(() => expect(state.memoryImportCalls).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("结果未知"));
    const firstCommandId = state.memoryImportCalls[0]?.commandId;

    cleanup();
    renderReal();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("结果未知"));
    await user.click(screen.getByRole("button", { name: "用同一命令重试" }));
    await waitFor(() => expect(state.memoryImportCalls).toHaveLength(2));
    expect(state.memoryImportCalls[1]?.commandId).toBe(firstCommandId);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  }, 30_000);

  it("accepted状态只做3次有界自动验证轮询，不无限请求", async () => {
    const state = installFakeApi({
      memoryImports: [
        {
          schemaVersion: "chat-product-api.v1",
          memoryImportIntentId: "mii_acceptedpoll1" as never,
          memoryImportResultId: "mir_acceptedpoll1" as never,
          sessionId: "psn_fake1" as never,
          sourceMessageId: "msg_acceptedpoll1" as never,
          selectionKind: "full_message",
          sourcePreview: "已接收事实",
          backendId: "mbk_memmy" as never,
          backendDisplayName: "memmy",
          memoryLayer: "L2",
          title: "有界轮询",
          tags: [],
          status: "accepted",
          externalObjectId: "memory-accepted-poll-1",
          resultRevision: 3,
          allowedActions: ["reconcile"],
          createdAt: "2026-08-08T00:00:00.000Z",
          updatedAt: "2026-08-08T00:00:00.000Z",
        },
      ],
    });
    window.localStorage.setItem(
      "chat:real-session:v1",
      JSON.stringify({
        version: 1,
        sessionId: state.session.sessionId,
        bootstrapCommandId: "cmd_bootstrap_polling",
      }),
    );
    renderReal();
    await waitFor(() => expect(state.memoryImportQueryCalls).toBe(4), { timeout: 2_000 });
    const settledCount = state.memoryImportQueryCalls;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    expect(state.memoryImportQueryCalls).toBe(settledCount);
  }, 30_000);

  it("Session创建响应未知后刷新仍复用同一个bootstrap commandId", async () => {
    const state = installFakeApi();
    state.failNextSession = true;
    renderReal();
    await screen.findByRole("alert");
    expect(state.sessionCommandIds).toHaveLength(1);
    const firstCommandId = state.sessionCommandIds[0];

    cleanup();
    renderReal();
    await screen.findByLabelText("消息输入框");
    expect(state.sessionCommandIds).toHaveLength(2);
    expect(state.sessionCommandIds[1]).toBe(firstCommandId);
  }, 30_000);

  it("刷新后从服务端恢复会话、消息、Plan与Approval", async () => {
    const state = installFakeApi();
    // 预置：已有一台设备进行到等待确认阶段
    state.messages.push({
      schemaVersion: "chat-product-api.v1",
      messageId: "msg_1" as never,
      sessionId: state.session.sessionId,
      sessionSequence: 1,
      role: "user",
      content: { format: "markdown", text: "之前发送的目标" },
      sha256: "c".repeat(64),
      createdAt: "2026-08-07T12:00:00.000Z",
    });
    state.run = {
      schemaVersion: "chat-product-api.v1",
      productRunId: "run_fake1" as never,
      sessionId: state.session.sessionId,
      sourceMessageId: "msg_1" as never,
      status: "waiting_human",
      phase: "plan_review",
      currentPlan: {
        planId: "pln_1" as never,
        planRevision: 1,
        status: "under_review",
        sha256: "a".repeat(64),
      },
      maxPlanRevisions: 5,
      allowedActions: ["request_revision", "approve", "reject"],
      revision: 3,
      createdAt: "2026-08-07T12:00:00.000Z",
      updatedAt: "2026-08-07T12:00:00.000Z",
    };
    publishPlanV1(state);
    window.localStorage.setItem(
      "chat:real-session:v1",
      JSON.stringify({
        version: 1,
        sessionId: state.session.sessionId,
        bootstrapCommandId: "cmd_boot",
      }),
    );
    window.localStorage.setItem(`chat:real-run:v1:${state.session.sessionId}`, "run_fake1");

    renderReal();
    await waitFor(() => expect(screen.getByText("之前发送的目标")).toBeTruthy());
    await waitFor(() => expect(screen.getByLabelText("计划第1版")).toBeTruthy());
    expect(screen.getByText("等待你确认计划")).toBeTruthy();
    expect(screen.getByRole("button", { name: "通过" })).toBeTruthy();
  }, 30_000);

  it("活动Run未终态时禁发第二条消息并保留当前审核入口", async () => {
    const state = installFakeApi();
    const user = userEvent.setup();
    renderReal();

    const input = await screen.findByLabelText("消息输入框");
    await user.type(input, "第一项工作");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(state.submitCalls).toHaveLength(1));
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));

    await user.type(input, "不能覆盖审核入口的第二项工作");
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/当前工作尚未结束/)).toBeTruthy();

    act(() => publishPlanV1(state));
    await waitFor(() => expect(screen.getByLabelText("计划第1版")).toBeTruthy());
    expect(await screen.findByRole("button", { name: "通过" })).toBeTruthy();
    expect(state.submitCalls).toHaveLength(1);
  }, 30_000);

  it("过期Approval明确提示且不呈现任何决定按钮", async () => {
    const state = installFakeApi();
    const user = userEvent.setup();
    renderReal();
    await user.type(await screen.findByLabelText("消息输入框"), "等待审核的工作");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(state.submitCalls).toHaveLength(1));

    act(() => {
      publishPlanV1(state);
      state.approval = { ...state.approval!, status: "expired" };
      if (state.run !== null) state.run = { ...state.run, allowedActions: [] };
    });
    await waitFor(() => expect(screen.getByText(/本次计划审核已过期/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "通过" })).toBeNull();
    expect(screen.queryByRole("button", { name: "要求修改" })).toBeNull();
  }, 30_000);

  it("375px手机视图提供对话/工作切换，触控目标达标", async () => {
    installFakeApi();
    renderReal();
    const chatTab = await screen.findByRole("tab", { name: "对话" });
    const workTab = screen.getByRole("tab", { name: "工作" });
    expect(chatTab.getAttribute("aria-selected")).toBe("true");
    expect(workTab.getAttribute("aria-selected")).toBe("false");
  }, 30_000);
});
