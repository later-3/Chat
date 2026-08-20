import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LifeosBridgeService, BridgeRequestError } from "../src/bridge-service.ts";
import type { ChatProductClient } from "../src/chat-client.ts";
import { promptSelectionRequestSchema } from "../src/contracts.ts";
import { AtomicBridgeStateStore } from "../src/state-store.ts";

test("prompt selection is bound to the Host-resolved workspace and stored per DSH session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-prompt-selection-"));
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const service = new LifeosBridgeService({} as ChatProductClient, state, undefined, undefined, {
      resolve: (dshSessionId) =>
        dshSessionId === "dsh-session-1" ? { rootId: "root_chat", title: "Chat" } : null,
    });

    assert.deepEqual(await service.promptSelection("dsh-session-1"), {
      schemaVersion: "chat-dsh-prompt-selection.v1",
      workspace: { rootId: "root_chat", title: "Chat" },
      promptSelection: {
        schemaVersion: "prompt-turn-selection-input.v1",
        workspaceRootId: "root_chat",
        regions: [],
      },
    });

    const selected = promptSelectionRequestSchema.shape.promptSelection.parse({
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
    assert.deepEqual(
      (await service.selectPrompt("dsh-session-1", selected)).promptSelection,
      selected,
    );
    assert.deepEqual(await state.readPromptSelection("dsh-session-1"), selected);

    await assert.rejects(
      service.selectPrompt("dsh-session-2", selected),
      (error) =>
        error instanceof BridgeRequestError && error.code === "lifeos_prompt_workspace_stale",
    );
    assert.deepEqual(await service.promptSelection("dsh-session-2"), {
      schemaVersion: "chat-dsh-prompt-selection.v1",
      workspace: null,
      promptSelection: { schemaVersion: "prompt-turn-selection-input.v1", regions: [] },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
