import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dshBridgeSendPreviewSchema } from "../src/contracts.ts";
import { DshSendReviewCoordinator } from "../src/dsh-send-review.ts";
import { AtomicBridgeStateStore } from "../src/state-store.ts";

const commandId = `cmd_${"a".repeat(48)}`;
const preview = dshBridgeSendPreviewSchema.parse({
  schemaVersion: "chat-dsh-bridge-send-preview.v2",
  boundary: "dsh_to_lifeos_bridge",
  status: "pre_send_projection",
  workspace: null,
  workflowSelection: null,
  promptSelection: { schemaVersion: "prompt-turn-selection-input.v1", regions: [] },
  promptConfiguration: null,
  dshToBridge: {
    adapterRequest: {
      status: "captured",
      requestJson: '{"provider":"lifeos"}',
      requestSha256: "d".repeat(64),
    },
    userInput: { text: "审核后发送", sha256: "b".repeat(64) },
    contextInjections: {
      schemaVersion: "chat-dsh-context-injections.v1",
      dshSessionId: "dsh-review",
      status: "ready",
      revision: "c".repeat(64),
      chatForwarding: "latest_direct_user_message_and_workspace_instructions",
      items: [],
      totalItems: 0,
      omittedItems: 0,
      totalContentCharacters: 0,
    },
  },
  bridgeToChat: {
    policy: "non_direct_workspace_instructions",
    payload: { text: "审核后发送" },
    payloadJson: '{"text":"审核后发送"}',
    payloadSha256: "e".repeat(64),
  },
});

const adapterRequest = preview.dshToBridge.adapterRequest;

test("DSH send review is disabled by default and pauses only while enabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-send-review-"));
  const path = join(directory, "state.json");
  try {
    const state = new AtomicBridgeStateStore(path);
    await state.ready();
    let previews = 0;
    const coordinator = new DshSendReviewCoordinator(state, async () => {
      previews += 1;
      return preview;
    });
    assert.equal(
      await coordinator.waitForDecision({
        dshSessionId: "dsh-review",
        requestKey: "request-1",
        text: "审核后发送",
        adapterRequest,
      }),
      "disabled",
    );
    assert.equal(previews, 0);

    await state.setDshSendReviewEnabled("dsh-review", commandId, true);
    const waiting = coordinator.waitForDecision({
      dshSessionId: "dsh-review",
      requestKey: "request-1",
      text: "审核后发送",
      adapterRequest,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const review = coordinator.current("dsh-review");
    assert.equal(previews, 1);
    assert.equal(review?.preview.dshToBridge.userInput.text, "审核后发送");
    assert.equal(
      coordinator.decide("dsh-review", "dsr_00000000000000000000000000000000", "approve"),
      false,
    );
    assert.equal(coordinator.decide("dsh-review", review!.reviewId, "approve"), true);
    assert.equal(await waiting, "approve");
    assert.equal(coordinator.current("dsh-review"), null);
    assert.doesNotMatch(await readFile(path, "utf8"), /审核后发送/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("turning the switch off releases an already waiting send", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-send-review-off-"));
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    await state.setDshSendReviewEnabled("dsh-review", commandId, true);
    const coordinator = new DshSendReviewCoordinator(state, async () => preview);
    const waiting = coordinator.waitForDecision({
      dshSessionId: "dsh-review",
      requestKey: "request-2",
      text: "审核后发送",
      adapterRequest,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    coordinator.approveCurrent("dsh-review");
    assert.equal(await waiting, "approve");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
