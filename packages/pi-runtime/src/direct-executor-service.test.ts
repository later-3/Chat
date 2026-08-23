import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { DirectAgentRunInput, DirectAgentRunner } from "./direct-agent-executor.js";
import {
  applyDirectAgentRuntimeApiKey,
  DirectAgentSuspendedError,
  P1_DIRECT_AGENT_PROFILE,
} from "./direct-agent-executor.js";
import { operationIdForDirectAgentAttempt } from "./direct-executor-identity.js";
import { PiDirectExecutorOperationStore } from "./direct-executor-operation-store.js";
import { createPiDirectExecutorServiceClient } from "./direct-executor-service-client.js";
import {
  PI_DIRECT_EXECUTOR_PROTOCOL_VERSION,
  type DirectPromptReviewRef,
  type StartPiDirectExecutorOperationRequest,
} from "./direct-executor-service-contract.js";
import {
  assertDirectExecutorWorkspaceGrant,
  PausableOperationTimeout,
  createPiDirectExecutorService,
} from "./direct-executor-service.js";
import { DirectAgentRuntimeCallbackError } from "./direct-runtime-api-callbacks.js";
import { hashExecutorValue } from "./executor-operation-store.js";
import { computeWorkspaceGrantSha256 } from "@chat/domain";
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

  constructor(private readonly resumedRuntimeManifestSha256 = "f".repeat(64)) {}

  async run(input: Parameters<DirectAgentRunner["run"]>[0]): Promise<string> {
    if (!input.resume) {
      await input.store.setSession({
        operationId: input.request.operationId,
        sessionId: "pis_directservice",
        enabledTools: ["read", "grep", "find", "ls"],
        resolvedRuntimeManifestSha256: "f".repeat(64),
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
    const active = input.store.getActivePromptReview(input.request.operationId);
    if (active === undefined) throw new Error("恢复缺少Prompt Review checkpoint");
    await input.store.setSession({
      operationId: input.request.operationId,
      sessionId: active.checkpoint.sessionId,
      enabledTools: ["read", "grep", "find", "ls"],
      resolvedRuntimeManifestSha256: this.resumedRuntimeManifestSha256,
      resumedFromCheckpointSha256: active.checkpoint.fileSha256,
    });
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
  it("Executor在runner前拒绝API冻结Grant与实际canonical Root不一致", () => {
    const assembly = {
      schemaVersion: "prompt-assembly.v2" as const,
      promptAssemblyId: "pma_workspacegrant",
      sha256: "7".repeat(64),
      systemPromptAppend: "",
      messages: [],
      tools: {
        capabilityMode: "custom" as const,
        names: ["read"],
        estimatedTokens: 8_000 as const,
      },
      requestOptions: {
        providerId: "dashscope-coding" as const,
        modelId: "qwen3.7-plus" as const,
        thinkingLevel: "off" as const,
        retryEnabled: false,
        compactionEnabled: false,
      },
      budget: {},
      workspaceRootId: "root_chat",
      workspaceGrantSha256: computeWorkspaceGrantSha256("/approved/workspace"),
    };
    expect(() =>
      assertDirectExecutorWorkspaceGrant(assembly, {
        rootId: "root_chat",
        canonicalPath: "/remapped/workspace",
      }),
    ).toThrowError(expect.objectContaining({ code: "direct_executor.workspace_grant_mismatch" }));
    expect(() =>
      assertDirectExecutorWorkspaceGrant(assembly, {
        rootId: "root_chat",
        canonicalPath: "/approved/workspace",
      }),
    ).not.toThrow();
  });

  it("Session恢复拒绝覆盖首次resolved runtime manifest SHA", async () => {
    const root = await temporaryRoot();
    const store = await PiDirectExecutorOperationStore.open(join(root, "operations"));
    const operationId = operationIdForDirectAgentAttempt("att_directservice");
    await store.createOrGet(
      { ...startIdentity(), operationId },
      {
        runRevision: 1,
        sourceMessageId: "msg_directservice" as never,
        sourceMessageSha256: "3".repeat(64),
        capabilityMode: "pi_cli_default",
        limits: {
          maxProviderRequests: 16,
          activeTimeoutMs: 1_200_000,
          tokenBudget: 64_000,
        },
      },
    );
    await store.markRunning(operationId);
    await store.setSession({
      operationId,
      sessionId: "pis_directservice",
      enabledTools: ["grep", "runtime_probe"],
      resolvedRuntimeManifestSha256: "a".repeat(64),
    });
    await expect(
      store.setSession({
        operationId,
        sessionId: "pis_directservice",
        enabledTools: ["grep", "runtime_probe"],
        resolvedRuntimeManifestSha256: "b".repeat(64),
        resumedFromCheckpointSha256: "c".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "direct_executor.runtime_manifest_mismatch" });

    expect(
      store
        .getEvents(operationId)
        .filter((event) => event.type === "session.started" || event.type === "session.resumed"),
    ).toEqual([
      expect.objectContaining({
        type: "session.started",
        enabledTools: ["grep", "runtime_probe"],
        resolvedRuntimeManifestSha256: "a".repeat(64),
      }),
    ]);
  });

  it("Session恢复允许与首次完全一致的resolved runtime manifest SHA", async () => {
    const root = await temporaryRoot();
    const store = await PiDirectExecutorOperationStore.open(join(root, "operations"));
    const operationId = operationIdForDirectAgentAttempt("att_directservice");
    await store.createOrGet(
      { ...startIdentity(), operationId },
      {
        runRevision: 1,
        sourceMessageId: "msg_directservice" as never,
        sourceMessageSha256: "3".repeat(64),
        capabilityMode: "pi_cli_default",
        limits: {
          maxProviderRequests: 16,
          activeTimeoutMs: 1_200_000,
          tokenBudget: 64_000,
        },
      },
    );
    await store.markRunning(operationId);
    for (const resumedFromCheckpointSha256 of [undefined, "c".repeat(64)]) {
      await store.setSession({
        operationId,
        sessionId: "pis_directservice",
        enabledTools: ["grep", "runtime_probe"],
        resolvedRuntimeManifestSha256: "a".repeat(64),
        ...(resumedFromCheckpointSha256 === undefined ? {} : { resumedFromCheckpointSha256 }),
      });
    }

    expect(
      store
        .getEvents(operationId)
        .filter((event) => event.type === "session.started" || event.type === "session.resumed"),
    ).toEqual([
      expect.objectContaining({
        type: "session.started",
        resolvedRuntimeManifestSha256: "a".repeat(64),
      }),
      expect.objectContaining({
        type: "session.resumed",
        resolvedRuntimeManifestSha256: "a".repeat(64),
      }),
    ]);
  });

  it("旧Operation无首次Hash时在首次恢复钉住，后续漂移仍失败关闭", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "operations");
    const operationId = operationIdForDirectAgentAttempt("att_directservice");
    const store = await PiDirectExecutorOperationStore.open(directory);
    const runner = new WaitingThenCompleteRunner();
    await store.createOrGet(
      { ...startIdentity(), operationId },
      {
        runRevision: 1,
        sourceMessageId: "msg_directservice" as never,
        sourceMessageSha256: "3".repeat(64),
        capabilityMode: "pi_cli_default",
        limits: {
          maxProviderRequests: 16,
          activeTimeoutMs: 1_200_000,
          tokenBudget: 64_000,
        },
      },
    );
    await store.markRunning(operationId);
    await store.setSession({
      operationId,
      sessionId: "pis_directservice",
      enabledTools: ["grep"],
      resolvedRuntimeManifestSha256: "a".repeat(64),
    });
    await store.beginPromptReview({
      operationId,
      publishCommandId: "cmd_directservicelegacypublish",
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
        fileName: "legacy-direct-service.jsonl",
        fileSha256: "c".repeat(64),
        sessionId: "pis_directservice",
        leafId: "leaf-legacy-direct-service",
      },
    });
    await store.markPromptReviewWaiting(operationId, runner.review, 2);

    const filePath = join(directory, `${operationId}.json`);
    const legacyRecord = z
      .object({
        resolvedRuntimeManifestSha256: z.string().optional(),
        events: z.array(z.record(z.string(), z.unknown())),
      })
      .passthrough()
      .parse(JSON.parse(await readFile(filePath, "utf8")));
    delete legacyRecord.resolvedRuntimeManifestSha256;
    for (const event of legacyRecord.events) {
      delete event["resolvedRuntimeManifestSha256"];
    }
    await writeFile(filePath, JSON.stringify(legacyRecord), { mode: 0o600 });

    const recovered = await PiDirectExecutorOperationStore.open(directory);
    await recovered.setSession({
      operationId,
      sessionId: "pis_directservice",
      enabledTools: ["grep"],
      resolvedRuntimeManifestSha256: "d".repeat(64),
      resumedFromCheckpointSha256: "c".repeat(64),
    });
    await expect(
      recovered.setSession({
        operationId,
        sessionId: "pis_directservice",
        enabledTools: ["grep"],
        resolvedRuntimeManifestSha256: "e".repeat(64),
        resumedFromCheckpointSha256: "c".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "direct_executor.runtime_manifest_mismatch" });
    expect(
      recovered
        .getEvents(operationId)
        .filter((event) => event.type === "session.resumed")
        .map((event) => event.resolvedRuntimeManifestSha256),
    ).toEqual(["d".repeat(64)]);
  });

  it("Chat显式百炼Key只注册为Pi进程内runtime override", async () => {
    const setRuntimeApiKey = vi.fn(async () => undefined);
    const signal = new AbortController().signal;
    await applyDirectAgentRuntimeApiKey({
      modelRuntime: { setRuntimeApiKey },
      environment: { DASHSCOPE_API_KEY: "  e2e-runtime-key  " },
      providerId: "dashscope-coding",
      signal,
    });
    expect(setRuntimeApiKey).toHaveBeenCalledWith("dashscope-coding", "e2e-runtime-key", {
      signal,
    });
  });

  it("未配置Chat百炼Key时保留Pi自己的认证链", async () => {
    const setRuntimeApiKey = vi.fn(async () => undefined);
    await applyDirectAgentRuntimeApiKey({
      modelRuntime: { setRuntimeApiKey },
      environment: { DASHSCOPE_API_KEY: "  " },
      providerId: "dashscope-coding",
      signal: new AbortController().signal,
    });
    expect(setRuntimeApiKey).not.toHaveBeenCalled();
  });

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

  it("Prompt Assembly V2把正式历史保持原role交给同一个Pi Session", async () => {
    const root = await temporaryRoot();
    const store = await PiDirectExecutorOperationStore.open(join(root, "operations"));
    let received: DirectAgentRunInput | undefined;
    const runner: DirectAgentRunner = {
      run: async (input) => {
        received = input;
        return "V2完成";
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
      authorizeOperation: async (input) => ({
        productRunId: input.productRunId,
        directAgentAttemptId: input.directAgentAttemptId,
        runRevision: 1,
        sourceMessage: {
          messageId: "msg_directservicecurrent",
          text: "当前问题",
          sha256: "3".repeat(64),
        },
        promptAssembly: {
          schemaVersion: "prompt-assembly.v2",
          promptAssemblyId: "pma_directservicev2",
          sha256: "7".repeat(64),
          systemPromptAppend: "## 规则\n只读检查",
          piSystemPrompt: {
            kind: "pi_coding_agent",
            mode: "replace",
            bodyMarkdown: "DIRECT_CUSTOM_SYSTEM_PROMPT",
            sha256: "6".repeat(64),
          },
          messages: [
            {
              role: "user",
              text: "上一问",
              source: {
                kind: "product_message",
                messageId: "msg_directservicehistoryuser",
                sessionSequence: 1,
                sha256: "8".repeat(64),
              },
              estimatedTokens: 3,
            },
            {
              role: "assistant",
              text: "上一答",
              source: {
                kind: "product_message",
                messageId: "msg_directservicehistoryassistant",
                sessionSequence: 2,
                sha256: "9".repeat(64),
              },
              estimatedTokens: 3,
            },
            {
              role: "user",
              text: "当前问题",
              source: {
                kind: "current_input",
                messageId: "msg_directservicecurrent",
                sessionSequence: 3,
                sha256: "3".repeat(64),
              },
              estimatedTokens: 4,
            },
          ],
          tools: {
            capabilityMode: "read_only",
            names: ["read", "grep", "find", "ls"],
            estimatedTokens: 8_000,
          },
          requestOptions: {
            providerId: "dashscope-coding",
            modelId: "qwen3.7-plus",
            thinkingLevel: "off",
            retryEnabled: false,
            compactionEnabled: false,
          },
          budget: {
            meterVersion: "utf8-bytes-div-3.v1",
            inputTokenLimit: 64_000,
            instructionsEstimatedTokens: 5,
            messagesEstimatedTokens: 10,
            toolsEstimatedTokens: 8_000,
            totalEstimatedTokens: 8_015,
            excludedHistoryMessageIds: [],
          },
        },
        capabilityMode: "read_only",
        promptReviewMode: "manual",
        limits: {
          maxProviderRequests: 16,
          activeTimeoutMs: 1_200_000,
          tokenBudget: 64_000,
        },
      }),
      promptReviewProduct: {
        publish: async () => {
          throw new Error("Immediate runner不发布Review");
        },
        consumeDecision: async () => {
          throw new Error("Immediate runner不消费Decision");
        },
        commitDispatchOutcome: async () => undefined,
      },
      publishResult: async () => ({
        directAgentCandidateId: "drc_directservicev2" as never,
        sha256: hashExecutorValue("V2完成"),
      }),
      runner,
    });
    const client = createPiDirectExecutorServiceClient({
      baseUrl: "http://pi-direct.test",
      credential: "rtk_directservice123",
      pollIntervalMs: 1,
      fetchFn: async (url, init) => runtime.app.request(url, init),
    });
    const response = await client.start(startIdentity());
    expect(response.kind).toBe("succeeded");
    expect(received?.prompt).toBe("当前问题");
    expect(received?.history).toEqual([
      { role: "user", text: "上一问" },
      { role: "assistant", text: "上一答" },
    ]);
    expect(received?.systemPromptAppend).toBe("## 规则\n只读检查");
    expect(received?.piSystemPrompt).toEqual({
      kind: "pi_coding_agent",
      mode: "replace",
      bodyMarkdown: "DIRECT_CUSTOM_SYSTEM_PROMPT",
      sha256: "6".repeat(64),
    });
    await runtime.close();
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
            schemaVersion: "prompt-assembly.v1",
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

  it("resume运行清单漂移在Provider前形成稳定failed终态", async () => {
    const root = await temporaryRoot();
    const store = await PiDirectExecutorOperationStore.open(join(root, "operations"));
    const runner = new WaitingThenCompleteRunner("e".repeat(64));
    let providerDispatchCommitted = false;
    const runtime = createPiDirectExecutorService({
      credential: "rtk_directservice123",
      store,
      workspaceRoots: new Map(),
      emptyWorkspaceRoot: join(root, "empty"),
      agentDir: join(root, "agent"),
      sessionsDir: join(root, "sessions"),
      checkpointsDir: join(root, "checkpoints"),
      authorizeOperation: async (input) => ({
        productRunId: input.productRunId,
        directAgentAttemptId: input.directAgentAttemptId,
        runRevision: 1,
        sourceMessage: {
          messageId: "msg_directservice",
          text: PRIVATE_SOURCE,
          sha256: "3".repeat(64),
        },
        promptAssembly: {
          schemaVersion: "prompt-assembly.v1",
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
      }),
      promptReviewProduct: {
        publish: async () => {
          throw new Error("Fake runner不调用publish");
        },
        consumeDecision: async (input) => ({
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
        }),
        commitDispatchOutcome: async () => {
          providerDispatchCommitted = true;
        },
      },
      publishResult: async () => {
        throw new Error("运行清单漂移后不能发布Candidate");
      },
      runner,
    });
    const client = createPiDirectExecutorServiceClient({
      baseUrl: "http://pi-direct.test",
      credential: "rtk_directservice123",
      pollIntervalMs: 1,
      fetchFn: async (url, init) => runtime.app.request(url, init),
    });

    const waiting = await client.start(startIdentity());
    if (waiting.kind !== "waiting_prompt_review") throw new Error("测试缺少审核等待态");
    const failed = await client.submitDecision({
      operationId: waiting.operationId,
      review: waiting.review,
      promptReviewDecisionId: "prd_directservicedrift",
    });

    expect(failed).toEqual({
      kind: "failed",
      operationId: waiting.operationId,
      errorCode: "direct_executor.runtime_manifest_mismatch",
    });
    expect(providerDispatchCommitted).toBe(false);
    expect(
      store.getEvents(waiting.operationId).some((event) => event.type === "provider.started"),
    ).toBe(false);
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
