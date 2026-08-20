import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectAgentRunner } from "./direct-agent-executor.js";
import { DirectAgentSuspendedError, P1_DIRECT_AGENT_PROFILE } from "./direct-agent-executor.js";
import { operationIdForDirectAgentAttempt } from "./direct-executor-identity.js";
import { PiDirectExecutorOperationStore } from "./direct-executor-operation-store.js";
import { createPiDirectExecutorServiceClient } from "./direct-executor-service-client.js";
import {
  PI_DIRECT_EXECUTOR_PROTOCOL_VERSION,
  type DirectPromptReviewRef,
  type StartPiDirectExecutorOperationRequest,
} from "./direct-executor-service-contract.js";
import {
  PausableOperationTimeout,
  createPiDirectExecutorService,
} from "./direct-executor-service.js";
import { DirectAgentRuntimeCallbackError } from "./direct-runtime-api-callbacks.js";
import { hashExecutorValue } from "./executor-operation-store.js";
import {
  hashFinalProviderPayload,
  hashPromptReviewEnvelope,
  type DirectPromptReviewProductPort,
} from "./prompt-review-gate.js";

const PRIVATE_SOURCE = "PRIVATE_DIRECT_SOURCE_MUST_NOT_ENTER_OPERATION";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chat-pi-direct-service-"));
  roots.push(root);
  return root;
}

const providerPayload = {
  model: "direct-test-model",
  messages: [{ role: "user", content: PRIVATE_SOURCE }],
};

function startIdentity(): Omit<StartPiDirectExecutorOperationRequest, "operationId"> {
  return {
    schemaVersion: PI_DIRECT_EXECUTOR_PROTOCOL_VERSION,
    productRunId: "run_directservice" as never,
    directAgentAttemptId: "att_directservice" as never,
    workflowRunSpecId: "wrs_directservice" as never,
    workflowRunSpecSha256: "1".repeat(64),
    inputManifestSha256: "2".repeat(64),
  };
}

class WaitingThenCompleteRunner implements DirectAgentRunner {
  readonly review: DirectPromptReviewRef = {
    promptReviewRequestId: "prr_directservice" as never,
    requestRevision: 1,
    revision: 1,
    requestIndex: 1,
    payloadSha256: hashFinalProviderPayload(providerPayload),
    reviewSha256: "4".repeat(64),
  };

  async run(input: Parameters<DirectAgentRunner["run"]>[0]): Promise<string> {
    if (!input.resume) {
      await input.store.setSession({
        operationId: input.request.operationId,
        sessionId: "pis_directservice",
        enabledTools: ["read", "grep", "find", "ls"],
      });
      await input.store.beginPromptReview({
        operationId: input.request.operationId,
        publishCommandId: "cmd_directservicepublish",
        payloadSha256: this.review.payloadSha256,
        payloadEnvelopeSha256: hashPromptReviewEnvelope({
          providerId: "openai",
          modelId: "direct-test-model",
          endpointHost: "provider.example",
          payload: providerPayload,
        }),
        providerId: "openai",
        modelId: "direct-test-model",
        endpointHost: "provider.example",
        checkpoint: {
          fileName: "direct-service.jsonl",
          fileSha256: "5".repeat(64),
          sessionId: "pis_directservice",
          leafId: "leaf-direct-service",
        },
      });
      await input.store.markPromptReviewWaiting(input.request.operationId, this.review, 2);
      throw new DirectAgentSuspendedError();
    }
    await input.store.markProviderDispatching(input.request.operationId);
    await input.promptReview.markProviderSettled({
      operationId: input.request.operationId,
      completionTokens: 7,
      stopReason: "stop",
    });
    return "已审核的Direct Agent结果";
  }
}

describe("Pi Direct Executor Service + Client", () => {
  it("V1固定只读工具、关闭thinking/retry/compaction/外部扩展", () => {
    expect(P1_DIRECT_AGENT_PROFILE).toEqual({
      providerId: "dashscope-coding",
      modelId: "qwen3.7-plus",
      capabilityMode: "read_only",
      enabledTools: ["read", "grep", "find", "ls"],
      thinkingLevel: "off",
      retryEnabled: false,
      compactionEnabled: false,
      branchSummarySkipPrompt: true,
      noExtensions: true,
    });
  });

  it("Prompt Review等待不计入active timeout", () => {
    vi.useFakeTimers();
    try {
      let timedOut = false;
      const timeout = new PausableOperationTimeout(1_000, () => {
        timedOut = true;
      });
      vi.advanceTimersByTime(400);
      timeout.pause();
      vi.advanceTimersByTime(60_000);
      expect(timedOut).toBe(false);
      timeout.resume();
      vi.advanceTimersByTime(599);
      expect(timedOut).toBe(false);
      vi.advanceTimersByTime(1);
      expect(timedOut).toBe(true);
      timeout.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("start只携Manifest证据，decision单次consume后恢复并回写dispatch outcome", async () => {
    const root = await temporaryRoot();
    const store = await PiDirectExecutorOperationStore.open(join(root, "operations"));
    const runner = new WaitingThenCompleteRunner();
    let authorizeCalls = 0;
    let consumeCalls = 0;
    const dispatchOutcomes: string[] = [];
    const product: DirectPromptReviewProductPort = {
      publish: async () => {
        throw new Error("Fake runner不调用publish");
      },
      consumeDecision: async (input) => {
        consumeCalls += 1;
        return {
          status: "authorized",
          review: input.review,
          decision: {
            promptReviewDecisionId: input.promptReviewDecisionId as never,
            revision: 1,
            decisionSha256: "6".repeat(64),
            kind: "approve",
          },
          productRunRevision: 3,
          frozenPayload: providerPayload,
        };
      },
      commitDispatchOutcome: async (input) => {
        dispatchOutcomes.push(input.outcome);
      },
    };
    const runtime = createPiDirectExecutorService({
      credential: "rtk_directservice123",
      store,
      workspaceRoots: new Map(),
      emptyWorkspaceRoot: join(root, "empty"),
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      checkpointsDir: join(root, "checkpoints"),
      authorizeOperation: async (input) => {
        authorizeCalls += 1;
        return {
          productRunId: input.productRunId,
          directAgentAttemptId: input.directAgentAttemptId,
          runRevision: 1,
          sourceMessage: {
            messageId: "msg_directservice",
            text: PRIVATE_SOURCE,
            sha256: "3".repeat(64),
          },
          promptAssembly: {
            promptAssemblyId: "pma_directservice",
            sha256: "7".repeat(64),
            systemPromptAppend: "",
            userPrompt: PRIVATE_SOURCE,
          },
          capabilityMode: "read_only",
          promptReviewMode: "manual",
          limits: {
            maxProviderRequests: 16,
            activeTimeoutMs: 1_200_000,
            tokenBudget: 64_000,
          },
        };
      },
      promptReviewProduct: product,
      publishResult: async (input) => ({
        directAgentCandidateId: "drc_directservice" as never,
        sha256: hashExecutorValue(input.output),
      }),
      runner,
    });
    const client = createPiDirectExecutorServiceClient({
      baseUrl: "http://pi-direct.test",
      credential: "rtk_directservice123",
      pollIntervalMs: 1,
      fetchFn: async (url, init) => runtime.app.request(url, init),
    });

    const waiting = await client.start(startIdentity());
    expect(waiting).toMatchObject({ kind: "waiting_prompt_review", review: runner.review });
    if (waiting.kind !== "waiting_prompt_review") throw new Error("测试缺少审核等待态");
    const completed = await client.submitDecision({
      operationId: waiting.operationId,
      review: waiting.review,
      promptReviewDecisionId: "prd_directservice",
    });

    expect(completed).toMatchObject({
      kind: "succeeded",
      result: { directAgentCandidateId: "drc_directservice" },
    });
    // 创建Operation、首次Session和checkpoint恢复都重新读取权威Assembly；正文不进Journal。
    expect(authorizeCalls).toBe(3);
    expect(consumeCalls).toBe(1);
    expect(dispatchOutcomes).toEqual(["dispatched"]);
    const operationFile = await readFile(
      join(root, "operations", `${waiting.operationId}.json`),
      "utf8",
    );
    expect(operationFile).not.toContain(PRIVATE_SOURCE);
    expect(operationFile).not.toContain("已审核的Direct Agent结果");
    await runtime.close();
  });

  it("拒绝Attempt未绑定的Operation ID且不调用Application授权", async () => {
    const root = await temporaryRoot();
    const store = await PiDirectExecutorOperationStore.open(join(root, "operations"));
    let authorizeCalls = 0;
    const runtime = createPiDirectExecutorService({
      credential: "rtk_directservice123",
      store,
      workspaceRoots: new Map(),
      emptyWorkspaceRoot: join(root, "empty"),
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      checkpointsDir: join(root, "checkpoints"),
      authorizeOperation: async () => {
        authorizeCalls += 1;
        throw new Error("不应调用");
      },
      promptReviewProduct: {
        publish: async () => {
          throw new Error("不应调用");
        },
        consumeDecision: async () => {
          throw new Error("不应调用");
        },
        commitDispatchOutcome: async () => {
          throw new Error("不应调用");
        },
      },
      publishResult: async () => {
        throw new Error("不应调用");
      },
      runner: new WaitingThenCompleteRunner(),
    });
    const response = await runtime.app.request(
      "http://pi-direct.test/internal/pi-direct-executor/v1/operations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-chat-runtime-key": "rtk_directservice123",
        },
        body: JSON.stringify({ ...startIdentity(), operationId: "pio_wrongidentity" }),
      },
    );
    expect(response.status).toBe(409);
    expect(authorizeCalls).toBe(0);
    expect(() =>
      store.getSnapshot(operationIdForDirectAgentAttempt("att_directservice")),
    ).toThrow();
    await runtime.close();
  });

  it("consume网络结果未知立即收敛permit outcome_unknown，不遗留永久waiting", async () => {
    const root = await temporaryRoot();
    const operationId = operationIdForDirectAgentAttempt("att_directservice");
    const store = await PiDirectExecutorOperationStore.open(join(root, "operations"));
    const runner = new WaitingThenCompleteRunner();
    await store.createOrGet(
      { ...startIdentity(), operationId },
      {
        runRevision: 1,
        sourceMessageId: "msg_directservice" as never,
        sourceMessageSha256: "3".repeat(64),
        capabilityMode: "read_only",
        limits: {
          maxProviderRequests: 16,
          activeTimeoutMs: 1_200_000,
          tokenBudget: 64_000,
        },
      },
    );
    await store.markRunning(operationId);
    await store.beginPromptReview({
      operationId,
      publishCommandId: "cmd_directservicepublish",
      payloadSha256: runner.review.payloadSha256,
      payloadEnvelopeSha256: hashPromptReviewEnvelope({
        providerId: "openai",
        modelId: "direct-test-model",
        endpointHost: "provider.example",
        payload: providerPayload,
      }),
      providerId: "openai",
      modelId: "direct-test-model",
      endpointHost: "provider.example",
      checkpoint: {
        fileName: "direct-service.jsonl",
        fileSha256: "5".repeat(64),
        sessionId: "pis_directservice",
        leafId: "leaf-direct-service",
      },
    });
    await store.markPromptReviewWaiting(operationId, runner.review, 2);
    const dispatchOutcomes: string[] = [];
    const runtime = createPiDirectExecutorService({
      credential: "rtk_directservice123",
      store,
      workspaceRoots: new Map(),
      emptyWorkspaceRoot: join(root, "empty"),
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      checkpointsDir: join(root, "checkpoints"),
      authorizeOperation: async () => {
        throw new Error("不应调用");
      },
      promptReviewProduct: {
        publish: async () => {
          throw new Error("不应调用");
        },
        consumeDecision: async () => {
          throw new DirectAgentRuntimeCallbackError(
            "direct_runtime.callback_outcome_unknown",
            true,
          );
        },
        commitDispatchOutcome: async (input) => {
          dispatchOutcomes.push(input.outcome);
        },
      },
      publishResult: async () => {
        throw new Error("不应调用");
      },
      runner,
    });
    const response = await runtime.app.request(
      `http://pi-direct.test/internal/pi-direct-executor/v1/operations/${operationId}/prompt-review-decisions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-chat-runtime-key": "rtk_directservice123",
        },
        body: JSON.stringify({
          schemaVersion: PI_DIRECT_EXECUTOR_PROTOCOL_VERSION,
          promptReviewRequestId: runner.review.promptReviewRequestId,
          requestRevision: runner.review.requestRevision,
          reviewSha256: runner.review.reviewSha256,
          payloadSha256: runner.review.payloadSha256,
          promptReviewDecisionId: "prd_directserviceunknown",
        }),
      },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: "outcome_unknown",
      errorCode: "direct_executor.provider_permit_outcome_unknown",
    });
    expect(dispatchOutcomes).toEqual(["outcome_unknown"]);
    await runtime.close();
  });

  it("重启发现waiting+approve时不再等待丢失的内存正文，直接收敛permit未知", async () => {
    const root = await temporaryRoot();
    const operationId = operationIdForDirectAgentAttempt("att_directservice");
    const directory = join(root, "operations");
    const firstStore = await PiDirectExecutorOperationStore.open(directory);
    const runner = new WaitingThenCompleteRunner();
    await firstStore.createOrGet(
      { ...startIdentity(), operationId },
      {
        runRevision: 1,
        sourceMessageId: "msg_directservice" as never,
        sourceMessageSha256: "3".repeat(64),
        capabilityMode: "read_only",
        limits: {
          maxProviderRequests: 16,
          activeTimeoutMs: 1_200_000,
          tokenBudget: 64_000,
        },
      },
    );
    await firstStore.markRunning(operationId);
    await firstStore.beginPromptReview({
      operationId,
      publishCommandId: "cmd_directservicepublish",
      payloadSha256: runner.review.payloadSha256,
      payloadEnvelopeSha256: hashPromptReviewEnvelope({
        providerId: "openai",
        modelId: "direct-test-model",
        endpointHost: "provider.example",
        payload: providerPayload,
      }),
      providerId: "openai",
      modelId: "direct-test-model",
      endpointHost: "provider.example",
      checkpoint: {
        fileName: "direct-service.jsonl",
        fileSha256: "5".repeat(64),
        sessionId: "pis_directservice",
        leafId: "leaf-direct-service",
      },
    });
    await firstStore.markPromptReviewWaiting(operationId, runner.review, 2);
    await firstStore.bindPromptReviewDecision(
      operationId,
      {
        promptReviewDecisionId: "prd_directservicecrash" as never,
        revision: 1,
        decisionSha256: "6".repeat(64),
        kind: "approve",
      },
      3,
    );

    const recoveredStore = await PiDirectExecutorOperationStore.open(directory);
    const dispatchOutcomes: string[] = [];
    const runtime = createPiDirectExecutorService({
      credential: "rtk_directservice123",
      store: recoveredStore,
      workspaceRoots: new Map(),
      emptyWorkspaceRoot: join(root, "empty"),
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      checkpointsDir: join(root, "checkpoints"),
      authorizeOperation: async () => {
        throw new Error("不应调用");
      },
      promptReviewProduct: {
        publish: async () => {
          throw new Error("不应调用");
        },
        consumeDecision: async () => {
          throw new Error("不应再次消费permit");
        },
        commitDispatchOutcome: async (input) => {
          dispatchOutcomes.push(input.outcome);
        },
      },
      publishResult: async () => {
        throw new Error("不应调用");
      },
      runner,
    });
    await runtime.recover();

    expect(recoveredStore.getSnapshot(operationId)).toMatchObject({
      status: "outcome_unknown",
      errorCode: "direct_executor.provider_permit_outcome_unknown",
    });
    expect(dispatchOutcomes).toEqual(["outcome_unknown"]);
    await runtime.close();
  });
});
