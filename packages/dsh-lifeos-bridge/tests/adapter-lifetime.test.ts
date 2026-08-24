import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createUserMessage,
  LlmError,
  resolveRetryPolicy,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { TRACE_SCHEMA_VERSION, traceEventSchema, type TraceEventInput } from "@chat/contracts";
import { LifeosLlmAdapter, lastUserPrompt, stableCommandId } from "../src/adapter.ts";
import { ChatProductApiError, type ChatProductClient } from "../src/chat-client.ts";
import {
  dshBridgeSendPreviewSchema,
  promptSelectionRequestSchema,
  workflowSelectionSchema,
  type BridgeChatDispatchPlan,
  type ChatRun,
} from "../src/contracts.ts";
import { AtomicBridgeStateStore, type SessionBinding } from "../src/state-store.ts";
import { DshSendReviewCoordinator } from "../src/dsh-send-review.ts";
import { promptTurnPreviewFixture } from "./prompt-turn-preview-fixture.ts";

async function waitForReview(
  coordinator: DshSendReviewCoordinator,
  dshSessionId: string,
): Promise<NonNullable<ReturnType<DshSendReviewCoordinator["current"]>>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const review = coordinator.current(dshSessionId);
    if (review !== null) return review;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("DSH send review did not open");
}

function historicalBootstrapSelection() {
  return workflowSelectionSchema.parse({
    workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
    definitionSha256: "d".repeat(64),
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
  });
}

function messageInput(dshSessionId: string, text: string): GenerateOptions {
  return {
    provider: "lifeos",
    model: "workflow",
    sessionId: dshSessionId as never,
    messages: [
      createUserMessage({
        source: { kind: "user" },
        content: [{ type: "text", text }],
      }),
    ],
  };
}

async function writeV12UnknownFirstRequest(
  statePath: string,
  dshSessionId: string,
  input: GenerateOptions,
): Promise<{ readonly requestKey: string; readonly messageCommandId: string }> {
  const prompt = lastUserPrompt(input.messages);
  const bootstrap = historicalBootstrapSelection();
  const messageCommandId = stableCommandId(
    "submit-message",
    dshSessionId,
    prompt.messageId,
    prompt.textSha256,
  );
  await writeFile(
    statePath,
    `${JSON.stringify({
      schemaVersion: "chat-dsh-lifeos-state.v12",
      preferredWorkflowSelection: bootstrap,
      sessions: {
        [dshSessionId]: {
          createSessionCommandId: stableCommandId("create-session", dshSessionId),
          currentRequestKey: prompt.requestKey,
          requests: {
            [prompt.requestKey]: {
              dshMessageId: prompt.messageId,
              userTextSha256: prompt.textSha256,
              messageCommandId,
              workflowSelection: bootstrap,
            },
          },
          workflowSelection: bootstrap,
          dshSendReviewEnabled: false,
          bridgeDispatchReviewEnabled: false,
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
  return { requestKey: prompt.requestKey, messageCommandId };
}

test("plugin lifetime abort stops a waiting_human stream before another poll", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-lifetime-"));
  const lifetime = new AbortController();
  let submittedResolve!: () => void;
  const submitted = new Promise<void>((resolve) => {
    submittedResolve = resolve;
  });
  let runPolls = 0;
  const waitingRun = {
    productRunId: "run_lifetime1",
    status: "waiting_human",
  } as ChatRun;
  const chat = {
    submitFirstMessageFromDispatch: async () => {
      submittedResolve();
      return {
        session: { sessionId: "psn_lifetime1" },
        message: { messageId: "msg_lifetimeuser1", sessionId: "psn_lifetime1" },
        run: waitingRun,
      };
    },
    getRun: async () => {
      runPolls += 1;
      return waitingRun;
    },
  } as unknown as ChatProductClient;
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const adapter = new LifeosLlmAdapter(chat, state, lifetime.signal);
    const input: GenerateOptions = {
      provider: "lifeos",
      model: "workflow",
      sessionId: "dsh-lifetime" as never,
      messages: [
        createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: "等待审批" }],
        }),
      ],
    };
    const first = adapter.stream(input)[Symbol.asyncIterator]().next();
    await submitted;
    lifetime.abort(new DOMException("plugin unloaded", "AbortError"));
    await assert.rejects(first, (error) => error instanceof LlmError && error.code === "ABORTED");
    await new Promise<void>((resolve) => setTimeout(resolve, 800));
    assert.equal(runPolls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("enabled DSH send review blocks every Chat write until approve and reject writes nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-send-review-adapter-"));
  let firstMessageCalls = 0;
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    for (const sessionId of ["dsh-review-approve", "dsh-review-reject"]) {
      await state.setDshSendReviewEnabled(
        sessionId,
        stableCommandId("create-session", sessionId),
        true,
      );
    }
    const coordinator = new DshSendReviewCoordinator(
      state,
      async (dshSessionId, text, adapterRequest) =>
        dshBridgeSendPreviewSchema.parse({
          schemaVersion: "chat-dsh-bridge-send-preview.v2",
          boundary: "dsh_to_lifeos_bridge",
          status: "pre_send_projection",
          workspace: null,
          workflowSelection: null,
          promptSelection: { schemaVersion: "prompt-turn-selection-input.v1", regions: [] },
          promptConfiguration: null,
          promptTurnPreview: promptTurnPreviewFixture(text),
          dshToBridge: {
            adapterRequest,
            userInput: { text, sha256: "a".repeat(64) },
            contextInjections: {
              schemaVersion: "chat-dsh-context-injections.v1",
              dshSessionId,
              status: "ready",
              revision: "b".repeat(64),
              chatForwarding: "not_forwarded",
              items: [],
              totalItems: 0,
              omittedItems: 0,
              totalContentCharacters: 0,
            },
          },
          bridgeToChat: {
            policy: "non_direct_workspace_instructions",
            payload: { text },
            payloadJson: JSON.stringify({ text }, null, 2),
            payloadSha256: "c".repeat(64),
          },
        }),
    );
    const chat = {
      submitFirstMessageFromDispatch: async () => {
        firstMessageCalls += 1;
        return {
          session: { sessionId: "psn_dshreview1" },
          message: { messageId: "msg_dshreviewuser1", sessionId: "psn_dshreview1" },
          run: {
            productRunId: "run_dshreview1",
            status: "succeeded",
            finalMessageId: "msg_dshreviewassistant1",
          } as ChatRun,
        };
      },
      getMessage: async () => ({
        messageId: "msg_dshreviewassistant1",
        role: "assistant",
        content: { format: "markdown", text: "已发送" },
      }),
    } as unknown as ChatProductClient;
    const adapter = new LifeosLlmAdapter(chat, state, undefined, undefined, coordinator);
    const input = (sessionId: string, text = "审核真实发送"): GenerateOptions => ({
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

    const approvedInput = input("dsh-review-approve");
    const approvedNext = adapter.stream(approvedInput)[Symbol.asyncIterator]().next();
    const approvedReview = await waitForReview(coordinator, "dsh-review-approve");
    assert.equal(approvedReview.preview.dshToBridge.adapterRequest.status, "captured");
    if (approvedReview.preview.dshToBridge.adapterRequest.status !== "captured") {
      throw new Error("expected captured DSH request");
    }
    assert.match(approvedReview.preview.dshToBridge.adapterRequest.requestJson, /"messages"/u);
    assert.match(approvedReview.preview.dshToBridge.adapterRequest.requestJson, /审核真实发送/u);
    assert.equal(firstMessageCalls, 0);
    await assert.rejects(
      adapter
        .stream(input("dsh-review-approve", "并发消息不得越过prepared A"))
        [Symbol.asyncIterator]()
        .next(),
      (error) =>
        error instanceof LlmError && error.code === "LIFEOS_PROJECT_BOOTSTRAP_REQUEST_PENDING",
    );
    const whilePrepared = await state.readSession("dsh-review-approve");
    assert.equal(Object.keys(whilePrepared?.requests ?? {}).length, 1);
    assert.equal(
      whilePrepared?.currentRequestKey === undefined
        ? undefined
        : whilePrepared.requests[whilePrepared.currentRequestKey]?.submissionStatus,
      "prepared",
    );
    assert.equal(firstMessageCalls, 0);
    coordinator.decide("dsh-review-approve", approvedReview.reviewId, "approve");
    await approvedNext;
    assert.equal(firstMessageCalls, 1);

    const rejectedNext = adapter.stream(input("dsh-review-reject"))[Symbol.asyncIterator]().next();
    const rejectedReview = await waitForReview(coordinator, "dsh-review-reject");
    coordinator.decide("dsh-review-reject", rejectedReview.reviewId, "reject");
    await assert.rejects(
      rejectedNext,
      (error) => error instanceof LlmError && error.code === "LIFEOS_DSH_SEND_REJECTED",
    );
    assert.equal(firstMessageCalls, 1);
    const rejectedBinding = await state.readSession("dsh-review-reject");
    assert.equal(
      rejectedBinding?.currentRequestKey === undefined
        ? undefined
        : rejectedBinding.requests[rejectedBinding.currentRequestKey]?.submissionStatus,
      "definitely_uncommitted",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retryable Chat transport failure maps to the rc.6 retry policy code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-retry-code-"));
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const chat = {
      submitFirstMessageFromDispatch: async () => {
        throw new ChatProductApiError(
          503,
          "chat_api_unreachable",
          true,
          "retry_same_command",
          "Chat API is unreachable",
        );
      },
    } as unknown as ChatProductClient;
    const adapter = new LifeosLlmAdapter(chat, state);
    const first = adapter
      .stream({
        provider: "lifeos",
        model: "workflow",
        sessionId: "dsh-retry" as never,
        messages: [
          createUserMessage({
            source: { kind: "user" },
            content: [{ type: "text", text: "安全重试" }],
          }),
        ],
      })
      [Symbol.asyncIterator]()
      .next();
    await assert.rejects(first, (error) => error instanceof LlmError && error.code === "TRANSPORT");
    const policy = resolveRetryPolicy(undefined, "lifeos-test");
    assert.equal(policy.mode, "normal");
    if (policy.mode !== "normal") throw new Error("unexpected rc.6 retry policy");
    assert.ok(policy.retryableCodes.includes("TRANSPORT"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rc.6 retry of the same turn reuses command identity and returns the committed message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-retry-turn-"));
  const messageCommands: string[] = [];
  let attempts = 0;
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const chat = {
      submitFirstMessageFromDispatch: async (command: { commandId: string }) => {
        messageCommands.push(command.commandId);
        attempts += 1;
        if (attempts === 1) {
          throw new ChatProductApiError(
            503,
            "chat_api_unreachable",
            true,
            "retry_same_command",
            "Chat API is unreachable",
          );
        }
        return {
          session: { sessionId: "psn_retryturn1" },
          message: { messageId: "msg_retryturnuser1", sessionId: "psn_retryturn1" },
          run: {
            productRunId: "run_retryturn1",
            status: "succeeded",
            finalMessageId: "msg_retryturn1",
          } as ChatRun,
        };
      },
      getMessage: async () => ({
        messageId: "msg_retryturn1",
        role: "assistant",
        content: { format: "markdown", text: "恢复成功" },
      }),
    } as unknown as ChatProductClient;
    const adapter = new LifeosLlmAdapter(chat, state);
    const input: GenerateOptions = {
      provider: "lifeos",
      model: "workflow",
      sessionId: "dsh-retry-turn" as never,
      messages: [
        createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: "同一轮恢复" }],
        }),
      ],
    };
    const first = adapter.stream(input)[Symbol.asyncIterator]().next();
    await assert.rejects(first, (error) => error instanceof LlmError && error.code === "TRANSPORT");

    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(input)) chunks.push(chunk);
    assert.equal(messageCommands.length, 2);
    assert.equal(messageCommands[0], messageCommands[1]);
    const delta = chunks.find((chunk) => chunk.type === "text-delta");
    assert.equal(delta?.type === "text-delta" ? delta.text : undefined, "恢复成功");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v12 unknown A blocks B, Receipt replay binds A, and a definite 4xx alone releases B", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-v12-unknown-matrix-"));
  try {
    // A：不同消息B不能新增Request、覆盖currentRequestKey或调用任何Chat提交方法。
    {
      const statePath = join(directory, "case-a.json");
      const sessionId = "dsh-v12-matrix-a";
      const inputA = messageInput(sessionId, "旧项目初始化A");
      const inputB = messageInput(sessionId, "新的普通消息B");
      const frozen = await writeV12UnknownFirstRequest(statePath, sessionId, inputA);
      let submissions = 0;
      const chat = {
        submitFirstMessageFromDispatch: async () => {
          submissions += 1;
          throw new Error("B不得越过unknown A");
        },
        submitMessageFromDispatch: async () => {
          submissions += 1;
          throw new Error("B不得越过unknown A");
        },
      } as unknown as ChatProductClient;
      const state = new AtomicBridgeStateStore(statePath);
      await state.ready();
      await assert.rejects(
        new LifeosLlmAdapter(chat, state).stream(inputB)[Symbol.asyncIterator]().next(),
        (error) =>
          error instanceof LlmError && error.code === "LIFEOS_PROJECT_BOOTSTRAP_REQUEST_PENDING",
      );
      const binding = await state.readSession(sessionId);
      assert.equal(submissions, 0);
      assert.equal(Object.keys(binding?.requests ?? {}).length, 1);
      assert.equal(binding?.currentRequestKey, frozen.requestKey);
      assert.equal(binding?.requests[frozen.requestKey]?.submissionStatus, "outcome_unknown");
      assert.equal(binding?.projectBootstrapLifecycle, undefined);
    }

    // B：同一A只能以原Command/原首轮路由恢复，随后一次原子写绑定Session/Message/Run。
    {
      const statePath = join(directory, "case-b.json");
      const sessionId = "dsh-v12-matrix-b";
      const inputA = messageInput(sessionId, "旧项目初始化A恢复");
      const frozen = await writeV12UnknownFirstRequest(statePath, sessionId, inputA);
      const commands: string[] = [];
      const run = {
        productRunId: "run_v12matrixb1",
        sourceMessageId: "msg_v12matrixbuser1",
        status: "succeeded",
        finalMessageId: "msg_v12matrixbassistant1",
      } as ChatRun;
      const chat = {
        submitFirstMessageFromDispatch: async (plan: { commandId: string }) => {
          commands.push(plan.commandId);
          return {
            session: { sessionId: "psn_v12matrixb1" },
            message: { messageId: "msg_v12matrixbuser1", sessionId: "psn_v12matrixb1" },
            run,
          };
        },
        submitMessageFromDispatch: async () => {
          throw new Error("无Session的v12 A不得漂移到existing-session路径");
        },
        getMessage: async () => ({
          messageId: "msg_v12matrixbassistant1",
          role: "assistant",
          content: { format: "markdown", text: "原Receipt已恢复" },
        }),
      } as unknown as ChatProductClient;
      const state = new AtomicBridgeStateStore(statePath);
      await state.ready();
      const chunks: StreamChunk[] = [];
      for await (const chunk of new LifeosLlmAdapter(chat, state).stream(inputA)) {
        chunks.push(chunk);
      }
      const binding = await state.readSession(sessionId);
      const request = binding?.requests[frozen.requestKey];
      assert.ok(chunks.some((chunk) => chunk.type === "finish"));
      assert.deepEqual(commands, [frozen.messageCommandId]);
      assert.equal(binding?.chatSessionId, "psn_v12matrixb1");
      assert.equal(request?.productUserMessageId, "msg_v12matrixbuser1");
      assert.equal(request?.productRunId, "run_v12matrixb1");
      assert.equal(request?.submissionStatus, "bound");
    }

    // C：跨旧路由/种类仍冲突的Command ID证明A没有可恢复提交，之后B只提交一次普通Workflow。
    {
      const statePath = join(directory, "case-c.json");
      const sessionId = "dsh-v12-matrix-c";
      const inputA = messageInput(sessionId, "旧项目初始化A确定拒绝");
      const inputB = messageInput(sessionId, "拒绝后普通消息B");
      const frozen = await writeV12UnknownFirstRequest(statePath, sessionId, inputA);
      const submittedPlans: BridgeChatDispatchPlan["submitMessage"][] = [];
      const chat = {
        submitFirstMessageFromDispatch: async (plan: BridgeChatDispatchPlan["submitMessage"]) => {
          submittedPlans.push(plan);
          if (submittedPlans.length === 1) {
            throw new ChatProductApiError(
              409,
              "command_id_reused",
              false,
              "contact_support",
              "同ID已被不同Command占用，当前A确定未提交",
            );
          }
          return {
            session: { sessionId: "psn_v12matrixc1" },
            message: { messageId: "msg_v12matrixcuser1", sessionId: "psn_v12matrixc1" },
            run: {
              productRunId: "run_v12matrixc1",
              sourceMessageId: "msg_v12matrixcuser1",
              status: "succeeded",
              finalMessageId: "msg_v12matrixcassistant1",
            } as ChatRun,
          };
        },
        getMessage: async () => ({
          messageId: "msg_v12matrixcassistant1",
          role: "assistant",
          content: { format: "markdown", text: "普通消息只提交一次" },
        }),
      } as unknown as ChatProductClient;
      const state = new AtomicBridgeStateStore(statePath);
      await state.ready();
      await assert.rejects(
        new LifeosLlmAdapter(chat, state).stream(inputA)[Symbol.asyncIterator]().next(),
      );
      assert.equal(
        (await state.readSession(sessionId))?.requests[frozen.requestKey]?.submissionStatus,
        "definitely_uncommitted",
      );
      const chunks: StreamChunk[] = [];
      for await (const chunk of new LifeosLlmAdapter(chat, state).stream(inputB)) {
        chunks.push(chunk);
      }
      const binding = await state.readSession(sessionId);
      const requestB =
        binding?.currentRequestKey === undefined
          ? undefined
          : binding.requests[binding.currentRequestKey];
      assert.ok(chunks.some((chunk) => chunk.type === "finish"));
      assert.equal(submittedPlans.length, 2);
      assert.equal(submittedPlans[1]?.path, "/api/messages");
      assert.deepEqual(submittedPlans[1]?.payload.workflowSelection?.runConfiguration, {
        schemaVersion: "workflow-run-configuration.v1",
        overrides: [],
      });
      assert.equal(requestB?.submissionStatus, "bound");
      assert.equal(requestB?.productRunId, "run_v12matrixc1");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("transport, every 5xx, and 2xx contract damage keep A unknown and B blocked", async () => {
  const cases = [
    {
      label: "transport",
      error: new ChatProductApiError(
        503,
        "chat_api_unreachable",
        true,
        "retry_same_command",
        "transport",
      ),
    },
    {
      label: "5xx",
      error: new ChatProductApiError(500, "internal_error", true, "retry_same_command", "5xx"),
    },
    {
      label: "2xx-contract",
      error: new ChatProductApiError(
        200,
        "chat_api_contract_mismatch",
        false,
        "contact_support",
        "2xx response contract damaged",
      ),
    },
  ] as const;
  for (const scenario of cases) {
    const directory = await mkdtemp(join(tmpdir(), `chat-dsh-v12-${scenario.label}-`));
    const statePath = join(directory, "state.json");
    const sessionId = `dsh-v12-${scenario.label}`;
    const inputA = messageInput(sessionId, `项目初始化A-${scenario.label}`);
    const inputB = messageInput(sessionId, `不同消息B-${scenario.label}`);
    try {
      const frozen = await writeV12UnknownFirstRequest(statePath, sessionId, inputA);
      let submissions = 0;
      const chat = {
        submitFirstMessageFromDispatch: async () => {
          submissions += 1;
          throw scenario.error;
        },
      } as unknown as ChatProductClient;
      const state = new AtomicBridgeStateStore(statePath);
      await state.ready();
      const adapter = new LifeosLlmAdapter(chat, state);
      await assert.rejects(adapter.stream(inputA)[Symbol.asyncIterator]().next());
      await assert.rejects(
        adapter.stream(inputB)[Symbol.asyncIterator]().next(),
        (error) =>
          error instanceof LlmError && error.code === "LIFEOS_PROJECT_BOOTSTRAP_REQUEST_PENDING",
      );
      const binding = await state.readSession(sessionId);
      assert.equal(submissions, 1, scenario.label);
      assert.equal(Object.keys(binding?.requests ?? {}).length, 1, scenario.label);
      assert.equal(binding?.currentRequestKey, frozen.requestKey, scenario.label);
      assert.equal(
        binding?.requests[frozen.requestKey]?.submissionStatus,
        "outcome_unknown",
        scenario.label,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("跨对象矛盾的2xx响应在Bridge绑定前失败并持续阻止B", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-cross-identity-"));
  try {
    for (const submissionTarget of ["first_message", "existing_session"] as const) {
      const sessionId = `dsh-cross-identity-${submissionTarget}`;
      const statePath = join(directory, `${submissionTarget}.json`);
      const state = new AtomicBridgeStateStore(statePath);
      await state.ready();
      const productSessionId = "psn_crossidentitytarget1";
      if (submissionTarget === "existing_session") {
        await state.mutateSession(
          sessionId,
          stableCommandId("create-session", sessionId),
          (binding) => {
            binding.chatSessionId = productSessionId;
          },
        );
      }
      const inputA = messageInput(sessionId, `身份矛盾A-${submissionTarget}`);
      const inputB = messageInput(sessionId, `不同消息B-${submissionTarget}`);
      let submissions = 0;
      const message = {
        messageId: `msg_crossidentity${submissionTarget.replace("_", "")}1`,
        sessionId: productSessionId,
      };
      const run = {
        productRunId: `run_crossidentity${submissionTarget.replace("_", "")}1`,
        sessionId: "psn_crossidentityother1",
        sourceMessageId: message.messageId,
        status: "succeeded",
        finalMessageId: "msg_crossidentityassistant1",
      } as ChatRun;
      const chat = {
        submitFirstMessageFromDispatch: async () => {
          submissions += 1;
          return { session: { sessionId: productSessionId }, message, run };
        },
        submitMessageFromDispatch: async () => {
          submissions += 1;
          return { message, run };
        },
      } as unknown as ChatProductClient;
      const adapter = new LifeosLlmAdapter(chat, state);

      await assert.rejects(
        adapter.stream(inputA)[Symbol.asyncIterator]().next(),
        (error) => error instanceof LlmError && error.code === "LIFEOS_CHAT_API_CONTRACT_MISMATCH",
      );
      const afterA = await state.readSession(sessionId);
      const requestKeyA = lastUserPrompt(inputA.messages).requestKey;
      assert.equal(afterA?.requests[requestKeyA]?.submissionStatus, "outcome_unknown");
      assert.equal(afterA?.requests[requestKeyA]?.productRunId, undefined);
      assert.equal(afterA?.requests[requestKeyA]?.productUserMessageId, undefined);
      assert.equal(
        afterA?.chatSessionId,
        submissionTarget === "existing_session" ? productSessionId : undefined,
      );

      await assert.rejects(
        adapter.stream(inputB)[Symbol.asyncIterator]().next(),
        (error) =>
          error instanceof LlmError && error.code === "LIFEOS_PROJECT_BOOTSTRAP_REQUEST_PENDING",
      );
      assert.equal(submissions, 1);
      assert.equal(Object.keys((await state.readSession(sessionId))?.requests ?? {}).length, 1);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prepared A与并发unknown A都在全部Chat调用和状态写入前阻止B", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-pending-before-chat-"));
  try {
    // prepared A：失败路径由State Store同一个串行mutation拥有，不产生文件改写。
    {
      const sessionId = "dsh-prepared-before-chat";
      const statePath = join(directory, "prepared.json");
      const state = new AtomicBridgeStateStore(statePath);
      await state.ready();
      const inputA = messageInput(sessionId, "prepared A");
      const inputB = messageInput(sessionId, "prepared之后的B");
      const promptA = lastUserPrompt(inputA.messages);
      await state.mutateSession(
        sessionId,
        stableCommandId("create-session", sessionId),
        (binding) => {
          binding.requests[promptA.requestKey] = {
            dshMessageId: promptA.messageId,
            userTextSha256: promptA.textSha256,
            messageCommandId: stableCommandId(
              "submit-message",
              sessionId,
              promptA.messageId,
              promptA.textSha256,
            ),
            submissionTarget: "first_message",
            submissionStatus: "prepared",
          };
          binding.currentRequestKey = promptA.requestKey;
        },
      );
      const bytesBefore = await readFile(statePath, "utf8");
      let chatCalls = 0;
      const chat = {
        getCurrentProjectBootstrap: async () => {
          chatCalls += 1;
          return null;
        },
        getRun: async () => {
          chatCalls += 1;
          throw new Error("B不得查询Run");
        },
        submitFirstMessageFromDispatch: async () => {
          chatCalls += 1;
          throw new Error("B不得提交");
        },
        submitMessageFromDispatch: async () => {
          chatCalls += 1;
          throw new Error("B不得提交");
        },
      } as unknown as ChatProductClient;
      await assert.rejects(
        new LifeosLlmAdapter(chat, state).stream(inputB)[Symbol.asyncIterator]().next(),
        (error) =>
          error instanceof LlmError && error.code === "LIFEOS_PROJECT_BOOTSTRAP_REQUEST_PENDING",
      );
      assert.equal(chatCalls, 0);
      assert.equal(await readFile(statePath, "utf8"), bytesBefore);
      assert.equal(Object.keys((await state.readSession(sessionId))?.requests ?? {}).length, 1);
      assert.equal((await state.readSession(sessionId))?.currentRequestKey, promptA.requestKey);
    }

    // 两条新消息并发：第一条在写边界前已原子变成unknown，第二条不能获得预留。
    {
      const sessionId = "dsh-concurrent-before-chat";
      const state = new AtomicBridgeStateStore(join(directory, "concurrent.json"));
      await state.ready();
      const inputA = messageInput(sessionId, "并发A");
      const inputB = messageInput(sessionId, "并发B");
      let releaseSubmit!: () => void;
      let markEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseSubmit = resolve;
      });
      let submissions = 0;
      const chat = {
        submitFirstMessageFromDispatch: async () => {
          submissions += 1;
          markEntered();
          await release;
          throw new ChatProductApiError(
            503,
            "chat_api_unreachable",
            true,
            "retry_same_command",
            "并发测试保留unknown",
          );
        },
      } as unknown as ChatProductClient;
      const adapter = new LifeosLlmAdapter(chat, state);
      const pendingA = adapter.stream(inputA)[Symbol.asyncIterator]().next();
      await entered;
      await assert.rejects(
        adapter.stream(inputB)[Symbol.asyncIterator]().next(),
        (error) =>
          error instanceof LlmError && error.code === "LIFEOS_PROJECT_BOOTSTRAP_REQUEST_PENDING",
      );
      releaseSubmit();
      await assert.rejects(pendingA);
      const binding = await state.readSession(sessionId);
      const promptA = lastUserPrompt(inputA.messages);
      assert.equal(submissions, 1);
      assert.equal(Object.keys(binding?.requests ?? {}).length, 1);
      assert.equal(binding?.currentRequestKey, promptA.requestKey);
      assert.equal(binding?.requests[promptA.requestKey]?.submissionStatus, "outcome_unknown");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migrated v14 unknown A cannot bypass enabled DSH or Bridge pre-send review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-v14-review-unknown-"));
  const seed = async (label: string) => {
    const statePath = join(directory, `${label}.json`);
    const sessionId = `dsh-v14-review-${label}`;
    const input = messageInput(sessionId, `旧审核Request-${label}`);
    const prompt = lastUserPrompt(input.messages);
    await writeFile(
      statePath,
      `${JSON.stringify({
        schemaVersion: "chat-dsh-lifeos-state.v14",
        newSessionWorkflowPreference: null,
        sessions: {
          [sessionId]: {
            createSessionCommandId: stableCommandId("create-session", sessionId),
            currentRequestKey: prompt.requestKey,
            requests: {
              [prompt.requestKey]: {
                dshMessageId: prompt.messageId,
                userTextSha256: prompt.textSha256,
                messageCommandId: stableCommandId(
                  "submit-message",
                  sessionId,
                  prompt.messageId,
                  prompt.textSha256,
                ),
                workflowSelection: historicalBootstrapSelection(),
                submissionTarget: "first_message",
              },
            },
            dshSendReviewEnabled: true,
            bridgeDispatchReviewEnabled: true,
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    const state = new AtomicBridgeStateStore(statePath);
    await state.ready();
    return { state, sessionId, input, requestKey: prompt.requestKey };
  };
  try {
    for (const rejectedAt of ["dsh", "bridge"] as const) {
      const fixture = await seed(rejectedAt);
      let dshReviews = 0;
      let bridgeReviews = 0;
      let submissions = 0;
      const chat = {
        submitFirstMessageFromDispatch: async () => {
          submissions += 1;
          throw new Error("审核拒绝前不得调用Product HTTP");
        },
      } as unknown as ChatProductClient;
      const dshReview = {
        waitForDecision: async () => {
          dshReviews += 1;
          return rejectedAt === "dsh" ? "reject" : "approve";
        },
      } as unknown as DshSendReviewCoordinator;
      const bridgeReview = {
        waitForDecision: async () => {
          bridgeReviews += 1;
          return "reject";
        },
      } as unknown as import("../src/bridge-dispatch-review.ts").BridgeDispatchReviewCoordinator;
      await assert.rejects(
        new LifeosLlmAdapter(chat, fixture.state, undefined, undefined, dshReview, bridgeReview)
          .stream(fixture.input)
          [Symbol.asyncIterator]()
          .next(),
        (error) =>
          error instanceof LlmError &&
          error.code ===
            (rejectedAt === "dsh" ? "LIFEOS_DSH_SEND_REJECTED" : "LIFEOS_BRIDGE_DISPATCH_REJECTED"),
      );
      assert.equal(dshReviews, 1, rejectedAt);
      assert.equal(bridgeReviews, rejectedAt === "bridge" ? 1 : 0, rejectedAt);
      assert.equal(submissions, 0, rejectedAt);
      assert.equal(
        (await fixture.state.readSession(fixture.sessionId))?.requests[fixture.requestKey]
          ?.submissionStatus,
        "outcome_unknown",
        rejectedAt,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v13 active lifecycle still blocks B, while bound history with terminal lifecycle releases B", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-v13-lifecycle-matrix-"));
  const bootstrap = historicalBootstrapSelection();
  try {
    // E：active lifecycle + existing Session的原有A/B guard保持不变。
    {
      const statePath = join(directory, "case-e.json");
      const sessionId = "dsh-v13-active-guard";
      const productSessionId = "psn_v13activeguard1";
      const inputA = messageInput(sessionId, "v13活动初始化A");
      const inputB = messageInput(sessionId, "v13活动期间B");
      const promptA = lastUserPrompt(inputA.messages);
      await writeFile(
        statePath,
        `${JSON.stringify({
          schemaVersion: "chat-dsh-lifeos-state.v13",
          newSessionWorkflowPreference: null,
          sessions: {
            [sessionId]: {
              createSessionCommandId: stableCommandId("create-session", sessionId),
              chatSessionId: productSessionId,
              currentRequestKey: promptA.requestKey,
              requests: {
                [promptA.requestKey]: {
                  dshMessageId: promptA.messageId,
                  userTextSha256: promptA.textSha256,
                  messageCommandId: stableCommandId(
                    "submit-message",
                    sessionId,
                    promptA.messageId,
                    promptA.textSha256,
                  ),
                  workflowSelection: bootstrap,
                },
              },
              sessionWorkflowSelection: bootstrap,
              dshSendReviewEnabled: false,
              bridgeDispatchReviewEnabled: false,
              projectBootstrapLifecycle: {
                schemaVersion: "chat-dsh-project-bootstrap-lifecycle.v1",
                lifecycleId: `pbl_${"a".repeat(32)}`,
                status: "active",
                bootstrapWorkflowSelection: bootstrap,
                returnWorkflowSelection: null,
              },
            },
          },
        })}\n`,
        { mode: 0o600 },
      );
      let chatCalls = 0;
      const chat = {
        getCurrentProjectBootstrap: async () => {
          chatCalls += 1;
          return null;
        },
        getRun: async () => {
          chatCalls += 1;
          throw new Error("active lifecycle B不得查询Run");
        },
        submitFirstMessageFromDispatch: async () => {
          chatCalls += 1;
          throw new Error("active lifecycle B不得提交");
        },
        submitMessageFromDispatch: async () => {
          chatCalls += 1;
          throw new Error("active lifecycle B不得提交");
        },
      } as unknown as ChatProductClient;
      const state = new AtomicBridgeStateStore(statePath);
      await state.ready();
      const bytesBefore = await readFile(statePath, "utf8");
      await assert.rejects(
        new LifeosLlmAdapter(chat, state).stream(inputB)[Symbol.asyncIterator]().next(),
        (error) =>
          error instanceof LlmError && error.code === "LIFEOS_PROJECT_BOOTSTRAP_REQUEST_PENDING",
      );
      const binding = await state.readSession(sessionId);
      assert.equal(chatCalls, 0);
      assert.equal(await readFile(statePath, "utf8"), bytesBefore);
      assert.equal(Object.keys(binding?.requests ?? {}).length, 1);
      assert.equal(binding?.currentRequestKey, promptA.requestKey);
      assert.equal(binding?.projectBootstrapLifecycle?.status, "active");
    }

    // F：已经bound的历史Request与terminal lifecycle都不再阻塞下一条普通消息。
    {
      const statePath = join(directory, "case-f.json");
      const sessionId = "dsh-v13-terminal-bound";
      const productSessionId = "psn_v13terminalbound1";
      const inputA = messageInput(sessionId, "已绑定历史A");
      const inputB = messageInput(sessionId, "终态后的普通B");
      const promptA = lastUserPrompt(inputA.messages);
      await writeFile(
        statePath,
        `${JSON.stringify({
          schemaVersion: "chat-dsh-lifeos-state.v13",
          newSessionWorkflowPreference: null,
          sessions: {
            [sessionId]: {
              createSessionCommandId: stableCommandId("create-session", sessionId),
              chatSessionId: productSessionId,
              currentRequestKey: promptA.requestKey,
              requests: {
                [promptA.requestKey]: {
                  dshMessageId: promptA.messageId,
                  userTextSha256: promptA.textSha256,
                  messageCommandId: stableCommandId(
                    "submit-message",
                    sessionId,
                    promptA.messageId,
                    promptA.textSha256,
                  ),
                  productUserMessageId: "msg_v13terminalbounduser1",
                  productRunId: "run_v13terminalbound1",
                  workflowSelection: bootstrap,
                },
              },
              dshSendReviewEnabled: false,
              bridgeDispatchReviewEnabled: false,
              projectBootstrapLifecycle: {
                schemaVersion: "chat-dsh-project-bootstrap-lifecycle.v1",
                lifecycleId: `pbl_${"b".repeat(32)}`,
                status: "ready",
                bootstrapWorkflowSelection: bootstrap,
                returnWorkflowSelection: null,
              },
            },
          },
        })}\n`,
        { mode: 0o600 },
      );
      const submittedPlans: BridgeChatDispatchPlan["submitMessage"][] = [];
      const chat = {
        submitMessageFromDispatch: async (
          observedSessionId: string,
          plan: BridgeChatDispatchPlan["submitMessage"],
        ) => {
          assert.equal(observedSessionId, productSessionId);
          submittedPlans.push(plan);
          return {
            message: { messageId: "msg_v13terminalbuser1", sessionId: productSessionId },
            run: {
              productRunId: "run_v13terminalb1",
              sourceMessageId: "msg_v13terminalbuser1",
              status: "succeeded",
              finalMessageId: "msg_v13terminalbassistant1",
            } as ChatRun,
          };
        },
        getMessage: async () => ({
          messageId: "msg_v13terminalbassistant1",
          role: "assistant",
          content: { format: "markdown", text: "终态没有永久阻塞" },
        }),
      } as unknown as ChatProductClient;
      const state = new AtomicBridgeStateStore(statePath);
      await state.ready();
      const chunks: StreamChunk[] = [];
      for await (const chunk of new LifeosLlmAdapter(chat, state).stream(inputB)) {
        chunks.push(chunk);
      }
      const binding = await state.readSession(sessionId);
      const requestB =
        binding?.currentRequestKey === undefined
          ? undefined
          : binding.requests[binding.currentRequestKey];
      assert.ok(chunks.some((chunk) => chunk.type === "finish"));
      assert.equal(submittedPlans.length, 1);
      assert.equal(submittedPlans[0]?.path, `/api/sessions/${productSessionId}/messages`);
      assert.equal(submittedPlans[0]?.payload.workflowSelection, undefined);
      assert.equal(binding?.requests[promptA.requestKey]?.submissionStatus, "bound");
      assert.equal(requestB?.submissionStatus, "bound");
      assert.equal(binding?.projectBootstrapLifecycle?.status, "ready");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("first-message bind failure leaves outcome_unknown and replays the original first route", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-first-message-binding-"));
  let firstMessageCalls = 0;
  let existingSessionMessageCalls = 0;
  class CrashBeforeThirdMutationStateStore extends AtomicBridgeStateStore {
    private mutationCount = 0;

    override async mutateSession<T>(
      dshSessionId: string,
      createSessionCommandId: string,
      mutate: (binding: SessionBinding) => T,
    ): Promise<T> {
      this.mutationCount += 1;
      if (this.mutationCount === 3) throw new Error("simulated process exit after first response");
      return await super.mutateSession(dshSessionId, createSessionCommandId, mutate);
    }
  }
  try {
    const state = new CrashBeforeThirdMutationStateStore(join(directory, "state.json"));
    await state.ready();
    const run = {
      productRunId: "run_atomicfirst1",
      sourceMessageId: "msg_atomicfirstuser1",
      status: "succeeded",
      finalMessageId: "msg_atomicfirstassistant1",
    } as ChatRun;
    const chat = {
      submitFirstMessageFromDispatch: async () => {
        firstMessageCalls += 1;
        return {
          session: { sessionId: "psn_atomicfirst1" },
          message: { messageId: "msg_atomicfirstuser1", sessionId: "psn_atomicfirst1" },
          run,
        };
      },
      submitMessageFromDispatch: async () => {
        existingSessionMessageCalls += 1;
        throw new Error("same command must not drift to the existing-session route");
      },
      getRun: async () => run,
      getMessage: async () => ({
        messageId: "msg_atomicfirstassistant1",
        role: "assistant",
        content: { format: "markdown", text: "原子绑定恢复成功" },
      }),
    } as unknown as ChatProductClient;
    const adapter = new LifeosLlmAdapter(chat, state);
    const input: GenerateOptions = {
      provider: "lifeos",
      model: "workflow",
      sessionId: "dsh-atomic-first" as never,
      messages: [
        createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: "首轮响应后模拟退出" }],
        }),
      ],
    };

    await assert.rejects(adapter.stream(input)[Symbol.asyncIterator]().next());
    const afterCrash = await state.readSession("dsh-atomic-first");
    const requestKey = afterCrash?.currentRequestKey;
    assert.equal(afterCrash?.chatSessionId, undefined);
    assert.equal(
      requestKey === undefined ? undefined : afterCrash?.requests[requestKey]?.productRunId,
      undefined,
    );
    assert.equal(
      requestKey === undefined ? undefined : afterCrash?.requests[requestKey]?.submissionStatus,
      "outcome_unknown",
    );

    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(input)) chunks.push(chunk);
    assert.ok(chunks.some((chunk) => chunk.type === "finish"));
    assert.equal(firstMessageCalls, 2);
    assert.equal(existingSessionMessageCalls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("DSH与Bridge Trace独立于审核开关且只记录边界摘要", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-trace-boundary-"));
  const dshEvents: TraceEventInput[] = [];
  const bridgeEvents: TraceEventInput[] = [];
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const chat = {
      submitFirstMessageFromDispatch: async () => ({
        session: { sessionId: "psn_traceadapter1" },
        message: { messageId: "msg_traceadapteruser1", sessionId: "psn_traceadapter1" },
        run: {
          productRunId: "run_traceadapter1",
          status: "succeeded",
          finalMessageId: "msg_traceadapterassistant1",
        } as ChatRun,
      }),
      getMessage: async () => ({
        messageId: "msg_traceadapterassistant1",
        role: "assistant",
        content: { format: "markdown", text: "边界追踪完成" },
      }),
    } as unknown as ChatProductClient;
    const adapter = new LifeosLlmAdapter(
      chat,
      state,
      undefined,
      undefined,
      undefined,
      undefined,
      (event) => dshEvents.push(event),
      (event) => bridgeEvents.push(event),
    );
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream({
      provider: "lifeos",
      model: "workflow",
      sessionId: "dsh-trace-boundary" as never,
      messages: [
        createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: "这段正文不能写入Trace" }],
        }),
      ],
    })) {
      chunks.push(chunk);
    }

    assert.ok(chunks.some((chunk) => chunk.type === "finish"));
    assert.equal(dshEvents.length, 1);
    assert.equal(dshEvents[0]?.eventName, "dsh.adapter_request.captured");
    assert.equal(bridgeEvents.length, 1);
    assert.equal(bridgeEvents[0]?.eventName, "bridge.dispatch.prepared");
    [...dshEvents, ...bridgeEvents].forEach((event, index) =>
      traceEventSchema.parse({
        schemaVersion: TRACE_SCHEMA_VERSION,
        eventId: `evt_boundary${String(index + 1)}`,
        timestamp: "2026-08-21T00:00:00.000Z",
        ...event,
      }),
    );
    assert.doesNotMatch(
      JSON.stringify([...dshEvents, ...bridgeEvents]),
      /这段正文不能写入Trace|边界追踪完成/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown submit outcome never reintroduces DSH Workspace instructions outside Prompt selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-retry-instructions-"));
  const submittedInstructions: unknown[] = [];
  let submitAttempts = 0;
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const chat = {
      submitFirstMessageFromDispatch: async (command: {
        payload: { context?: { workspaceInstructions?: unknown } };
      }) => {
        submittedInstructions.push(command.payload.context?.workspaceInstructions);
        submitAttempts += 1;
        if (submitAttempts === 1) {
          throw new ChatProductApiError(
            503,
            "chat_api_unreachable",
            true,
            "retry_same_command",
            "response lost after submit",
          );
        }
        return {
          session: { sessionId: "psn_retryinstructions1" },
          message: {
            messageId: "msg_retryinstructionsuser1",
            sessionId: "psn_retryinstructions1",
          },
          run: {
            productRunId: "run_retryinstructions1",
            status: "succeeded",
            finalMessageId: "msg_retryinstructionsassistant1",
          } as ChatRun,
        };
      },
      getMessage: async () => ({
        messageId: "msg_retryinstructionsassistant1",
        role: "assistant",
        content: { format: "markdown", text: "已按原指令恢复" },
      }),
    } as unknown as ChatProductClient;
    const adapter = new LifeosLlmAdapter(chat, state);
    const directUser = createUserMessage({
      source: { kind: "user" },
      content: [{ type: "text", text: "执行同一请求" }],
    });
    const input = (instructions: string): GenerateOptions => ({
      provider: "lifeos",
      model: "workflow",
      sessionId: "dsh-retry-instructions" as never,
      messages: [
        createUserMessage({
          source: { kind: "agent-instructions", form: "instructions" } as never,
          content: [{ type: "text", text: instructions }],
        }),
        directUser,
      ],
    });

    const first = adapter.stream(input("ORIGINAL_AGENTS_CANARY"))[Symbol.asyncIterator]().next();
    await assert.rejects(first, (error) => error instanceof LlmError && error.code === "TRANSPORT");
    const replayChunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(input("CHANGED_AGENTS_MUST_NOT_REPLACE"))) {
      replayChunks.push(chunk);
    }
    assert.ok(replayChunks.some((chunk) => chunk.type === "finish"));

    assert.deepEqual(submittedInstructions, [undefined, undefined]);
    const binding = await state.readSession("dsh-retry-instructions");
    const request =
      binding?.currentRequestKey === undefined
        ? undefined
        : binding.requests[binding.currentRequestKey];
    assert.equal(request?.workspaceInstructions, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v12 half-bound first message uses the safe existing target for Receipt recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-v12-bootstrap-unknown-"));
  const statePath = join(directory, "state.json");
  const sessionId = "dsh-v12-bootstrap-unknown";
  const input: GenerateOptions = {
    provider: "lifeos",
    model: "workflow",
    sessionId: sessionId as never,
    messages: [
      createUserMessage({
        source: { kind: "user" },
        content: [{ type: "text", text: "恢复响应未知的项目初始化" }],
      }),
    ],
  };
  try {
    const capturingState = new AtomicBridgeStateStore(statePath);
    await capturingState.ready();
    const lostChat = {
      submitFirstMessageFromDispatch: async () => {
        throw new ChatProductApiError(
          503,
          "chat_api_unreachable",
          true,
          "retry_same_command",
          "response lost after Product commit",
        );
      },
    } as unknown as ChatProductClient;
    await assert.rejects(
      new LifeosLlmAdapter(lostChat, capturingState).stream(input)[Symbol.asyncIterator]().next(),
    );
    const captured = await capturingState.readSession(sessionId);
    if (captured?.currentRequestKey === undefined) throw new Error("未冻结响应未知Request");
    const request = captured.requests[captured.currentRequestKey];
    if (request === undefined) throw new Error("响应未知Request不存在");
    const bootstrapSelection = workflowSelectionSchema.parse({
      workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
      definitionSha256: "d".repeat(64),
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
    });
    const {
      submissionTarget: _currentSubmissionTarget,
      submissionStatus: _currentSubmissionStatus,
      ...legacyRequest
    } = request;
    void _currentSubmissionTarget;
    void _currentSubmissionStatus;
    const frozenRequest = { ...legacyRequest, workflowSelection: bootstrapSelection };
    await writeFile(
      statePath,
      `${JSON.stringify({
        schemaVersion: "chat-dsh-lifeos-state.v12",
        preferredWorkflowSelection: bootstrapSelection,
        sessions: {
          [sessionId]: {
            createSessionCommandId: captured.createSessionCommandId,
            chatSessionId: "psn_v12bootstraprecovered1",
            currentRequestKey: captured.currentRequestKey,
            requests: { [captured.currentRequestKey]: frozenRequest },
            workflowSelection: bootstrapSelection,
            dshSendReviewEnabled: false,
            bridgeDispatchReviewEnabled: false,
          },
        },
      })}\n`,
      { mode: 0o600 },
    );

    const migratedState = new AtomicBridgeStateStore(statePath);
    await migratedState.ready();
    const migrated = await migratedState.readSession(sessionId);
    assert.deepEqual(migrated?.requests[captured.currentRequestKey], {
      ...frozenRequest,
      submissionTarget: "existing_session",
      submissionStatus: "outcome_unknown",
    });
    assert.equal(migrated?.chatSessionId, "psn_v12bootstraprecovered1");
    let replayedPlan: { path: string; payload: unknown; commandId: string } | undefined;
    let firstMessageSubmissions = 0;
    const recoveredChat = {
      submitFirstMessageFromDispatch: async () => {
        firstMessageSubmissions += 1;
        throw new Error("legacy state with a Session must not create a second Product Session");
      },
      submitMessageFromDispatch: async (
        observedSessionId: string,
        plan: {
          path: string;
          payload: unknown;
          commandId: string;
        },
      ) => {
        assert.equal(observedSessionId, "psn_v12bootstraprecovered1");
        replayedPlan = plan;
        return {
          message: {
            messageId: "msg_v12bootstraprecovereduser1",
            sessionId: "psn_v12bootstraprecovered1",
          },
          run: {
            productRunId: "run_v12bootstraprecovered1",
            status: "succeeded",
            finalMessageId: "msg_v12bootstraprecoveredassistant1",
          } as ChatRun,
        };
      },
      getMessage: async () => ({
        messageId: "msg_v12bootstraprecoveredassistant1",
        role: "assistant",
        content: { format: "markdown", text: "已从Receipt恢复" },
      }),
    } as unknown as ChatProductClient;

    const chunks: StreamChunk[] = [];
    for await (const chunk of new LifeosLlmAdapter(recoveredChat, migratedState).stream(input)) {
      chunks.push(chunk);
    }
    assert.ok(chunks.some((chunk) => chunk.type === "finish"));
    assert.equal(replayedPlan?.path, "/api/sessions/psn_v12bootstraprecovered1/messages");
    assert.equal(firstMessageSubmissions, 0);
    assert.equal(replayedPlan?.commandId, request.messageCommandId);
    assert.deepEqual((replayedPlan?.payload as { workflowSelection?: unknown }).workflowSelection, {
      kind: "published_revision",
      workflowDefinitionRevisionId: bootstrapSelection.workflowDefinitionRevisionId,
      definitionSha256: bootstrapSelection.definitionSha256,
      runConfiguration: bootstrapSelection.runConfiguration,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v12 composite half-binding persists a safe target and recovers the first Receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-v12-composite-half-binding-"));
  const statePath = join(directory, "state.json");
  const sessionId = "dsh-v12-composite-half-binding";
  const productSessionId = "psn_v12composite1";
  const input: GenerateOptions = {
    provider: "lifeos",
    model: "workflow",
    sessionId: sessionId as never,
    messages: [
      createUserMessage({
        source: { kind: "user" },
        content: [{ type: "text", text: "恢复旧首轮A" }],
      }),
    ],
  };
  const prompt = lastUserPrompt(input.messages);
  const bootstrapSelection = workflowSelectionSchema.parse({
    workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
    definitionSha256: "d".repeat(64),
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
  });
  try {
    await writeFile(
      statePath,
      `${JSON.stringify({
        schemaVersion: "chat-dsh-lifeos-state.v12",
        preferredWorkflowSelection: bootstrapSelection,
        sessions: {
          [sessionId]: {
            createSessionCommandId: stableCommandId("create-session", sessionId),
            chatSessionId: productSessionId,
            currentRequestKey: prompt.requestKey,
            requests: {
              [prompt.requestKey]: {
                dshMessageId: prompt.messageId,
                userTextSha256: prompt.textSha256,
                messageCommandId: stableCommandId(
                  "submit-message",
                  sessionId,
                  prompt.messageId,
                  prompt.textSha256,
                ),
                workflowSelection: bootstrapSelection,
                promptSelection: {
                  schemaVersion: "prompt-turn-selection-input.v1",
                  regions: [],
                },
              },
              "request-b-bound": {
                dshMessageId: "msg_v12compositeb1",
                userTextSha256: "b".repeat(64),
                messageCommandId: stableCommandId("submit-message", sessionId, "request-b"),
                productUserMessageId: "msg_v12compositebuser1",
                productRunId: "run_v12compositeb1",
                workflowSelection: bootstrapSelection,
                promptSelection: {
                  schemaVersion: "prompt-turn-selection-input.v1",
                  regions: [],
                },
              },
            },
            workflowSelection: bootstrapSelection,
            dshSendReviewEnabled: false,
            bridgeDispatchReviewEnabled: false,
          },
        },
      })}\n`,
      { mode: 0o600 },
    );

    const state = new AtomicBridgeStateStore(statePath);
    await state.ready();
    const migrated = await state.readSession(sessionId);
    assert.equal(migrated?.requests[prompt.requestKey]?.submissionTarget, "existing_session");
    let firstSubmissions = 0;
    let replayedPath: string | undefined;
    const chat = {
      submitFirstMessageFromDispatch: async () => {
        firstSubmissions += 1;
        throw new Error("composite legacy target must stay persisted");
      },
      submitMessageFromDispatch: async (observedSessionId: string, plan: { path: string }) => {
        assert.equal(observedSessionId, productSessionId);
        replayedPath = plan.path;
        return {
          message: { messageId: "msg_v12compositeauser1", sessionId: productSessionId },
          run: {
            productRunId: "run_v12compositea1",
            sourceMessageId: "msg_v12compositeauser1",
            status: "succeeded",
            finalMessageId: "msg_v12compositeaassistant1",
          } as ChatRun,
        };
      },
      getMessage: async () => ({
        messageId: "msg_v12compositeaassistant1",
        role: "assistant",
        content: { format: "markdown", text: "复合历史已恢复" },
      }),
    } as unknown as ChatProductClient;

    const chunks: StreamChunk[] = [];
    for await (const chunk of new LifeosLlmAdapter(chat, state).stream(input)) chunks.push(chunk);
    assert.ok(chunks.some((chunk) => chunk.type === "finish"));
    assert.equal(firstSubmissions, 0);
    assert.equal(replayedPath, `/api/sessions/${productSessionId}/messages`);
    assert.equal(
      (await state.readSession(sessionId))?.requests[prompt.requestKey]?.submissionTarget,
      "existing_session",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v13 terminal lifecycle keeps a half-bound Request recoverable on the ordinary route", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-v13-terminal-bootstrap-replay-"));
  const statePath = join(directory, "state.json");
  const sessionId = "dsh-v13-terminal-bootstrap-replay";
  const productSessionId = "psn_v13terminalbootstrap1";
  const input: GenerateOptions = {
    provider: "lifeos",
    model: "workflow",
    sessionId: sessionId as never,
    messages: [
      createUserMessage({
        source: { kind: "user" },
        content: [{ type: "text", text: "恢复已完成的项目初始化首轮" }],
      }),
    ],
  };
  const prompt = lastUserPrompt(input.messages);
  const bootstrapSelection = workflowSelectionSchema.parse({
    workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
    definitionSha256: "d".repeat(64),
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
  });
  try {
    await writeFile(
      statePath,
      `${JSON.stringify({
        schemaVersion: "chat-dsh-lifeos-state.v13",
        newSessionWorkflowPreference: null,
        sessions: {
          [sessionId]: {
            createSessionCommandId: stableCommandId("create-session", sessionId),
            chatSessionId: productSessionId,
            currentRequestKey: prompt.requestKey,
            requests: {
              [prompt.requestKey]: {
                dshMessageId: prompt.messageId,
                userTextSha256: prompt.textSha256,
                messageCommandId: stableCommandId(
                  "submit-message",
                  sessionId,
                  prompt.messageId,
                  prompt.textSha256,
                ),
                workflowSelection: bootstrapSelection,
                promptSelection: {
                  schemaVersion: "prompt-turn-selection-input.v1",
                  regions: [],
                },
              },
            },
            dshSendReviewEnabled: false,
            bridgeDispatchReviewEnabled: false,
            projectBootstrapLifecycle: {
              schemaVersion: "chat-dsh-project-bootstrap-lifecycle.v1",
              lifecycleId: `pbl_${"a".repeat(32)}`,
              status: "ready",
              bootstrapWorkflowSelection: bootstrapSelection,
              returnWorkflowSelection: null,
            },
          },
        },
      })}\n`,
      { mode: 0o600 },
    );

    const state = new AtomicBridgeStateStore(statePath);
    await state.ready();
    const migrated = await state.readSession(sessionId);
    assert.equal(migrated?.requests[prompt.requestKey]?.submissionTarget, "existing_session");
    let replayedPath: string | undefined;
    const chat = {
      submitMessageFromDispatch: async (observedSessionId: string, plan: { path: string }) => {
        assert.equal(observedSessionId, productSessionId);
        replayedPath = plan.path;
        return {
          message: { messageId: "msg_v13terminalbootstrapuser1", sessionId: productSessionId },
          run: {
            productRunId: "run_v13terminalbootstrap1",
            sourceMessageId: "msg_v13terminalbootstrapuser1",
            status: "succeeded",
            finalMessageId: "msg_v13terminalbootstrapassistant1",
          } as ChatRun,
        };
      },
      getMessage: async () => ({
        messageId: "msg_v13terminalbootstrapassistant1",
        role: "assistant",
        content: { format: "markdown", text: "终态专用Receipt已恢复" },
      }),
    } as unknown as ChatProductClient;

    const chunks: StreamChunk[] = [];
    for await (const chunk of new LifeosLlmAdapter(chat, state).stream(input)) chunks.push(chunk);
    assert.ok(chunks.some((chunk) => chunk.type === "finish"));
    assert.equal(replayedPath, `/api/sessions/${productSessionId}/messages`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown Direct submit outcome retries with the request-frozen Prompt selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-retry-prompt-"));
  const submittedSelections: unknown[] = [];
  let submitAttempts = 0;
  const firstSelection = promptSelectionRequestSchema.shape.promptSelection.parse({
    schemaVersion: "prompt-turn-selection-input.v1" as const,
    workspaceRootId: "root_chat",
    regions: [
      {
        regionKey: "rules",
        mode: "append" as const,
        selected: [{ promptFragmentRevisionId: "pfr_customrulesv1", sha256: "a".repeat(64) }],
      },
    ],
  });
  const secondSelection = promptSelectionRequestSchema.shape.promptSelection.parse({
    ...firstSelection,
    regions: [
      {
        regionKey: "rules",
        mode: "replace" as const,
        selected: [{ promptFragmentRevisionId: "pfr_customrulesv2", sha256: "b".repeat(64) }],
      },
    ],
  });
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const createSessionCommandId = stableCommandId("create-session", "dsh-retry-prompt");
    await state.selectWorkflow(
      "dsh-retry-prompt",
      createSessionCommandId,
      workflowSelectionSchema.parse({
        workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
        definitionSha256: "c".repeat(64),
        title: "执行 Agent",
        blueprintKey: "direct",
      }),
    );
    await state.selectPrompt("dsh-retry-prompt", createSessionCommandId, firstSelection);
    const chat = {
      submitFirstMessageFromDispatch: async (command: {
        payload: { promptSelection?: unknown };
      }) => {
        submittedSelections.push(command.payload.promptSelection);
        submitAttempts += 1;
        if (submitAttempts === 1) {
          throw new ChatProductApiError(
            503,
            "chat_api_unreachable",
            true,
            "retry_same_command",
            "response lost after submit",
          );
        }
        return {
          session: { sessionId: "psn_retryprompt1" },
          message: { messageId: "msg_retrypromptuser1", sessionId: "psn_retryprompt1" },
          run: {
            productRunId: "run_retryprompt1",
            status: "succeeded",
            finalMessageId: "msg_retrypromptassistant1",
          } as ChatRun,
        };
      },
      getMessage: async () => ({
        messageId: "msg_retrypromptassistant1",
        role: "assistant",
        content: { format: "markdown", text: "已按冻结选择恢复" },
      }),
    } as unknown as ChatProductClient;
    const adapter = new LifeosLlmAdapter(chat, state, undefined, {
      resolve: () => ({ rootId: "root_chat", title: "Chat" }),
    });
    const directUser = createUserMessage({
      source: { kind: "user" },
      content: [{ type: "text", text: "执行同一请求" }],
    });
    const input: GenerateOptions = {
      provider: "lifeos",
      model: "workflow",
      sessionId: "dsh-retry-prompt" as never,
      messages: [directUser],
    };

    await assert.rejects(
      adapter.stream(input)[Symbol.asyncIterator]().next(),
      (error) => error instanceof LlmError && error.code === "TRANSPORT",
    );
    await state.selectPrompt("dsh-retry-prompt", createSessionCommandId, secondSelection);
    const replayChunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(input)) replayChunks.push(chunk);
    assert.ok(replayChunks.some((chunk) => chunk.type === "finish"));
    assert.deepEqual(submittedSelections, [firstSelection, firstSelection]);

    const binding = await state.readSession("dsh-retry-prompt");
    const request =
      binding?.currentRequestKey === undefined
        ? undefined
        : binding.requests[binding.currentRequestKey];
    assert.deepEqual(request?.promptSelection, firstSelection);
    assert.deepEqual(binding?.promptSelection, secondSelection);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
