import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ApprovalDto,
  CommandId,
  DecisionDto,
  MessageDto,
  MemoryBackendProfileDto,
  PlanDto,
  RunContextDto,
  RunDto,
  SessionDto,
} from "@chat/contracts/public";
import {
  apiCreateSession,
  apiGetCurrentApproval,
  apiGetMessages,
  apiGetMemoryBackends,
  apiGetPlans,
  apiGetRun,
  apiGetRunContext,
  apiSubmitDecision,
  apiSubmitMessage,
} from "./client.js";

const now = "2026-08-07T12:00:00.000Z";
const session: SessionDto = {
  schemaVersion: "chat-product-api.v1",
  sessionId: "psn_client" as never,
  status: "active",
  revision: 1,
  createdAt: now,
  updatedAt: now,
};
const message: MessageDto = {
  schemaVersion: "chat-product-api.v1",
  messageId: "msg_client" as never,
  sessionId: session.sessionId,
  sessionSequence: 1,
  role: "user",
  content: { format: "markdown", text: "目标" },
  sha256: "a".repeat(64),
  createdAt: now,
};
const run: RunDto = {
  schemaVersion: "chat-product-api.v1",
  productRunId: "run_client" as never,
  sessionId: session.sessionId,
  sourceMessageId: message.messageId,
  status: "pending",
  phase: "queued",
  maxPlanRevisions: 5,
  allowedActions: [],
  revision: 1,
  createdAt: now,
  updatedAt: now,
};
const plan: PlanDto = {
  schemaVersion: "chat-product-api.v1",
  planId: "pln_client" as never,
  planRevision: 1,
  status: "under_review",
  sha256: "a".repeat(64),
  content: {
    objective: "完成目标",
    summary: "先规划再执行",
    assumptions: [],
    openQuestions: [],
    steps: [
      {
        stepId: "step-1",
        title: "执行",
        purpose: "完成目标",
        dependsOn: [],
        inputRefs: [],
        expectedOutput: "结果",
        successCriteria: ["结果可读"],
        requestedCapabilities: [],
        risk: "low",
      },
    ],
    completionCriteria: ["结果可读"],
    warnings: [],
  },
  createdAt: now,
  updatedAt: now,
};
const approval: ApprovalDto = {
  schemaVersion: "chat-product-api.v1",
  approvalRequestId: "apr_client" as never,
  productRunId: run.productRunId,
  planId: plan.planId,
  planRevision: 1,
  planSha256: plan.sha256,
  status: "open",
  createdAt: now,
  expiresAt: "2026-08-08T12:00:00.000Z",
};
const decision: DecisionDto = {
  schemaVersion: "chat-product-api.v1",
  decisionId: "dec_client" as never,
  approvalRequestId: approval.approvalRequestId,
  productRunId: run.productRunId,
  planId: plan.planId,
  planRevision: 1,
  planSha256: plan.sha256,
  kind: "approve",
  createdAt: now,
};
const commandId = "cmd_client" as CommandId;
const backend: MemoryBackendProfileDto = {
  schemaVersion: "chat-product-api.v1",
  backendId: "mbk_memmy" as never,
  displayName: "memmy",
  kind: "memmy",
  configured: true,
  health: "ready",
  capabilities: {
    query: true,
    tags: true,
    layers: ["L1", "L2"],
    maxLimit: 20,
    maxContextBudget: 8_192,
  },
};
const runContext: RunContextDto = {
  schemaVersion: "chat-product-api.v1",
  productRunId: run.productRunId,
  memory: {
    backendId: backend.backendId,
    requirement: "optional",
    queryStatus: "pending",
    memoryQueryId: "mqy_client" as never,
  },
};

function respond(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("公开API浏览器响应边界", () => {
  it.each([
    ["CreateSession", () => apiCreateSession(commandId), { session, runtimeSecret: "forbidden" }],
    [
      "SubmitMessage",
      () => apiSubmitMessage(session.sessionId, commandId, { text: "目标" }),
      { message, run, runtimeSecret: "forbidden" },
    ],
    [
      "SubmitDecision",
      () =>
        apiSubmitDecision({
          productRunId: run.productRunId,
          commandId,
          expectedRunRevision: 1,
          payload: {
            approvalRequestId: approval.approvalRequestId,
            planId: plan.planId,
            planRevision: 1,
            planSha256: plan.sha256,
            kind: "approve",
          },
        }),
      { decision, run, runtimeSecret: "forbidden" },
    ],
  ])("%s的2xx响应根损坏时按命令结果未知失败关闭", async (_name, request, body) => {
    respond(body);
    await expect(request()).rejects.toMatchObject({
      name: "ApiProblemError",
      code: "network_unknown",
      retryable: true,
      recoveryAction: "retry_same_command",
    });
  });

  it.each([
    [
      "Messages",
      () => apiGetMessages(session.sessionId),
      { items: [message], runtimeSecret: "forbidden" },
    ],
    ["Run", () => apiGetRun(run.productRunId), { run, runtimeSecret: "forbidden" }],
    [
      "MemoryBackends",
      () => apiGetMemoryBackends(),
      { backends: [backend], runtimeSecret: "forbidden" },
    ],
    [
      "RunContext",
      () => apiGetRunContext(run.productRunId),
      { context: runContext, runtimeSecret: "forbidden" },
    ],
    ["Plans", () => apiGetPlans(run.productRunId), { items: [plan], runtimeSecret: "forbidden" }],
    [
      "Approval",
      () => apiGetCurrentApproval(run.productRunId),
      { approval, runtimeSecret: "forbidden" },
    ],
  ])("%s查询响应根出现未声明字段时失败关闭", async (_name, request, body) => {
    respond(body);
    await expect(request()).rejects.toMatchObject({ name: "ZodError" });
  });
});
