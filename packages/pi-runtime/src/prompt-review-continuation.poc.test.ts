import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashCanonical } from "@chat/domain";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";

/**
 * P0能力探针：只验证固定Pi工件能否在最终Provider Payload边界暂停，并从持久
 * Session恢复未完成Turn。它不接入Product Store、Workflow或生产Executor协议。
 */

type ReviewStatus = "open" | "approved" | "rejected";

interface ReviewRecord {
  readonly reviewId: string;
  readonly requestIndex: number;
  readonly payload: unknown;
  readonly payloadSha256: string;
  status: ReviewStatus;
  permitConsumed: boolean;
}

interface GateSnapshot {
  readonly schemaVersion: "prompt-review-gate-poc.v1";
  readonly records: ReviewRecord[];
}

interface PendingWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

class ReviewRejectedError extends Error {
  constructor() {
    super("prompt review rejected");
    this.name = "ReviewRejectedError";
  }
}

class SimulatedProcessLossError extends Error {
  constructor() {
    super("simulated executor process loss");
    this.name = "SimulatedProcessLossError";
  }
}

class DurablePromptReviewGateProbe {
  private readonly waiters = new Map<string, PendingWaiter>();

  private constructor(
    private readonly statePath: string,
    private snapshot: GateSnapshot,
  ) {}

  static open(statePath: string): DurablePromptReviewGateProbe {
    if (!existsSync(statePath)) {
      const snapshot: GateSnapshot = {
        schemaVersion: "prompt-review-gate-poc.v1",
        records: [],
      };
      writeFileSync(statePath, JSON.stringify(snapshot), { mode: 0o600 });
      return new DurablePromptReviewGateProbe(statePath, snapshot);
    }
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as GateSnapshot;
    if (parsed.schemaVersion !== "prompt-review-gate-poc.v1" || !Array.isArray(parsed.records)) {
      throw new Error("prompt review probe store is invalid");
    }
    return new DurablePromptReviewGateProbe(statePath, parsed);
  }

  records(): readonly ReviewRecord[] {
    return structuredClone(this.snapshot.records);
  }

  async intercept(payload: unknown): Promise<unknown> {
    const normalized = JSON.parse(JSON.stringify(payload)) as unknown;
    const payloadSha256 = computePayloadSha256(normalized);
    let record = this.snapshot.records.find((candidate) => !candidate.permitConsumed);
    if (record === undefined) {
      const requestIndex = this.snapshot.records.length + 1;
      record = {
        reviewId: `p0-review-${String(requestIndex)}`,
        requestIndex,
        payload: normalized,
        payloadSha256,
        status: "open",
        permitConsumed: false,
      };
      this.snapshot.records.push(record);
      this.persist();
    } else if (record.payloadSha256 !== payloadSha256) {
      throw new Error("provider_request_drift");
    }

    if (record.status === "open") await this.waitForDecision(record.reviewId);
    const current = this.requireRecord(record.reviewId);
    if (current.status === "rejected") throw new ReviewRejectedError();
    if (current.status !== "approved") throw new Error("prompt review decision missing");
    if (current.permitConsumed) throw new Error("prompt review permit already consumed");
    current.permitConsumed = true;
    this.persist();
    return structuredClone(current.payload);
  }

  approve(reviewId: string, payloadSha256: string): void {
    const record = this.requireRecord(reviewId);
    if (record.payloadSha256 !== payloadSha256) throw new Error("prompt review hash mismatch");
    if (record.status === "rejected") throw new Error("prompt review already rejected");
    if (record.status === "open") {
      record.status = "approved";
      this.persist();
      this.waiters.get(reviewId)?.resolve();
      this.waiters.delete(reviewId);
    }
  }

  reject(reviewId: string, payloadSha256: string): void {
    const record = this.requireRecord(reviewId);
    if (record.payloadSha256 !== payloadSha256) throw new Error("prompt review hash mismatch");
    if (record.status === "approved") throw new Error("prompt review already approved");
    if (record.status === "open") {
      record.status = "rejected";
      this.persist();
      this.waiters.get(reviewId)?.resolve();
      this.waiters.delete(reviewId);
    }
  }

  /** 只中断当前进程内Promise；耐久Review仍保持open，模拟kill -9后的磁盘事实。 */
  simulateProcessLoss(): void {
    for (const waiter of this.waiters.values()) {
      waiter.reject(new SimulatedProcessLossError());
    }
    this.waiters.clear();
  }

  private async waitForDecision(reviewId: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.waiters.set(reviewId, { resolve, reject });
    });
  }

  private requireRecord(reviewId: string): ReviewRecord {
    const record = this.snapshot.records.find((candidate) => candidate.reviewId === reviewId);
    if (record === undefined) throw new Error("prompt review record not found");
    return record;
  }

  private persist(): void {
    const temporaryPath = `${this.statePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(this.snapshot), { mode: 0o600 });
    renameSync(temporaryPath, this.statePath);
  }
}

function computePayloadSha256(payload: unknown): string {
  return hashCanonical("reviewable-provider-request-payload.poc.v1", payload);
}

function expectProviderReceivedReviewedPayload(
  provider: LocalCountingProvider,
  requestIndex: number,
  review: ReviewRecord,
): void {
  const received = provider.requestBodies[requestIndex - 1];
  expect(received).toBeDefined();
  expect(computePayloadSha256(received)).toBe(review.payloadSha256);
}

type ResponseScript =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly arguments: Record<string, unknown>;
    };

class LocalCountingProvider {
  private server: Server | undefined;
  private scripts: ResponseScript[] = [];
  readonly requestBodies: unknown[] = [];
  baseUrl = "";

  async start(): Promise<void> {
    this.server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      this.requestBodies.push(JSON.parse(body) as unknown);
      const script = this.scripts.shift();
      if (script === undefined) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "missing response script" } }));
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const chunk of responseChunks(script)) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (address === null || typeof address === "string")
      throw new Error("provider address missing");
    this.baseUrl = `http://127.0.0.1:${String(address.port)}/v1`;
  }

  enqueue(...scripts: ResponseScript[]): void {
    this.scripts.push(...scripts);
  }

  async close(): Promise<void> {
    if (this.server === undefined) return;
    this.server.close();
    await once(this.server, "close");
    this.server = undefined;
  }
}

function responseChunks(script: ResponseScript): readonly unknown[] {
  const base = {
    id: "chatcmpl-prompt-review-poc",
    object: "chat.completion.chunk",
    created: 0,
    model: "p0-local-model",
  };
  if (script.kind === "tool") {
    return [
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: script.toolCallId,
                  type: "function",
                  function: {
                    name: script.toolName,
                    arguments: JSON.stringify(script.arguments),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    ];
  }
  return [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: script.text },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
  ];
}

interface SessionHarness {
  readonly session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  readonly sessionManager: SessionManager;
}

async function createProbeSession(input: {
  readonly root: string;
  readonly providerBaseUrl: string;
  readonly gate: DurablePromptReviewGateProbe;
  readonly sessionManager?: SessionManager;
  readonly tool?: ToolDefinition;
}): Promise<SessionHarness> {
  const cwd = join(input.root, "workspace");
  const agentDir = join(input.root, "agent");
  const sessionsDir = join(input.root, "sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  const authPath = join(agentDir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ openai: { type: "api_key", key: "p0-test-key" } }), {
    mode: 0o600,
  });
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noThemes: true,
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const model: Model<"openai-completions"> = {
    id: "p0-local-model",
    name: "P0 Local Model",
    api: "openai-completions",
    provider: "openai",
    baseUrl: input.providerBaseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 2_000,
  };
  const sessionManager =
    input.sessionManager ?? createCheckpointableSessionManager(cwd, sessionsDir);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel: "off",
    tools: input.tool === undefined ? [] : [input.tool.name],
    ...(input.tool !== undefined ? { customTools: [input.tool] } : {}),
    resourceLoader,
    sessionManager,
    settingsManager,
  });
  session.agent.getApiKey = () => "p0-test-key";
  const piOnPayload = session.agent.onPayload;
  session.agent.onPayload = async (payload, payloadModel) => {
    const piPayload = (await piOnPayload?.(payload, payloadModel)) ?? payload;
    return input.gate.intercept(piPayload);
  };
  session.agent.streamFunction = (streamModel, context, options) =>
    streamSimple(streamModel, context, {
      ...options,
      apiKey: "p0-test-key",
      maxRetries: 0,
      timeoutMs: 5_000,
    });
  return { session, sessionManager };
}

/**
 * SessionManager.create会把首个Assistant出现前的条目只留在内存。P0用公开的open空文件
 * 路径先写入Header，使首个User Message在Provider审核边界前已经有磁盘Checkpoint。
 */
function createCheckpointableSessionManager(cwd: string, sessionsDir: string): SessionManager {
  const sessionPath = join(sessionsDir, "p0-session.jsonl");
  writeFileSync(sessionPath, "", { flag: "wx", mode: 0o600 });
  return SessionManager.open(sessionPath, sessionsDir, cwd);
}

function temporaryRoot(): string {
  const root = join(
    tmpdir(),
    `chat-prompt-review-p0-${String(Date.now())}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  return root;
}

async function waitForReviewCount(
  gate: DurablePromptReviewGateProbe,
  expected: number,
): Promise<void> {
  await vi.waitFor(() => {
    expect(gate.records()).toHaveLength(expected);
  });
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("Pi Prompt Review continuation P0", () => {
  it("首轮在Provider前暂停，重复批准也只发送一次", async () => {
    const root = temporaryRoot();
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const provider = new LocalCountingProvider();
    await provider.start();
    cleanups.push(() => provider.close());
    provider.enqueue({ kind: "text", text: "approved once" });
    const gate = DurablePromptReviewGateProbe.open(join(root, "review-state.json"));
    const { session } = await createProbeSession({
      root,
      providerBaseUrl: provider.baseUrl,
      gate,
    });
    cleanups.push(() => session.dispose());

    const prompt = session.prompt("hello", {
      expandPromptTemplates: false,
      source: "extension",
    });
    await waitForReviewCount(gate, 1);
    expect(provider.requestBodies).toHaveLength(0);
    const review = gate.records()[0]!;
    gate.approve(review.reviewId, review.payloadSha256);
    gate.approve(review.reviewId, review.payloadSha256);
    await prompt;

    expect(provider.requestBodies).toHaveLength(1);
    expectProviderReceivedReviewedPayload(provider, 1, review);
    expect(session.getLastAssistantText()).toBe("approved once");
  });

  it("拒绝首轮审核时Provider调用数为零", async () => {
    const root = temporaryRoot();
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const provider = new LocalCountingProvider();
    await provider.start();
    cleanups.push(() => provider.close());
    const gate = DurablePromptReviewGateProbe.open(join(root, "review-state.json"));
    const { session } = await createProbeSession({
      root,
      providerBaseUrl: provider.baseUrl,
      gate,
    });
    cleanups.push(() => session.dispose());

    const prompt = session.prompt("do not send", {
      expandPromptTemplates: false,
      source: "extension",
    });
    await waitForReviewCount(gate, 1);
    const review = gate.records()[0]!;
    gate.reject(review.reviewId, review.payloadSha256);
    await prompt;

    expect(provider.requestBodies).toHaveLength(0);
    expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
  });

  it("Tool Result进入上下文后，下一次Provider请求再次暂停", async () => {
    const root = temporaryRoot();
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const provider = new LocalCountingProvider();
    await provider.start();
    cleanups.push(() => provider.close());
    provider.enqueue(
      {
        kind: "tool",
        toolCallId: "call-p0-1",
        toolName: "probe_tool",
        arguments: { value: "first" },
      },
      { kind: "text", text: "tool round completed" },
    );
    let toolExecutionCount = 0;
    const tool: ToolDefinition = {
      name: "probe_tool",
      label: "Probe Tool",
      description: "Return deterministic evidence for the P0 continuation test",
      parameters: Type.Object({ value: Type.String() }),
      execute: async (_toolCallId, params) => {
        toolExecutionCount += 1;
        const value = (params as { value: string }).value;
        return {
          content: [{ type: "text", text: `tool-result:${value}` }],
          details: undefined,
        };
      },
    };
    const gate = DurablePromptReviewGateProbe.open(join(root, "review-state.json"));
    const { session } = await createProbeSession({
      root,
      providerBaseUrl: provider.baseUrl,
      gate,
      tool,
    });
    cleanups.push(() => session.dispose());

    const prompt = session.prompt("use the probe tool", {
      expandPromptTemplates: false,
      source: "extension",
    });
    await waitForReviewCount(gate, 1);
    const first = gate.records()[0]!;
    gate.approve(first.reviewId, first.payloadSha256);
    await waitForReviewCount(gate, 2);

    expect(provider.requestBodies).toHaveLength(1);
    expectProviderReceivedReviewedPayload(provider, 1, first);
    expect(toolExecutionCount).toBe(1);
    const second = gate.records()[1]!;
    expect(JSON.stringify(second.payload)).toContain("tool-result:first");
    gate.approve(second.reviewId, second.payloadSha256);
    await prompt;

    expect(provider.requestBodies).toHaveLength(2);
    expectProviderReceivedReviewedPayload(provider, 2, second);
    expect(JSON.stringify(provider.requestBodies[1])).toContain("tool-result:first");
    expect(session.getLastAssistantText()).toBe("tool round completed");
  });

  it("等待审核时的磁盘快照可重建Session，并以同一Payload Hash继续", async () => {
    const root = temporaryRoot();
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const provider = new LocalCountingProvider();
    await provider.start();
    cleanups.push(() => provider.close());
    provider.enqueue({ kind: "text", text: "resumed after restart" });
    const statePath = join(root, "review-state.json");
    const gateBeforeRestart = DurablePromptReviewGateProbe.open(statePath);
    const firstHarness = await createProbeSession({
      root,
      providerBaseUrl: provider.baseUrl,
      gate: gateBeforeRestart,
    });
    cleanups.push(() => firstHarness.session.dispose());

    const interruptedPrompt = firstHarness.session.prompt("survive restart", {
      expandPromptTemplates: false,
      source: "extension",
    });
    await waitForReviewCount(gateBeforeRestart, 1);
    expect(provider.requestBodies).toHaveLength(0);
    const sessionFile = firstHarness.sessionManager.getSessionFile();
    if (sessionFile === undefined) throw new Error("Pi session file missing at review boundary");
    const crashSnapshotPath = join(root, "crash-snapshot.jsonl");
    copyFileSync(sessionFile, crashSnapshotPath);
    const beforeRestart = gateBeforeRestart.records()[0]!;
    gateBeforeRestart.simulateProcessLoss();
    await interruptedPrompt;

    const gateAfterRestart = DurablePromptReviewGateProbe.open(statePath);
    const restored = gateAfterRestart.records()[0]!;
    expect(restored).toMatchObject({
      reviewId: beforeRestart.reviewId,
      payloadSha256: beforeRestart.payloadSha256,
      status: "open",
      permitConsumed: false,
    });
    gateAfterRestart.approve(restored.reviewId, restored.payloadSha256);
    const restoredManager = SessionManager.open(
      crashSnapshotPath,
      join(root, "sessions-restored"),
      join(root, "workspace"),
    );
    const secondHarness = await createProbeSession({
      root,
      providerBaseUrl: provider.baseUrl,
      gate: gateAfterRestart,
      sessionManager: restoredManager,
    });
    cleanups.push(() => secondHarness.session.dispose());

    await secondHarness.session.agent.continue();

    expect(provider.requestBodies).toHaveLength(1);
    expectProviderReceivedReviewedPayload(provider, 1, beforeRestart);
    expect(gateAfterRestart.records()[0]).toMatchObject({
      payloadSha256: beforeRestart.payloadSha256,
      status: "approved",
      permitConsumed: true,
    });
    expect(secondHarness.session.getLastAssistantText()).toBe("resumed after restart");
  });
});
