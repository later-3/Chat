import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promptConfigurationPreviewDtoSchema } from "@chat/contracts/public";
import { sha256 } from "../src/adapter.ts";
import { LifeosBridgeService, BridgeRequestError } from "../src/bridge-service.ts";
import type { ChatProductClient } from "../src/chat-client.ts";
import { promptSelectionRequestSchema, workflowSelectionSchema } from "../src/contracts.ts";
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

test("DSH发送预览按Direct与非Direct政策投影真正的Bridge到Chat payload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-dsh-send-preview-"));
  try {
    const state = new AtomicBridgeStateStore(join(directory, "state.json"));
    await state.ready();
    const contextProjection = {
      schemaVersion: "chat-dsh-context-injections.v1" as const,
      dshSessionId: "dsh-session-1",
      status: "ready" as const,
      revision: "b".repeat(64),
      chatForwarding: "latest_direct_user_message_and_workspace_instructions" as const,
      items: [
        {
          messageId: "ctx-1",
          sourceKind: "agent-instructions",
          sourceName: null,
          form: "instructions" as const,
          sourceDetails: ["AGENTS.md"],
          sourceDetailsTruncated: false,
          text: "# Workspace规则",
          contentCharacters: 14,
          truncated: false,
          unsupportedContentBlockCount: 0,
        },
      ],
      totalItems: 1,
      omittedItems: 0,
      totalContentCharacters: 14,
    };
    const promptConfiguration = promptConfigurationPreviewDtoSchema.parse({
      schemaVersion: "chat-prompt-studio-api.v1",
      profileVersion: "direct-agent-prompt-profile.v1",
      compilerVersion: "direct-agent-prompt-compiler.v1",
      regions: [],
      systemPromptAppend: "# Agent身份\n\n协作处理任务。",
      messageContext: "# 规则\n\n保持来源透明。",
      sha256: "e".repeat(64),
    });
    const chat = {
      previewPromptConfiguration: async () => promptConfiguration,
    } as unknown as ChatProductClient;
    const service = new LifeosBridgeService(
      chat,
      state,
      undefined,
      {
        read: () => contextProjection,
        workspaceInstructions: () => ({
          schemaVersion: "workspace-instructions-input.v1",
          items: [{ content: "# Workspace规则" }],
        }),
      },
      { resolve: () => ({ rootId: "root_chat", title: "Chat" }) },
    );
    const promptSelection = promptSelectionRequestSchema.shape.promptSelection.parse({
      schemaVersion: "prompt-turn-selection-input.v1",
      workspaceRootId: "root_chat",
      regions: [],
    });
    await service.selectPrompt("dsh-session-1", promptSelection);

    await service.selectWorkflow(
      "dsh-session-1",
      workflowSelectionSchema.parse({
        workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
        definitionSha256: "c".repeat(64),
        title: "执行 Agent（逐次提示词审核）",
        blueprintKey: "direct",
      }),
    );
    const adapterRequestJson = JSON.stringify(
      {
        provider: "lifeos",
        model: "workflow",
        system: "DSH真实系统提示词",
        messages: [
          {
            id: "msg-dsh-user",
            role: "user",
            source: { kind: "user" },
            content: [{ type: "text", text: "检查项目" }],
          },
        ],
      },
      null,
      2,
    );
    const traceLogs: unknown[] = [];
    const originalConsoleInfo = console.info;
    console.info = (...args: unknown[]) => {
      traceLogs.push(args);
    };
    const direct = await (async () => {
      try {
        return await service.bridgeSendPreview("dsh-session-1", "检查项目", {
          status: "captured",
          requestJson: adapterRequestJson,
          requestSha256: sha256(adapterRequestJson),
        });
      } finally {
        console.info = originalConsoleInfo;
      }
    })();
    assert.equal(direct.bridgeToChat.policy, "direct_prompt_selection");
    assert.deepEqual(direct.promptConfiguration, promptConfiguration);
    assert.deepEqual(direct.bridgeToChat.payload.promptSelection, promptSelection);
    assert.equal(direct.bridgeToChat.payload.context, undefined);
    assert.equal(direct.dshToBridge.contextInjections.items[0]?.text, "# Workspace规则");
    assert.equal(traceLogs.length, 1);
    assert.match(JSON.stringify(traceLogs), /lifeos\.dsh_to_chat_payload\.projected/u);
    assert.match(JSON.stringify(traceLogs), /"payloadTextMatchesExtractedUserInput":true/u);
    assert.match(JSON.stringify(traceLogs), /"payloadTextMatchesDshRawUserInput":true/u);
    assert.match(JSON.stringify(traceLogs), /\/messages\/0\/content\/0\/text/u);
    assert.doesNotMatch(JSON.stringify(traceLogs), /检查项目|DSH真实系统提示词/u);

    const mismatchedRequestJson = adapterRequestJson.replace("检查项目", "另一条原始输入");
    await assert.rejects(
      service.bridgeSendPreview("dsh-session-1", "检查项目", {
        status: "captured",
        requestJson: mismatchedRequestJson,
        requestSha256: sha256(mismatchedRequestJson),
      }),
      (error) =>
        error instanceof BridgeRequestError && error.code === "lifeos_dsh_raw_mapping_mismatch",
    );

    await service.selectWorkflow(
      "dsh-session-1",
      workflowSelectionSchema.parse({
        workflowDefinitionRevisionId: "wfr_systemplanningv1",
        definitionSha256: "d".repeat(64),
        title: "规划执行工作流",
        blueprintKey: "planning",
      }),
    );
    const planning = await service.bridgeSendPreview("dsh-session-1", "规划项目");
    assert.equal(planning.bridgeToChat.policy, "non_direct_workspace_instructions");
    assert.equal(planning.promptConfiguration, null);
    assert.deepEqual(planning.bridgeToChat.payload.context, {
      workspaceInstructions: {
        schemaVersion: "workspace-instructions-input.v1",
        items: [{ content: "# Workspace规则" }],
      },
    });
    assert.equal(planning.bridgeToChat.payload.promptSelection, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
