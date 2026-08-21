import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createUserMessage,
  LlmError,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { LifeosLlmAdapter, sha256, stableCommandId } from "../src/adapter.ts";
import { prepareBridgeChatDispatch } from "../src/bridge-chat-dispatch.ts";
import { BridgeDispatchReviewCoordinator } from "../src/bridge-dispatch-review.ts";
import { LifeosBridgeService } from "../src/bridge-service.ts";
import type { ChatProductClient } from "../src/chat-client.ts";
import { promptTurnPreviewFixture } from "./prompt-turn-preview-fixture.ts";
import {
  dshBridgeSendPreviewSchema,
  type BridgeChatDispatchPlan,
  type ChatRun,
} from "../src/contracts.ts";
import { DshSendReviewCoordinator } from "../src/dsh-send-review.ts";
import { AtomicBridgeStateStore } from "../src/state-store.ts";

function plan(requestKey = "a".repeat(48)): BridgeChatDispatchPlan {
  return prepareBridgeChatDispatch({
    requestKey,
    messageCommandId: `cmd_${"c".repeat(48)}`,
    text: "审核后发送",
  });
}

async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForReview<T>(read: () => T | null, label: string): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const review = read();
    if (review !== null) return review;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} did not open`);
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test("Bridge dispatch coordinator is off by default and binds decisions to exact plan hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-bridge-dispatch-review-"));
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const coordinator = new BridgeDispatchReviewCoordinator(state);
    const currentPlan = plan();
    assert.equal(
      await coordinator.waitForDecision({ dshSessionId: "dsh-dispatch", plan: currentPlan }),
      "disabled",
    );

    await state.setBridgeDispatchReviewEnabled(
      "dsh-dispatch",
      stableCommandId("create-session", "dsh-dispatch"),
      true,
    );
    const approved = coordinator.waitForDecision({
      dshSessionId: "dsh-dispatch",
      plan: currentPlan,
    });
    await nextTick();
    const review = coordinator.current("dsh-dispatch");
    assert.notEqual(review, null);
    assert.equal(
      coordinator.decide("dsh-dispatch", review!.reviewId, "0".repeat(64), "approve"),
      false,
    );
    assert.equal(coordinator.current("dsh-dispatch")?.reviewId, review?.reviewId);
    assert.equal(
      coordinator.decide("dsh-dispatch", review!.reviewId, currentPlan.planSha256, "approve"),
      true,
    );
    assert.equal(await approved, "approve");

    const rejected = coordinator.waitForDecision({
      dshSessionId: "dsh-dispatch",
      plan: plan("d".repeat(48)),
    });
    await nextTick();
    const rejection = coordinator.current("dsh-dispatch");
    assert.notEqual(rejection, null);
    assert.equal(
      coordinator.decide("dsh-dispatch", rejection!.reviewId, rejection!.plan.planSha256, "reject"),
      true,
    );
    assert.equal(await rejected, "reject");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("disabling the Bridge gate releases its current request and Host close rejects it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-bridge-dispatch-release-"));
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const coordinator = new BridgeDispatchReviewCoordinator(state);
    const service = new LifeosBridgeService(
      {} as ChatProductClient,
      state,
      undefined,
      undefined,
      undefined,
      undefined,
      coordinator,
    );
    const dshSessionId = "dsh-dispatch-release";
    await state.setBridgeDispatchReviewEnabled(
      dshSessionId,
      stableCommandId("create-session", dshSessionId),
      true,
    );
    const released = coordinator.waitForDecision({ dshSessionId, plan: plan() });
    await nextTick();
    await service.setBridgeDispatchReviewEnabled(dshSessionId, false);
    assert.equal(await released, "approve");
    assert.equal(coordinator.current(dshSessionId), null);
    assert.equal(await state.readBridgeDispatchReviewEnabled(dshSessionId), false);

    await state.setBridgeDispatchReviewEnabled(
      dshSessionId,
      stableCommandId("create-session", dshSessionId),
      true,
    );
    const closed = coordinator.waitForDecision({
      dshSessionId,
      plan: plan("e".repeat(48)),
    });
    await nextTick();
    coordinator.close();
    assert.equal(await closed, "reject");
    assert.equal(coordinator.current(dshSessionId), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("two enabled gates require DSH approval before Bridge approval and reject performs zero Chat writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-two-send-gates-"));
  let firstMessageCalls = 0;
  let existingSessionMessageCalls = 0;
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const dshReview = new DshSendReviewCoordinator(
      state,
      async (dshSessionId, text, adapterRequest) => {
        const payloadJson = JSON.stringify({ text });
        return dshBridgeSendPreviewSchema.parse({
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
            userInput: { text, sha256: sha256(text) },
            contextInjections: {
              schemaVersion: "chat-dsh-context-injections.v1",
              dshSessionId,
              status: "ready",
              revision: "f".repeat(64),
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
            payloadJson,
            payloadSha256: sha256(payloadJson),
          },
        });
      },
    );
    const bridgeReview = new BridgeDispatchReviewCoordinator(state);
    const chat = {
      submitFirstMessageFromDispatch: async (_command: BridgeChatDispatchPlan["submitMessage"]) => {
        firstMessageCalls += 1;
        return {
          session: { sessionId: "psn_twogates1" },
          message: { messageId: "msg_twogatesuser1", sessionId: "psn_twogates1" },
          run: {
            productRunId: "run_twogates1",
            status: "succeeded",
            finalMessageId: "msg_twogatesassistant1",
          } as ChatRun,
        };
      },
      submitMessageFromDispatch: async (
        _sessionId: string,
        _command: BridgeChatDispatchPlan["submitMessage"],
      ) => {
        existingSessionMessageCalls += 1;
        return {
          message: { messageId: "msg_twogatesuser1" },
          run: {
            productRunId: "run_twogates1",
            status: "succeeded",
            finalMessageId: "msg_twogatesassistant1",
          } as ChatRun,
        };
      },
      getMessage: async () => ({
        messageId: "msg_twogatesassistant1",
        role: "assistant",
        content: { format: "markdown", text: "三个审核边界均可继续" },
      }),
    } as unknown as ChatProductClient;
    const adapter = new LifeosLlmAdapter(
      chat,
      state,
      undefined,
      undefined,
      dshReview,
      bridgeReview,
    );
    const input = (dshSessionId: string): GenerateOptions => ({
      provider: "lifeos",
      model: "workflow",
      sessionId: dshSessionId as never,
      messages: [
        createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: "依次审核" }],
        }),
      ],
    });
    for (const dshSessionId of ["dsh-two-gates-approve", "dsh-two-gates-reject"]) {
      const commandId = stableCommandId("create-session", dshSessionId);
      await state.setDshSendReviewEnabled(dshSessionId, commandId, true);
      await state.setBridgeDispatchReviewEnabled(dshSessionId, commandId, true);
    }

    const approved = collect(adapter.stream(input("dsh-two-gates-approve")));
    const firstGate = await waitForReview(
      () => dshReview.current("dsh-two-gates-approve"),
      "DSH review",
    );
    assert.equal(bridgeReview.current("dsh-two-gates-approve"), null);
    assert.deepEqual(
      { firstMessageCalls, existingSessionMessageCalls },
      { firstMessageCalls: 0, existingSessionMessageCalls: 0 },
    );
    assert.equal(dshReview.decide("dsh-two-gates-approve", firstGate.reviewId, "approve"), true);

    const secondGate = await waitForReview(
      () => bridgeReview.current("dsh-two-gates-approve"),
      "Bridge review",
    );
    assert.equal(dshReview.current("dsh-two-gates-approve"), null);
    assert.equal(secondGate.plan.submitMessage.path, "/api/messages");
    assert.deepEqual(
      { firstMessageCalls, existingSessionMessageCalls },
      { firstMessageCalls: 0, existingSessionMessageCalls: 0 },
    );
    assert.equal(
      bridgeReview.decide(
        "dsh-two-gates-approve",
        secondGate.reviewId,
        secondGate.plan.planSha256,
        "approve",
      ),
      true,
    );
    const chunks = await approved;
    assert.equal(
      chunks.find((chunk) => chunk.type === "text-delta")?.type === "text-delta"
        ? chunks.find((chunk) => chunk.type === "text-delta")?.text
        : undefined,
      "三个审核边界均可继续",
    );
    assert.deepEqual(
      { firstMessageCalls, existingSessionMessageCalls },
      { firstMessageCalls: 1, existingSessionMessageCalls: 0 },
    );

    const rejected = collect(adapter.stream(input("dsh-two-gates-reject")));
    const rejectFirstGate = await waitForReview(
      () => dshReview.current("dsh-two-gates-reject"),
      "DSH review",
    );
    assert.equal(
      dshReview.decide("dsh-two-gates-reject", rejectFirstGate.reviewId, "approve"),
      true,
    );
    const rejectSecondGate = await waitForReview(
      () => bridgeReview.current("dsh-two-gates-reject"),
      "Bridge review",
    );
    assert.deepEqual(
      { firstMessageCalls, existingSessionMessageCalls },
      { firstMessageCalls: 1, existingSessionMessageCalls: 0 },
    );
    assert.equal(
      bridgeReview.decide(
        "dsh-two-gates-reject",
        rejectSecondGate.reviewId,
        rejectSecondGate.plan.planSha256,
        "reject",
      ),
      true,
    );
    await assert.rejects(
      rejected,
      (error) => error instanceof LlmError && error.code === "LIFEOS_BRIDGE_DISPATCH_REJECTED",
    );
    assert.deepEqual(
      { firstMessageCalls, existingSessionMessageCalls },
      { firstMessageCalls: 1, existingSessionMessageCalls: 0 },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
