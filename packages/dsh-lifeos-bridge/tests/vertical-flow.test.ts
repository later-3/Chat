import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createUserMessage, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { LifeosLlmAdapter } from "../src/adapter.ts";
import { LifeosBridgeService } from "../src/bridge-service.ts";
import { ChatProductClient } from "../src/chat-client.ts";
import { workflowSelectionSchema } from "../src/contracts.ts";
import { AtomicBridgeStateStore } from "../src/state-store.ts";

const schemaVersion = "chat-product-api.v1";
const timestamp = "2026-08-16T00:00:00.000Z";
const planSha256 = "a".repeat(64);
const session = {
  schemaVersion,
  sessionId: "psn_bridge1",
  status: "active",
  title: "DeepSeek Harness",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
} as const;
const userMessage = {
  schemaVersion,
  messageId: "msg_user1",
  sessionId: session.sessionId,
  sessionSequence: 1,
  role: "user",
  content: { format: "markdown", text: "请制定并执行发布计划" },
  sha256: "b".repeat(64),
  createdAt: timestamp,
} as const;
const assistantMessage = {
  schemaVersion,
  messageId: "msg_assistant1",
  sessionId: session.sessionId,
  sessionSequence: 2,
  role: "assistant",
  content: { format: "markdown", text: "发布计划已执行并验证。" },
  sourceRunId: "run_bridge1",
  sha256: "c".repeat(64),
  createdAt: timestamp,
} as const;
const plan = {
  schemaVersion,
  planId: "pln_bridge1",
  planRevision: 1,
  status: "under_review",
  sha256: planSha256,
  content: {
    objective: "完成发布",
    summary: "先审核，再执行并验证。",
    assumptions: [],
    openQuestions: [],
    steps: [
      {
        stepId: "step-1",
        title: "执行发布",
        purpose: "交付已验证版本",
        dependsOn: [],
        inputRefs: [],
        expectedOutput: "已发布版本",
        successCriteria: ["验证通过"],
        requestedCapabilities: [],
        risk: "medium",
      },
    ],
    completionCriteria: ["发布与验证完成"],
    warnings: [],
  },
  createdAt: timestamp,
  updatedAt: timestamp,
} as const;
const approval = {
  schemaVersion,
  approvalRequestId: "apr_bridge1",
  productRunId: "run_bridge1",
  planId: plan.planId,
  planRevision: 1,
  planSha256,
  status: "open",
  createdAt: timestamp,
  expiresAt: "2026-08-17T00:00:00.000Z",
} as const;

function run(approved: boolean) {
  return approved
    ? {
        schemaVersion,
        productRunId: "run_bridge1",
        sessionId: session.sessionId,
        sourceMessageId: userMessage.messageId,
        runKind: "planning",
        status: "succeeded",
        phase: "completed",
        currentPlan: {
          planId: plan.planId,
          planRevision: 1,
          status: "approved",
          sha256: planSha256,
        },
        finalMessageId: assistantMessage.messageId,
        allowedActions: [],
        revision: 4,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
    : {
        schemaVersion,
        productRunId: "run_bridge1",
        sessionId: session.sessionId,
        sourceMessageId: userMessage.messageId,
        runKind: "planning",
        status: "waiting_human",
        phase: "plan_review",
        currentPlan: {
          planId: plan.planId,
          planRevision: 1,
          status: "under_review",
          sha256: planSha256,
        },
        currentApprovalRequestId: approval.approvalRequestId,
        allowedActions: ["request_revision", "approve", "reject"],
        revision: 2,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function json(res: ServerResponse, value: unknown): void {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function textDelta(chunks: readonly StreamChunk[]): string | undefined {
  const delta = chunks.find((chunk) => chunk.type === "text-delta");
  return delta?.type === "text-delta" ? delta.text : undefined;
}

test("native DSH generation crosses Chat Plan/HITL and returns only the committed assistant message", async () => {
  let approved = false;
  let submittedResolve!: () => void;
  const submitted = new Promise<void>((resolve) => {
    submittedResolve = resolve;
  });
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const requestBody = req.method === "POST" ? await body(req) : undefined;
      requests.push({
        method: req.method ?? "",
        path: url.pathname,
        ...(requestBody === undefined ? {} : { body: requestBody }),
      });
      if (req.method === "POST" && url.pathname === "/api/messages") {
        submittedResolve();
        json(res, { session, message: userMessage, run: run(false) });
      } else if (req.method === "GET" && url.pathname === "/api/runs/run_bridge1") {
        json(res, { run: run(approved) });
      } else if (req.method === "GET" && url.pathname === "/api/runs/run_bridge1/plans") {
        json(res, { items: [{ ...plan, status: approved ? "approved" : "under_review" }] });
      } else if (
        req.method === "GET" &&
        url.pathname === "/api/runs/run_bridge1/approvals/current"
      ) {
        json(res, { approval: approved ? null : approval });
      } else if (req.method === "POST" && url.pathname === "/api/runs/run_bridge1/decisions") {
        const envelope = requestBody as { payload?: { kind?: unknown } };
        assert.equal(envelope.payload?.kind, "approve");
        approved = true;
        json(res, {
          decision: {
            schemaVersion,
            decisionId: "dec_bridge1",
            approvalRequestId: approval.approvalRequestId,
            productRunId: "run_bridge1",
            planId: plan.planId,
            planRevision: 1,
            planSha256,
            kind: "approve",
            createdAt: timestamp,
          },
          run: run(true),
        });
      } else if (
        req.method === "GET" &&
        url.pathname === `/api/sessions/${session.sessionId}/messages/${assistantMessage.messageId}`
      ) {
        json(res, { message: assistantMessage });
      } else {
        res.statusCode = 404;
        res.end();
      }
    })().catch((error: unknown) => {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : "fixture failed");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-vertical-"));
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const chat = new ChatProductClient(new URL(`http://127.0.0.1:${address.port}`));
    const adapter = new LifeosLlmAdapter(chat, state);
    const bridge = new LifeosBridgeService(chat, state);
    const input: GenerateOptions = {
      provider: "lifeos",
      model: "workflow",
      sessionId: "dsh-session-1" as never,
      messages: [
        createUserMessage({
          source: { kind: "agent-instructions", form: "instructions" } as never,
          content: [{ type: "text", text: "# AGENTS.md\n中文回复，并运行相关测试。" }],
        }),
        createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: userMessage.content.text }],
        }),
      ],
    };
    const generation = collect(adapter.stream(input));
    await submitted;

    let waiting = await bridge.projection("dsh-session-1");
    for (let attempt = 0; waiting.run === null && attempt < 20; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      waiting = await bridge.projection("dsh-session-1");
    }
    assert.equal(waiting.run?.status, "waiting_human");
    assert.equal(waiting.plan?.content.objective, "完成发布");
    assert.equal(waiting.approval?.status, "open");
    assert.equal(waiting.pendingDecision, null);
    assert.doesNotMatch(JSON.stringify(waiting), /workflow(run)?id|hook(token)?|pi(session)?id/i);

    assert.ok(waiting.run !== null && waiting.approval !== null);
    const afterDecision = await bridge.decide("dsh-session-1", {
      kind: "approve",
      binding: {
        productRunId: waiting.run.productRunId,
        runRevision: waiting.run.revision,
        approvalRequestId: waiting.approval.approvalRequestId,
        planId: waiting.approval.planId,
        planRevision: waiting.approval.planRevision,
        planSha256: waiting.approval.planSha256,
      },
    });
    assert.equal(afterDecision.run?.status, "succeeded");
    const chunks = await generation;
    assert.deepEqual(
      chunks.map((chunk) => chunk.type),
      ["block-start", "text-delta", "block-end", "finish"],
    );
    const delta = chunks.find((chunk) => chunk.type === "text-delta");
    assert.equal(
      delta?.type === "text-delta" ? delta.text : undefined,
      assistantMessage.content.text,
    );
    const persistedBinding = await state.readSession("dsh-session-1");
    const persistedRequest =
      persistedBinding?.currentRequestKey === undefined
        ? undefined
        : persistedBinding.requests[persistedBinding.currentRequestKey];
    assert.equal(persistedRequest?.productUserMessageId, userMessage.messageId);
    assert.equal(persistedRequest?.productAssistantMessageId, assistantMessage.messageId);
    assert.equal(persistedRequest?.productRunId, "run_bridge1");
    assert.equal(persistedRequest?.workspaceInstructions, undefined);

    assert.deepEqual(
      requests.filter((request) => request.method === "POST").map((request) => request.path),
      ["/api/messages", "/api/runs/run_bridge1/decisions"],
    );
    assert.deepEqual(
      (
        requests.find((request) => request.path === "/api/messages")?.body as {
          payload?: unknown;
        }
      )?.payload,
      {
        text: userMessage.content.text,
        context: {
          workspaceInstructions: {
            schemaVersion: "workspace-instructions-input.v1",
            items: [{ content: "# AGENTS.md\n中文回复，并运行相关测试。" }],
          },
        },
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("reopening a persisted DSH history continues in the same Product Session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-history-resume-"));
  const statePath = join(directory, "state.json");
  const interactions = [
    {
      text: "第一轮：建立长期会话",
      userMessageId: "msg_resumeuser1",
      assistantMessageId: "msg_resumeassistant1",
      productRunId: "run_resume1",
      answer: "第一轮完成",
    },
    {
      text: "第二轮：重开后继续",
      userMessageId: "msg_resumeuser2",
      assistantMessageId: "msg_resumeassistant2",
      productRunId: "run_resume2",
      answer: "第二轮完成",
    },
  ] as const;
  let firstMessageCount = 0;
  const submissions: Array<{ sessionId: string; text: string }> = [];
  const submitTurn = (sessionId: string, text: string) => {
    const item = interactions.find((candidate) => candidate.text === text);
    assert.ok(item !== undefined);
    submissions.push({ sessionId, text });
    return {
      message: {
        schemaVersion,
        messageId: item.userMessageId,
        sessionId,
        sessionSequence: item === interactions[0] ? 1 : 3,
        role: "user" as const,
        content: { format: "markdown" as const, text },
        sha256: "d".repeat(64),
        createdAt: timestamp,
      },
      run: {
        schemaVersion,
        productRunId: item.productRunId,
        sessionId,
        sourceMessageId: item.userMessageId,
        status: "succeeded" as const,
        phase: "completed" as const,
        finalMessageId: item.assistantMessageId,
        allowedActions: [],
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    };
  };
  const chat = {
    submitFirstMessageFromDispatch: async (command: { payload: { text: string } }) => {
      firstMessageCount += 1;
      return {
        session: { ...session, title: interactions[0].text },
        ...submitTurn(session.sessionId, command.payload.text),
      };
    },
    submitMessageFromDispatch: async (sessionId: string, command: { payload: { text: string } }) =>
      submitTurn(sessionId, command.payload.text),
    getMessage: async (_sessionId: string, messageId: string) => {
      const item = interactions.find((candidate) => candidate.assistantMessageId === messageId);
      assert.ok(item !== undefined);
      return {
        schemaVersion,
        messageId: item.assistantMessageId,
        sessionId: session.sessionId,
        sessionSequence: item === interactions[0] ? 2 : 4,
        role: "assistant" as const,
        content: { format: "markdown" as const, text: item.answer },
        sourceRunId: item.productRunId,
        sha256: "e".repeat(64),
        createdAt: timestamp,
      };
    },
  } as unknown as ChatProductClient;
  const input = (text: string): GenerateOptions => ({
    provider: "lifeos",
    model: "workflow",
    sessionId: "dsh-history-1" as never,
    messages: [
      createUserMessage({
        source: { kind: "user" },
        content: [{ type: "text", text }],
      }),
    ],
  });

  try {
    const initialState = new AtomicBridgeStateStore(statePath);
    await initialState.ready();
    const first = await collect(
      new LifeosLlmAdapter(chat, initialState).stream(input(interactions[0].text)),
    );
    assert.equal(textDelta(first), interactions[0].answer);

    // 用全新的Store与Adapter实例模拟进程重启后从DSH历史侧栏重新打开同一会话。
    const reloadedState = new AtomicBridgeStateStore(statePath);
    await reloadedState.ready();
    const second = await collect(
      new LifeosLlmAdapter(chat, reloadedState).stream(input(interactions[1].text)),
    );
    assert.equal(textDelta(second), interactions[1].answer);

    assert.equal(firstMessageCount, 1);
    assert.deepEqual(submissions, [
      { sessionId: session.sessionId, text: interactions[0].text },
      { sessionId: session.sessionId, text: interactions[1].text },
    ]);
    const binding = await reloadedState.readSession("dsh-history-1");
    assert.equal(binding?.chatSessionId, session.sessionId);
    assert.equal(Object.keys(binding?.requests ?? {}).length, 2);
    assert.deepEqual(
      Object.values(binding?.requests ?? {})
        .map((request) => request.productRunId)
        .sort(),
      ["run_resume1", "run_resume2"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workflow selection draft is frozen per request and submitted with the next message", async () => {
  const messageSubmissions: Array<{ body: unknown } | undefined> = [];
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const requestBody = req.method === "POST" ? await body(req) : undefined;
      if (req.method === "POST" && url.pathname === "/api/messages") {
        messageSubmissions.push({ body: requestBody });
        json(res, { session, message: userMessage, run: run(true) });
      } else if (
        req.method === "POST" &&
        url.pathname === `/api/sessions/${session.sessionId}/messages`
      ) {
        messageSubmissions.push({ body: requestBody });
        json(res, { message: userMessage, run: run(true) });
      } else if (req.method === "GET" && url.pathname === "/api/runs/run_bridge1") {
        json(res, { run: run(true) });
      } else if (req.method === "GET" && url.pathname === "/api/runs/run_bridge1/plans") {
        json(res, { items: [] });
      } else if (
        req.method === "GET" &&
        url.pathname === "/api/runs/run_bridge1/approvals/current"
      ) {
        json(res, { approval: null });
      } else if (
        req.method === "GET" &&
        url.pathname === `/api/sessions/${session.sessionId}/messages/${assistantMessage.messageId}`
      ) {
        json(res, { message: assistantMessage });
      } else {
        res.statusCode = 404;
        res.end();
      }
    })().catch((error: unknown) => {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : "fixture failed");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-workflow-"));
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const chat = new ChatProductClient(new URL(`http://127.0.0.1:${address.port}`));
    const adapter = new LifeosLlmAdapter(chat, state);
    const bridge = new LifeosBridgeService(chat, state);

    const projected = await bridge.selectWorkflow(
      "dsh-session-1",
      workflowSelectionSchema.parse({
        workflowDefinitionRevisionId: "wfr_systemmemoryplanningv1",
        definitionSha256: "d".repeat(64),
        title: "Memory 增强规划与执行",
      }),
    );
    assert.equal(
      projected.workflowSelection?.workflowDefinitionRevisionId,
      "wfr_systemmemoryplanningv1",
    );

    const first = await collect(
      adapter.stream({
        provider: "lifeos",
        model: "workflow",
        sessionId: "dsh-session-1" as never,
        messages: [
          createUserMessage({
            source: { kind: "user" },
            content: [{ type: "text", text: "请把这段整理成笔记" }],
          }),
        ],
      }),
    );
    assert.ok(first.length > 0);

    // 发送前更换草稿：已提交请求保持原选择，下一次消息才使用新草稿。
    await bridge.selectWorkflow(
      "dsh-session-1",
      workflowSelectionSchema.parse({
        workflowDefinitionRevisionId: "wfr_systemplanningv2",
        definitionSha256: "e".repeat(64),
        title: "默认规划工作流",
      }),
    );
    const second = await collect(
      adapter.stream({
        provider: "lifeos",
        model: "workflow",
        sessionId: "dsh-session-1" as never,
        messages: [
          createUserMessage({
            source: { kind: "user" },
            content: [{ type: "text", text: "请制定并执行新的发布计划" }],
          }),
        ],
      }),
    );
    assert.ok(second.length > 0);

    assert.equal(messageSubmissions.length, 2);
    const firstPayload = (
      messageSubmissions[0]?.body as { payload?: { workflowSelection?: unknown } }
    )?.payload?.workflowSelection;
    const secondPayload = (
      messageSubmissions[1]?.body as { payload?: { workflowSelection?: unknown } }
    )?.payload?.workflowSelection;
    assert.deepEqual(firstPayload, {
      kind: "published_revision",
      workflowDefinitionRevisionId: "wfr_systemmemoryplanningv1",
      definitionSha256: "d".repeat(64),
    });
    assert.deepEqual(secondPayload, {
      kind: "published_revision",
      workflowDefinitionRevisionId: "wfr_systemplanningv2",
      definitionSha256: "e".repeat(64),
    });

    const binding = await state.readSession("dsh-session-1");
    const snapshots = Object.values(binding?.requests ?? {}).map(
      (request) => request.workflowSelection?.workflowDefinitionRevisionId ?? null,
    );
    assert.deepEqual(snapshots.sort(), ["wfr_systemmemoryplanningv1", "wfr_systemplanningv2"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});
