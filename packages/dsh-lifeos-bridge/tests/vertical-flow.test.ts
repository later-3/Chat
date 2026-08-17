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
      if (req.method === "POST" && url.pathname === "/api/sessions") {
        json(res, { session });
      } else if (
        req.method === "POST" &&
        url.pathname === `/api/sessions/${session.sessionId}/messages`
      ) {
        submittedResolve();
        json(res, { message: userMessage, run: run(false) });
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

    assert.deepEqual(
      requests.filter((request) => request.method === "POST").map((request) => request.path),
      [
        "/api/sessions",
        `/api/sessions/${session.sessionId}/messages`,
        "/api/runs/run_bridge1/decisions",
      ],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test("workflow selection draft is frozen per request and submitted with the next message", async () => {
  const messageSubmissions: Array<{ body: unknown } | undefined> = [];
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const requestBody = req.method === "POST" ? await body(req) : undefined;
      if (req.method === "POST" && url.pathname === "/api/sessions") {
        json(res, { session });
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
      } else if (req.method === "GET" && url.pathname === "/api/runs/run_bridge1/approvals/current") {
        json(res, { approval: null });
      } else if (req.method === "GET" && url.pathname === `/api/sessions/${session.sessionId}/messages/${assistantMessage.messageId}`) {
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
        workflowDefinitionRevisionId: "wfr_systemnotev1",
        definitionSha256: "d".repeat(64),
        title: "默认笔记工作流",
      }),
    );
    assert.equal(projected.workflowSelection?.workflowDefinitionRevisionId, "wfr_systemnotev1");

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
    const firstPayload = (messageSubmissions[0]?.body as { payload?: { workflowSelection?: unknown } })
      ?.payload?.workflowSelection;
    const secondPayload = (messageSubmissions[1]?.body as { payload?: { workflowSelection?: unknown } })
      ?.payload?.workflowSelection;
    assert.deepEqual(firstPayload, {
      kind: "published_revision",
      workflowDefinitionRevisionId: "wfr_systemnotev1",
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
    assert.deepEqual(snapshots.sort(), ["wfr_systemnotev1", "wfr_systemplanningv2"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});
