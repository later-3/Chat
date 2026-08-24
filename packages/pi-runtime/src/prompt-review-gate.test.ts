import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashCanonical } from "@chat/domain";
import {
  PI_DIRECT_EXECUTOR_PROTOCOL_VERSION,
  type DirectPromptReviewDecisionRef,
  type DirectPromptReviewRef,
  type StartPiDirectExecutorOperationRequest,
} from "./direct-executor-service-contract.js";
import { PiDirectExecutorOperationStore } from "./direct-executor-operation-store.js";
import { hashExecutorValue } from "./executor-operation-store.js";
import {
  DirectPromptReviewCoordinator,
  hashFinalProviderPayload,
  type DirectPromptReviewProductPort,
  type LoadedDirectPromptReviewDecision,
  type PublishDirectPromptReviewInput,
} from "./prompt-review-gate.js";

const PRIVATE_PROMPT = "PRIVATE_DIRECT_PROMPT_MUST_NOT_ENTER_OPERATION_STORE";
const roots: string[] = [];

function readCapability() {
  const sourceRef = {
    sourceKind: "builtin" as const,
    package: "@earendil-works/pi-coding-agent",
    repository: "later-3/pi",
    revision: "d".repeat(40),
    resourcePath: "pi/packages/coding-agent/src/core/tools/read.ts",
  };
  const inputSchemaSha256 = hashExecutorValue({ tool: "read", schema: "test" });
  const descriptorInput = {
    schemaVersion: "capability-descriptor.v1" as const,
    capabilityId: "pi_direct:tool:builtin:read",
    kind: "executable_tool" as const,
    runtimeOwner: "pi_direct" as const,
    localName: "read",
    sourceRef,
    inputSchemaSha256,
    effect: "read" as const,
    scopePolicy: "global" as const,
    approvalPolicy: "run_policy" as const,
    evidencePolicy: "runtime_journal" as const,
    readiness: "available" as const,
  };
  const descriptorSha256 = hashCanonical("capability-descriptor.v1", descriptorInput);
  return {
    ref: {
      capabilityId: descriptorInput.capabilityId,
      descriptorSha256,
      inputSchemaSha256,
      resolvedImplementationSha256: hashExecutorValue({ sourceRef, descriptorSha256 }),
      scopeRef: { kind: "global" as const },
    },
    localName: "read",
    kind: descriptorInput.kind,
    runtimeOwner: descriptorInput.runtimeOwner,
    sourceRef,
    effect: descriptorInput.effect,
    scopePolicy: descriptorInput.scopePolicy,
    approvalPolicy: descriptorInput.approvalPolicy,
    evidencePolicy: descriptorInput.evidencePolicy,
  };
}

function journalManifest(capabilities: readonly ReturnType<typeof readCapability>[], seed = "f") {
  const resolvedRuntimeManifest = {
    schemaVersion: "pi-direct-resolved-runtime-manifest.v1" as const,
    systemPromptSha256: seed.repeat(64).slice(0, 64),
    resourceInventorySha256: seed.repeat(64).slice(0, 64),
  };
  return {
    resolvedRuntimeManifest,
    resolvedCapabilities: [...capabilities],
    resolvedRuntimeManifestSha256: hashExecutorValue({
      systemPromptSha256: resolvedRuntimeManifest.systemPromptSha256,
      capabilities,
      resourceInventorySha256: resolvedRuntimeManifest.resourceInventorySha256,
    }),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chat-direct-prompt-review-"));
  roots.push(root);
  return root;
}

type ResponseScript =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly arguments: Record<string, unknown>;
      readonly reasoning?: string;
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
      for (const chunk of responseChunks(script))
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("Provider地址缺失");
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
    id: "chatcmpl-direct-review",
    object: "chat.completion.chunk",
    created: 0,
    model: "direct-local-model",
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
              ...(script.reasoning === undefined ? {} : { reasoning_content: script.reasoning }),
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

class InMemoryPromptReviewProduct implements DirectPromptReviewProductPort {
  private readonly reviewsByCommand = new Map<
    string,
    {
      readonly input: PublishDirectPromptReviewInput;
      readonly review: DirectPromptReviewRef;
      readonly productRunRevision: number;
    }
  >();
  private readonly decisions = new Map<string, LoadedDirectPromptReviewDecision>();
  private readonly consumedApprovals = new Set<string>();
  private productRunRevision = 1;
  publishCalls = 0;
  consumeCalls = 0;
  publishOutcomeUnknownOnce = false;
  publishOutcomeUnknownAfterCommitOnce = false;
  replayUsesCurrentRunRevision = false;
  dispatchOutcomeUnknownOnce = false;
  frozenPayloadOverride: unknown | undefined;
  readonly dispatchOutcomes: Array<"dispatched" | "outcome_unknown"> = [];

  async publish(input: PublishDirectPromptReviewInput) {
    this.publishCalls += 1;
    if (this.publishOutcomeUnknownOnce) {
      this.publishOutcomeUnknownOnce = false;
      throw Object.assign(new Error("publish response lost"), { outcomeUnknown: true as const });
    }
    const existing = this.reviewsByCommand.get(input.commandId);
    if (existing !== undefined) {
      return {
        review: existing.review,
        productRunRevision: this.replayUsesCurrentRunRevision
          ? this.productRunRevision
          : existing.productRunRevision,
      };
    }
    const promptReviewRequestId = `prr_test${String(this.reviewsByCommand.size + 1)}` as never;
    const review: DirectPromptReviewRef = {
      promptReviewRequestId,
      requestRevision: 1,
      revision: 1,
      requestIndex: input.requestIndex,
      payloadSha256: input.payloadSha256,
      reviewSha256: hashExecutorValue({
        kind: "product-prompt-review",
        promptReviewRequestId,
        payloadSha256: input.payloadSha256,
      }),
    };
    this.productRunRevision += 1;
    this.reviewsByCommand.set(input.commandId, {
      input: structuredClone(input),
      review,
      productRunRevision: this.productRunRevision,
    });
    if (this.publishOutcomeUnknownAfterCommitOnce) {
      this.publishOutcomeUnknownAfterCommitOnce = false;
      throw Object.assign(new Error("publish committed but response lost"), {
        outcomeUnknown: true as const,
      });
    }
    return { review, productRunRevision: this.productRunRevision };
  }

  async consumeDecision(input: { readonly promptReviewDecisionId: string }) {
    this.consumeCalls += 1;
    const loaded = this.decisions.get(input.promptReviewDecisionId);
    if (loaded === undefined) throw new Error("Decision不存在");
    if (loaded.decision.kind === "approve") {
      if (this.consumedApprovals.has(input.promptReviewDecisionId)) {
        return {
          status: "already_claimed" as const,
          review: loaded.review,
          decision: loaded.decision,
          productRunRevision: loaded.productRunRevision,
        };
      }
      this.consumedApprovals.add(input.promptReviewDecisionId);
    }
    return structuredClone(loaded);
  }

  async commitDispatchOutcome(input: { readonly outcome: "dispatched" | "outcome_unknown" }) {
    if (input.outcome === "dispatched" && this.dispatchOutcomeUnknownOnce) {
      this.dispatchOutcomeUnknownOnce = false;
      throw Object.assign(new Error("dispatch outcome response lost"), {
        outcomeUnknown: true as const,
      });
    }
    this.dispatchOutcomes.push(input.outcome);
  }

  decide(
    review: DirectPromptReviewRef,
    kind: "approve" | "reject",
  ): LoadedDirectPromptReviewDecision {
    const published = [...this.reviewsByCommand.values()].find(
      (candidate) => candidate.review.promptReviewRequestId === review.promptReviewRequestId,
    );
    if (published === undefined) throw new Error("Review正文不存在");
    const decision: DirectPromptReviewDecisionRef = {
      promptReviewDecisionId: `prd_test${String(this.decisions.size + 1)}` as never,
      revision: 1,
      decisionSha256: hashExecutorValue({ review, kind }),
      kind,
    };
    this.productRunRevision += 1;
    const loaded: LoadedDirectPromptReviewDecision =
      kind === "approve"
        ? {
            status: "authorized",
            review,
            decision,
            productRunRevision: this.productRunRevision,
            frozenPayload: structuredClone(this.frozenPayloadOverride ?? published.input.payload),
          }
        : {
            status: "rejected",
            review,
            decision,
            productRunRevision: this.productRunRevision,
          };
    this.decisions.set(decision.promptReviewDecisionId, loaded);
    return loaded;
  }

  payload(review: DirectPromptReviewRef): unknown {
    const published = [...this.reviewsByCommand.values()].find(
      (candidate) => candidate.review.promptReviewRequestId === review.promptReviewRequestId,
    );
    if (published === undefined) throw new Error("Review不存在");
    return published.input.payload;
  }

  committedReview(): DirectPromptReviewRef {
    const published = [...this.reviewsByCommand.values()][0];
    if (published === undefined) throw new Error("Review不存在");
    return structuredClone(published.review);
  }
}

function request(operationId = "pio_directtest1"): StartPiDirectExecutorOperationRequest {
  return {
    schemaVersion: PI_DIRECT_EXECUTOR_PROTOCOL_VERSION,
    operationId,
    productRunId: "run_test1" as never,
    directAgentAttemptId: "att_test1" as never,
    workflowRunSpecId: "wrs_test1" as never,
    workflowRunSpecSha256: "1".repeat(64),
    inputManifestSha256: "2".repeat(64),
  };
}

const authorizedProfile = {
  runRevision: 1,
  sourceMessageId: "msg_test1" as never,
  sourceMessageSha256: "3".repeat(64),
  capabilityMode: "read_only" as const,
  limits: {
    maxProviderRequests: 16 as const,
    activeTimeoutMs: 1_200_000 as const,
    tokenBudget: 64_000 as const,
  },
};

interface Harness {
  readonly session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  readonly abortController: AbortController;
}

async function createHarness(input: {
  readonly root: string;
  readonly provider: LocalCountingProvider;
  readonly coordinator: DirectPromptReviewCoordinator;
  readonly store: PiDirectExecutorOperationStore;
  readonly operationId: string;
  readonly promptReviewMode?: "manual" | "off";
  readonly sessionManager?: SessionManager;
  readonly tool?: ToolDefinition;
  readonly reasoning?: boolean;
}): Promise<Harness> {
  const cwd = join(input.root, "workspace");
  const agentDir = join(input.root, "agent");
  const sessionsDir = join(input.root, "sessions");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  const authPath = join(agentDir, "auth.json");
  await writeFile(
    authPath,
    JSON.stringify({ openai: { type: "api_key", key: "direct-test-key" } }),
    { mode: 0o600 },
  );
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false, provider: { maxRetries: 0 } },
    compaction: { enabled: false },
    branchSummary: { skipPrompt: true },
  });
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
    id: "direct-local-model",
    name: "Direct Local Model",
    api: "openai-completions",
    provider: "openai",
    baseUrl: input.provider.baseUrl,
    reasoning: input.reasoning ?? false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 2_000,
  };
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel: input.reasoning === true ? "low" : "off",
    tools: input.tool === undefined ? [] : [input.tool.name],
    ...(input.tool === undefined ? {} : { customTools: [input.tool] }),
    resourceLoader,
    sessionManager:
      input.sessionManager ?? SessionManager.create(cwd, sessionsDir, { id: "pis_directtest1" }),
    settingsManager,
  });
  const activePromptReview =
    input.sessionManager === undefined
      ? undefined
      : input.store.getActivePromptReview(input.operationId);
  await input.store.setSession({
    operationId: input.operationId,
    sessionId: session.sessionId,
    enabledTools: [],
    ...journalManifest([]),
    ...(activePromptReview === undefined
      ? {}
      : { resumedFromCheckpointSha256: activePromptReview.checkpoint.fileSha256 }),
  });
  const abortController = new AbortController();
  session.agent.getApiKey = () => "direct-test-key";
  const piOnPayload = session.agent.onPayload;
  session.agent.onPayload = async (payload, payloadModel) => {
    const transformed = (await piOnPayload?.(payload, payloadModel)) ?? payload;
    return input.coordinator.intercept({
      operationId: input.operationId,
      providerId: payloadModel.provider,
      modelId: payloadModel.id,
      endpointHost: "127.0.0.1",
      payload: transformed,
      session,
      promptReviewMode: input.promptReviewMode ?? "manual",
      signal: abortController.signal,
    });
  };
  session.agent.streamFunction = (streamModel, context, options) =>
    streamSimple(streamModel, context, {
      ...options,
      apiKey: "direct-test-key",
      maxRetries: 0,
      timeoutMs: 5_000,
    });
  session.agent.subscribe(async (event) => {
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    if (input.store.getSnapshot(input.operationId).status !== "dispatching") return;
    await input.coordinator.markProviderSettled({
      operationId: input.operationId,
      completionTokens: event.message.usage.output,
      stopReason: event.message.stopReason === "pending" ? "error" : event.message.stopReason,
    });
  });
  return { session, abortController };
}

async function waitForStatus(
  store: PiDirectExecutorOperationStore,
  operationId: string,
  status: string,
): Promise<void> {
  await vi.waitFor(() => expect(store.getSnapshot(operationId).status).toBe(status));
}

async function approve(
  product: InMemoryPromptReviewProduct,
  coordinator: DirectPromptReviewCoordinator,
  store: PiDirectExecutorOperationStore,
  operationId: string,
): Promise<DirectPromptReviewRef> {
  const review = store.getSnapshot(operationId).activeReview;
  if (review === undefined) throw new Error("Review缺失");
  await coordinator.submitDecision(operationId, product.decide(review, "approve"));
  return review;
}

describe("Direct Prompt Review Gate P1", () => {
  it("关闭审核时不创建Product审核，仍通过派发围栏且只发送一次", async () => {
    const root = await temporaryRoot();
    const provider = new LocalCountingProvider();
    await provider.start();
    provider.enqueue({ kind: "text", text: "sent without review" });
    try {
      const store = await PiDirectExecutorOperationStore.open(join(root, "operations"));
      await store.createOrGet(request(), authorizedProfile);
      await store.markRunning("pio_directtest1");
      const product = new InMemoryPromptReviewProduct();
      const coordinator = new DirectPromptReviewCoordinator(
        store,
        product,
        join(root, "checkpoints"),
      );
      const harness = await createHarness({
        root,
        provider,
        coordinator,
        store,
        operationId: "pio_directtest1",
        promptReviewMode: "off",
      });

      await harness.session.prompt(PRIVATE_PROMPT, {
        expandPromptTemplates: false,
        source: "extension",
      });

      expect(product.publishCalls).toBe(0);
      expect(product.consumeCalls).toBe(0);
      expect(product.dispatchOutcomes).toEqual([]);
      expect(provider.requestBodies).toHaveLength(1);
      expect(store.getSnapshot("pio_directtest1")).toMatchObject({
        status: "running",
      });
      expect(
        store.getEvents("pio_directtest1").filter((event) => event.type === "provider.started"),
      ).toHaveLength(1);
      expect(harness.session.getLastAssistantText()).toBe("sent without review");
      harness.session.dispose();
    } finally {
      await provider.close();
    }
  });

  it("批准一次只发送一次，实际HTTP body与Product Store冻结Payload Hash一致", async () => {
    const root = await temporaryRoot();
    const provider = new LocalCountingProvider();
    await provider.start();
    provider.enqueue({ kind: "text", text: "approved once" });
    try {
      const store = await PiDirectExecutorOperationStore.open(join(root, "operations"));
      await store.createOrGet(request(), authorizedProfile);
      await store.markRunning("pio_directtest1");
      const product = new InMemoryPromptReviewProduct();
      const coordinator = new DirectPromptReviewCoordinator(
        store,
        product,
        join(root, "checkpoints"),
      );
      const harness = await createHarness({
        root,
        provider,
        coordinator,
        store,
        operationId: "pio_directtest1",
      });
      const run = harness.session.prompt(PRIVATE_PROMPT, {
        expandPromptTemplates: false,
        source: "extension",
      });
      await waitForStatus(store, "pio_directtest1", "waiting_prompt_review");
      expect(provider.requestBodies).toHaveLength(0);
      const checkpoint = store.getActivePromptReview("pio_directtest1")!.checkpoint;
      const checkpointPath = join(root, "checkpoints", checkpoint.fileName);
      const checkpointBytes = await readFile(checkpointPath);
      expect((await stat(checkpointPath)).mode & 0o777).toBe(0o600);
      expect(createHash("sha256").update(checkpointBytes).digest("hex")).toBe(
        checkpoint.fileSha256,
      );
      expect((await readdir(join(root, "checkpoints"))).some((name) => name.includes(".tmp"))).toBe(
        false,
      );
      const review = await approve(product, coordinator, store, "pio_directtest1");
      await run;
      await coordinator
        .submitDecision("pio_directtest1", product.decide(review, "approve"))
        .catch(() => undefined);

      expect(provider.requestBodies).toHaveLength(1);
      expect(hashFinalProviderPayload(provider.requestBodies[0])).toBe(review.payloadSha256);
      expect(hashFinalProviderPayload(product.payload(review))).toBe(review.payloadSha256);
      expect(product.dispatchOutcomes).toEqual(["dispatched"]);
      expect(harness.session.getLastAssistantText()).toBe("approved once");
      const operationFile = await readFile(
        join(root, "operations", "pio_directtest1.json"),
        "utf8",
      );
      expect(operationFile).not.toContain(PRIVATE_PROMPT);
      harness.session.dispose();
    } finally {
      await provider.close();
    }
  });

  it("拒绝时Provider调用为零并收敛为cancelled", async () => {
    const root = await temporaryRoot();
    const provider = new LocalCountingProvider();
    await provider.start();
    try {
      const store = await PiDirectExecutorOperationStore.open(join(root, "operations"));
      await store.createOrGet(request(), authorizedProfile);
      await store.markRunning("pio_directtest1");
      const product = new InMemoryPromptReviewProduct();
      const coordinator = new DirectPromptReviewCoordinator(
        store,
        product,
        join(root, "checkpoints"),
      );
      const harness = await createHarness({
        root,
        provider,
        coordinator,
        store,
        operationId: "pio_directtest1",
      });
      const run = harness.session.prompt("reject this", {
        expandPromptTemplates: false,
        source: "extension",
      });
      await waitForStatus(store, "pio_directtest1", "waiting_prompt_review");
      const review = store.getSnapshot("pio_directtest1").activeReview!;
      await coordinator.submitDecision("pio_directtest1", product.decide(review, "reject"));
      await run;

      expect(provider.requestBodies).toHaveLength(0);
      expect(store.getSnapshot("pio_directtest1")).toMatchObject({
        status: "cancelled",
        errorCode: "prompt_review.rejected",
      });
      harness.session.dispose();
    } finally {
      await provider.close();
    }
  });

  it("Tool Result后再次审核：产品只存隐藏推理Hash，Provider保持Pi原始上下文", async () => {
    const root = await temporaryRoot();
    const provider = new LocalCountingProvider();
    await provider.start();
    provider.enqueue(
      {
        kind: "tool",
        toolCallId: "call-direct-1",
        toolName: "probe",
        arguments: { value: "x" },
        reasoning: "PRIVATE_TOOL_REASONING",
      },
      { kind: "text", text: "tool complete" },
    );
    let toolCount = 0;
    const tool: ToolDefinition = {
      name: "probe",
      label: "Probe",
      description: "Return deterministic tool evidence",
      parameters: Type.Object({ value: Type.String() }),
      execute: async (_callId, params) => {
        toolCount += 1;
        return {
          content: [{ type: "text", text: `tool-result:${(params as { value: string }).value}` }],
          details: undefined,
        };
      },
    };
    try {
      const store = await PiDirectExecutorOperationStore.open(join(root, "operations"));
      await store.createOrGet(request(), authorizedProfile);
      await store.markRunning("pio_directtest1");
      const product = new InMemoryPromptReviewProduct();
      const coordinator = new DirectPromptReviewCoordinator(
        store,
        product,
        join(root, "checkpoints"),
      );
      const harness = await createHarness({
        root,
        provider,
        coordinator,
        store,
        operationId: "pio_directtest1",
        tool,
        reasoning: true,
      });
      const run = harness.session.prompt("use probe", {
        expandPromptTemplates: false,
        source: "extension",
      });
      await waitForStatus(store, "pio_directtest1", "waiting_prompt_review");
      await approve(product, coordinator, store, "pio_directtest1");
      await vi.waitFor(() => {
        expect(store.getSnapshot("pio_directtest1").activeReview?.requestIndex).toBe(2);
      });
      expect(provider.requestBodies).toHaveLength(1);
      expect(toolCount).toBe(1);
      const second = store.getSnapshot("pio_directtest1").activeReview!;
      const secondReviewPayload = JSON.stringify(product.payload(second));
      expect(secondReviewPayload).toContain("tool-result:x");
      expect(secondReviewPayload).toContain("chat.prompt_review.hidden_reasoning_redaction.v1");
      expect(secondReviewPayload).not.toContain("PRIVATE_TOOL_REASONING");
      await approve(product, coordinator, store, "pio_directtest1");
      await run;

      expect(provider.requestBodies).toHaveLength(2);
      expect(JSON.stringify(provider.requestBodies[1])).toContain("PRIVATE_TOOL_REASONING");
      expect(hashFinalProviderPayload(provider.requestBodies[1])).toBe(second.payloadSha256);
      expect(toolCount).toBe(1);
      expect(product.dispatchOutcomes).toEqual(["dispatched", "dispatched"]);
      expect(harness.session.getLastAssistantText()).toBe("tool complete");
      harness.session.dispose();
    } finally {
      await provider.close();
    }
  });

  it("publish响应未知留下preparing，重启后从Checkpoint幂等重建并进入waiting", async () => {
    const root = await temporaryRoot();
    const provider = new LocalCountingProvider();
    await provider.start();
    provider.enqueue({ kind: "text", text: "prepared recovery" });
    try {
      const operationDirectory = join(root, "operations");
      const checkpointDirectory = join(root, "checkpoints");
      const firstStore = await PiDirectExecutorOperationStore.open(operationDirectory);
      await firstStore.createOrGet(request(), authorizedProfile);
      await firstStore.markRunning("pio_directtest1");
      const product = new InMemoryPromptReviewProduct();
      product.publishOutcomeUnknownOnce = true;
      const firstCoordinator = new DirectPromptReviewCoordinator(
        firstStore,
        product,
        checkpointDirectory,
      );
      const first = await createHarness({
        root,
        provider,
        coordinator: firstCoordinator,
        store: firstStore,
        operationId: "pio_directtest1",
      });
      await first.session.prompt("recover preparing", {
        expandPromptTemplates: false,
        source: "extension",
      });
      expect(firstStore.getSnapshot("pio_directtest1").status).toBe("preparing_prompt_review");
      expect(provider.requestBodies).toHaveLength(0);
      first.session.dispose();

      const recoveredStore = await PiDirectExecutorOperationStore.open(operationDirectory);
      const coordinator = new DirectPromptReviewCoordinator(
        recoveredStore,
        product,
        checkpointDirectory,
      );
      const active = recoveredStore.getActivePromptReview("pio_directtest1")!;
      const manager = await coordinator.openCheckpoint({
        checkpoint: active.checkpoint,
        cwd: join(root, "workspace"),
        sessionsDirectory: join(root, "sessions-preparing-restored"),
      });
      const restored = await createHarness({
        root,
        provider,
        coordinator,
        store: recoveredStore,
        operationId: "pio_directtest1",
        sessionManager: manager,
      });
      const resumed = restored.session.resumePendingTurn();
      await waitForStatus(recoveredStore, "pio_directtest1", "waiting_prompt_review");
      await approve(product, coordinator, recoveredStore, "pio_directtest1");
      await resumed;

      expect(provider.requestBodies).toHaveLength(1);
      expect(restored.session.getLastAssistantText()).toBe("prepared recovery");
      restored.session.dispose();
    } finally {
      await provider.close();
    }
  });

  it("publish已提交但响应丢失后允许Decision同revision恢复，Provider只发送一次", async () => {
    const root = await temporaryRoot();
    const provider = new LocalCountingProvider();
    await provider.start();
    provider.enqueue({ kind: "text", text: "approved after publish replay" });
    try {
      const operationDirectory = join(root, "operations");
      const checkpointDirectory = join(root, "checkpoints");
      const firstStore = await PiDirectExecutorOperationStore.open(operationDirectory);
      await firstStore.createOrGet(request(), authorizedProfile);
      await firstStore.markRunning("pio_directtest1");
      const product = new InMemoryPromptReviewProduct();
      product.publishOutcomeUnknownAfterCommitOnce = true;
      product.replayUsesCurrentRunRevision = true;
      const firstCoordinator = new DirectPromptReviewCoordinator(
        firstStore,
        product,
        checkpointDirectory,
      );
      const first = await createHarness({
        root,
        provider,
        coordinator: firstCoordinator,
        store: firstStore,
        operationId: "pio_directtest1",
      });
      await first.session.prompt("publish response lost after commit", {
        expandPromptTemplates: false,
        source: "extension",
      });
      expect(firstStore.getSnapshot("pio_directtest1").status).toBe("preparing_prompt_review");
      const decision = product.decide(product.committedReview(), "approve");
      first.session.dispose();

      const recoveredStore = await PiDirectExecutorOperationStore.open(operationDirectory);
      const coordinator = new DirectPromptReviewCoordinator(
        recoveredStore,
        product,
        checkpointDirectory,
      );
      const active = recoveredStore.getActivePromptReview("pio_directtest1")!;
      const manager = await coordinator.openCheckpoint({
        checkpoint: active.checkpoint,
        cwd: join(root, "workspace"),
        sessionsDirectory: join(root, "sessions-publish-replay"),
      });
      const restored = await createHarness({
        root,
        provider,
        coordinator,
        store: recoveredStore,
        operationId: "pio_directtest1",
        sessionManager: manager,
      });
      const resumed = restored.session.resumePendingTurn();
      await waitForStatus(recoveredStore, "pio_directtest1", "waiting_prompt_review");
      expect(recoveredStore.getProductRunRevision("pio_directtest1")).toBe(
        decision.productRunRevision,
      );
      await coordinator.loadAndSubmitDecision({
        operationId: "pio_directtest1",
        promptReviewRequestId: decision.review.promptReviewRequestId,
        requestRevision: decision.review.requestRevision,
        reviewSha256: decision.review.reviewSha256,
        payloadSha256: decision.review.payloadSha256,
        promptReviewDecisionId: decision.decision.promptReviewDecisionId,
      });
      await resumed;

      expect(product.consumeCalls).toBe(1);
      expect(provider.requestBodies).toHaveLength(1);
      expect(product.dispatchOutcomes).toEqual(["dispatched"]);
      expect(restored.session.getLastAssistantText()).toBe("approved after publish replay");
      restored.session.dispose();
    } finally {
      await provider.close();
    }
  });

  it("等待态可从Checkpoint重建，并通过Later Pi AgentSession完整resume生命周期", async () => {
    const root = await temporaryRoot();
    const provider = new LocalCountingProvider();
    await provider.start();
    provider.enqueue({ kind: "text", text: "resumed" });
    try {
      const operationDirectory = join(root, "operations");
      const checkpointDirectory = join(root, "checkpoints");
      const firstStore = await PiDirectExecutorOperationStore.open(operationDirectory);
      await firstStore.createOrGet(request(), authorizedProfile);
      await firstStore.markRunning("pio_directtest1");
      const product = new InMemoryPromptReviewProduct();
      const firstCoordinator = new DirectPromptReviewCoordinator(
        firstStore,
        product,
        checkpointDirectory,
      );
      const first = await createHarness({
        root,
        provider,
        coordinator: firstCoordinator,
        store: firstStore,
        operationId: "pio_directtest1",
      });
      const interrupted = first.session.prompt("survive restart", {
        expandPromptTemplates: false,
        source: "extension",
      });
      await waitForStatus(firstStore, "pio_directtest1", "waiting_prompt_review");
      const originalReview = firstStore.getSnapshot("pio_directtest1").activeReview!;
      first.abortController.abort();
      await interrupted;
      first.session.dispose();

      const recoveredStore = await PiDirectExecutorOperationStore.open(operationDirectory);
      expect(recoveredStore.getSnapshot("pio_directtest1").status).toBe("waiting_prompt_review");
      const coordinator = new DirectPromptReviewCoordinator(
        recoveredStore,
        product,
        checkpointDirectory,
      );
      await coordinator.submitDecision(
        "pio_directtest1",
        product.decide(originalReview, "approve"),
      );
      const active = recoveredStore.getActivePromptReview("pio_directtest1")!;
      const manager = await coordinator.openCheckpoint({
        checkpoint: active.checkpoint,
        cwd: join(root, "workspace"),
        sessionsDirectory: join(root, "sessions-restored"),
      });
      const restored = await createHarness({
        root,
        provider,
        coordinator,
        store: recoveredStore,
        operationId: "pio_directtest1",
        sessionManager: manager,
      });
      const settled: string[] = [];
      restored.session.subscribe((event) => {
        if (event.type === "agent_settled") settled.push(event.type);
      });
      const resumed = restored.session.resumePendingTurn();
      await vi.waitFor(() => expect(restored.session.isStreaming).toBe(true));
      await resumed;

      expect(provider.requestBodies).toHaveLength(1);
      expect(hashFinalProviderPayload(provider.requestBodies[0])).toBe(
        originalReview.payloadSha256,
      );
      expect(restored.session.isIdle).toBe(true);
      expect(settled).toEqual(["agent_settled"]);
      expect(restored.session.getLastAssistantText()).toBe("resumed");
      restored.session.dispose();
    } finally {
      await provider.close();
    }
  });

  it("批准permit响应丢失后重放already_claimed，保守收敛outcome_unknown且不发送", async () => {
    const root = await temporaryRoot();
    const provider = new LocalCountingProvider();
    await provider.start();
    try {
      const store = await PiDirectExecutorOperationStore.open(join(root, "operations"));
      await store.createOrGet(request(), authorizedProfile);
      await store.markRunning("pio_directtest1");
      const product = new InMemoryPromptReviewProduct();
      const first = new DirectPromptReviewCoordinator(store, product, join(root, "checkpoints"));
      const harness = await createHarness({
        root,
        provider,
        coordinator: first,
        store,
        operationId: "pio_directtest1",
      });
      const interrupted = harness.session.prompt("consume once", {
        expandPromptTemplates: false,
        source: "extension",
      });
      await waitForStatus(store, "pio_directtest1", "waiting_prompt_review");
      const review = store.getSnapshot("pio_directtest1").activeReview!;
      const loaded = product.decide(review, "approve");
      harness.abortController.abort();
      await interrupted;
      harness.session.dispose();

      await first.loadAndSubmitDecision({
        operationId: "pio_directtest1",
        promptReviewRequestId: review.promptReviewRequestId,
        requestRevision: review.requestRevision,
        reviewSha256: review.reviewSha256,
        payloadSha256: review.payloadSha256,
        promptReviewDecisionId: loaded.decision.promptReviewDecisionId,
      });
      expect(product.consumeCalls).toBe(1);
      expect(store.getSnapshot("pio_directtest1").status).toBe("waiting_prompt_review");

      const rebuilt = new DirectPromptReviewCoordinator(store, product, join(root, "checkpoints"));
      await rebuilt.loadAndSubmitDecision({
        operationId: "pio_directtest1",
        promptReviewRequestId: review.promptReviewRequestId,
        requestRevision: review.requestRevision,
        reviewSha256: review.reviewSha256,
        payloadSha256: review.payloadSha256,
        promptReviewDecisionId: loaded.decision.promptReviewDecisionId,
      });

      expect(product.consumeCalls).toBe(2);
      expect(provider.requestBodies).toHaveLength(0);
      expect(product.dispatchOutcomes).toContain("outcome_unknown");
      expect(store.getSnapshot("pio_directtest1")).toMatchObject({
        status: "outcome_unknown",
        errorCode: "direct_executor.provider_permit_already_claimed",
      });
    } finally {
      await provider.close();
    }
  });

  it("批准permit已消费但冻结Payload漂移时立即收敛outcome_unknown且不发送", async () => {
    const root = await temporaryRoot();
    const provider = new LocalCountingProvider();
    await provider.start();
    try {
      const store = await PiDirectExecutorOperationStore.open(join(root, "operations"));
      await store.createOrGet(request(), authorizedProfile);
      await store.markRunning("pio_directtest1");
      const product = new InMemoryPromptReviewProduct();
      const coordinator = new DirectPromptReviewCoordinator(
        store,
        product,
        join(root, "checkpoints"),
      );
      const harness = await createHarness({
        root,
        provider,
        coordinator,
        store,
        operationId: "pio_directtest1",
      });
      const interrupted = harness.session.prompt("drift after permit", {
        expandPromptTemplates: false,
        source: "extension",
      });
      await waitForStatus(store, "pio_directtest1", "waiting_prompt_review");
      const review = store.getSnapshot("pio_directtest1").activeReview!;
      product.frozenPayloadOverride = { model: "changed", messages: [] };
      const loaded = product.decide(review, "approve");

      await coordinator.loadAndSubmitDecision({
        operationId: "pio_directtest1",
        promptReviewRequestId: review.promptReviewRequestId,
        requestRevision: review.requestRevision,
        reviewSha256: review.reviewSha256,
        payloadSha256: review.payloadSha256,
        promptReviewDecisionId: loaded.decision.promptReviewDecisionId,
      });
      await interrupted;

      expect(product.consumeCalls).toBe(1);
      expect(provider.requestBodies).toHaveLength(0);
      expect(product.dispatchOutcomes).toContain("outcome_unknown");
      expect(store.getSnapshot("pio_directtest1")).toMatchObject({
        status: "outcome_unknown",
        errorCode: "direct_executor.provider_permit_payload_drift",
      });
      harness.session.dispose();
    } finally {
      await provider.close();
    }
  });

  it("dispatching重启进入outcome_unknown，未闭合Tool Intent阻止下一次Review", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "operations");
    const store = await PiDirectExecutorOperationStore.open(directory);
    await store.createOrGet(request(), authorizedProfile);
    await store.markRunning("pio_directtest1");
    await store.setSession({
      operationId: "pio_directtest1",
      sessionId: "pis_directtest1",
      enabledTools: ["read"],
      ...journalManifest([readCapability()]),
    });
    const checkpoint = {
      fileName: "checkpoint.jsonl",
      fileSha256: "a".repeat(64),
      sessionId: "pis_directtest1",
      leafId: "leaf-1",
    };
    const payloadSha256 = "b".repeat(64);
    const reviewSha256 = "c".repeat(64);
    await store.beginPromptReview({
      operationId: "pio_directtest1",
      publishCommandId: "cmd_directtest1",
      payloadSha256,
      payloadEnvelopeSha256: reviewSha256,
      providerId: "openai",
      modelId: "direct-local-model",
      endpointHost: "127.0.0.1",
      checkpoint,
    });
    const review: DirectPromptReviewRef = {
      promptReviewRequestId: "prr_dispatch" as never,
      requestRevision: 1,
      revision: 1,
      requestIndex: 1,
      payloadSha256,
      reviewSha256,
    };
    await store.markPromptReviewWaiting("pio_directtest1", review, 2);
    await store.bindPromptReviewDecision(
      "pio_directtest1",
      {
        promptReviewDecisionId: "prd_dispatch" as never,
        revision: 1,
        decisionSha256: "d".repeat(64),
        kind: "approve",
      },
      3,
    );
    await store.markProviderDispatching("pio_directtest1");

    const recovered = await PiDirectExecutorOperationStore.open(directory);
    expect(recovered.getSnapshot("pio_directtest1")).toMatchObject({
      status: "outcome_unknown",
      errorCode: "direct_executor.provider_outcome_unknown",
    });

    const secondStore = await PiDirectExecutorOperationStore.open(join(root, "operations-2"));
    await secondStore.createOrGet(request("pio_directtest2"), authorizedProfile);
    await secondStore.markRunning("pio_directtest2");
    const readCapabilitySnapshot = readCapability();
    await secondStore.setSession({
      operationId: "pio_directtest2",
      sessionId: "pis_directtest2",
      enabledTools: ["read"],
      ...journalManifest([readCapabilitySnapshot]),
    });
    await secondStore.appendToolIntent({
      operationId: "pio_directtest2",
      sessionId: "pis_directtest2",
      toolCallId: "call-open",
      toolName: "read",
      inputSha256: "e".repeat(64),
      inputDisplay: "{}",
      inputDisplayTruncated: false,
      capability: readCapabilitySnapshot,
    });
    expect(() => secondStore.assertNoOpenSideEffects("pio_directtest2")).toThrow(
      "存在未闭合Tool Intent",
    );
  });

  it("Provider完成证据先落盘：崩溃恢复只重放Product dispatched，不改写为Provider未知", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "operations");
    const store = await PiDirectExecutorOperationStore.open(directory);
    await store.createOrGet(request(), authorizedProfile);
    await store.markRunning("pio_directtest1");
    await store.beginPromptReview({
      operationId: "pio_directtest1",
      publishCommandId: "cmd_completioncrash",
      payloadSha256: "a".repeat(64),
      payloadEnvelopeSha256: "b".repeat(64),
      providerId: "openai",
      modelId: "direct-local-model",
      endpointHost: "provider.example",
      checkpoint: {
        fileName: "completion-crash.jsonl",
        fileSha256: "c".repeat(64),
        sessionId: "pis_directtest1",
        leafId: "leaf-completion-crash",
      },
    });
    const review: DirectPromptReviewRef = {
      promptReviewRequestId: "prr_completioncrash" as never,
      requestRevision: 1,
      revision: 1,
      requestIndex: 1,
      payloadSha256: "a".repeat(64),
      reviewSha256: "d".repeat(64),
    };
    await store.markPromptReviewWaiting("pio_directtest1", review, 2);
    await store.bindPromptReviewDecision(
      "pio_directtest1",
      {
        promptReviewDecisionId: "prd_completioncrash" as never,
        revision: 1,
        decisionSha256: "e".repeat(64),
        kind: "approve",
      },
      3,
    );
    await store.markProviderDispatching("pio_directtest1");
    const product = new InMemoryPromptReviewProduct();
    product.dispatchOutcomeUnknownOnce = true;
    const firstCoordinator = new DirectPromptReviewCoordinator(
      store,
      product,
      join(root, "checkpoints"),
    );
    await expect(
      firstCoordinator.markProviderSettled({
        operationId: "pio_directtest1",
        completionTokens: 9,
        stopReason: "stop",
      }),
    ).rejects.toThrow("dispatch outcome response lost");
    expect(store.hasProviderCompletion("pio_directtest1")).toBe(true);
    expect(store.getSnapshot("pio_directtest1").status).toBe("dispatching");

    const recovered = await PiDirectExecutorOperationStore.open(directory);
    expect(recovered.getSnapshot("pio_directtest1")).toMatchObject({
      status: "outcome_unknown",
      errorCode: "direct_executor.session_continuation_outcome_unknown",
    });
    expect(recovered.hasProviderCompletion("pio_directtest1")).toBe(true);
    const coordinator = new DirectPromptReviewCoordinator(
      recovered,
      product,
      join(root, "checkpoints"),
    );
    await coordinator.reconcileCompletedProvider("pio_directtest1");
    expect(product.dispatchOutcomes).toEqual(["dispatched"]);
    expect(product.dispatchOutcomes).not.toContain("outcome_unknown");
  });

  it("Later Pi AgentSession拒绝从Assistant尾恢复", async () => {
    const root = await temporaryRoot();
    const provider = new LocalCountingProvider();
    await provider.start();
    try {
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
      const agentDir = join(root, "agent-guard");
      await mkdir(agentDir, { recursive: true });
      const authPath = join(agentDir, "auth.json");
      await writeFile(authPath, JSON.stringify({ openai: { type: "api_key", key: "x" } }));
      const modelRuntime = await ModelRuntime.create({
        authPath,
        modelsPath: null,
        refreshOnCreate: false,
      });
      const model: Model<"openai-completions"> = {
        id: "direct-local-model",
        name: "Direct Local Model",
        api: "openai-completions",
        provider: "openai",
        baseUrl: provider.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_000,
        maxTokens: 2_000,
      };
      const resourceLoader = new DefaultResourceLoader({
        cwd: root,
        agentDir,
        settingsManager,
        noExtensions: true,
        noThemes: true,
      });
      await resourceLoader.reload();
      const { session } = await createAgentSession({
        cwd: root,
        agentDir,
        modelRuntime,
        model,
        tools: [],
        resourceLoader,
        sessionManager: SessionManager.inMemory(root),
        settingsManager,
      });
      session.agent.state.messages = [
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          api: "openai-completions",
          provider: "openai",
          model: "direct-local-model",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      ];
      await expect(session.resumePendingTurn()).rejects.toThrow(
        "Cannot resume pending turn from message role: assistant",
      );
      session.dispose();
    } finally {
      await provider.close();
    }
  });
});
