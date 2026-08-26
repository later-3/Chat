import assert from "node:assert/strict";
import test from "node:test";
import { promptFragmentSummaryDtoSchema } from "@chat/contracts/public";
import { PromptComposerController } from "../src/client/prompt-composer-controller.ts";
import { promptTurnPreviewFixture } from "./prompt-turn-preview-fixture.ts";

const SHA = "a".repeat(64);
const ROOT_ID = "root_chat";
const SESSION_ID = "dsh-prompt-composer-test";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const region = {
  schemaVersion: "chat-prompt-studio-api.v1",
  regionKey: "rules",
  title: "规则与规范",
  description: "本轮必须遵守的规则。",
  category: "context",
  plannedPlacement: "messages",
  contentKind: "markdown",
  cardinality: "multiple",
  userManageable: true,
  availability: "active",
  stableOrder: 60,
  catalogRevision: 1,
  sha256: SHA,
  sourceRelativePath: "prompts/regions/catalog.md",
} as const;

const globalFragment = {
  schemaVersion: "chat-prompt-studio-api.v1",
  promptFragmentId: "pfg_globalrules",
  ownerKind: "principal",
  scope: { kind: "global" },
  status: "active",
  regionKey: "rules",
  title: "全局证据规则",
  contentKind: "markdown",
  currentRevisionId: "pfr_globalrulesv1",
  currentRevisionNumber: 1,
  currentRevisionSha256: SHA,
  revision: 1,
  updatedAt: "2026-08-20T00:00:00.000Z",
  allowedActions: ["revise", "archive"],
} as const;

const workspaceFragment = promptFragmentSummaryDtoSchema.parse({
  ...globalFragment,
  promptFragmentId: "pfg_workspacerules",
  scope: { kind: "workspace", rootId: ROOT_ID },
  title: "Chat Workspace 规则",
  currentRevisionId: "pfr_workspacerulesv1",
});

const emptySelection = {
  schemaVersion: "prompt-turn-selection-input.v1",
  workspaceRootId: ROOT_ID,
  regions: [],
} as const;

const workflowSelection = {
  schemaVersion: "prompt-turn-selection-input.v2",
  workspaceRootId: ROOT_ID,
  workflowDefinitionRevisionId: "wfr_promptworkflow1",
  regions: [],
  nodeSelections: [],
} as const;

async function untilSaved(controller: PromptComposerController): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!controller.getSnapshot().saving) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Prompt选择没有完成保存");
}

test("每个Region独立选择模式并把精确Revision按顺序PUT到Bridge", async () => {
  const storage = new MemoryStorage();
  const writes: unknown[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "/lifeos/prompts/regions") {
      return json({
        schemaVersion: "chat-prompt-studio-api.v1",
        catalogSha256: SHA,
        items: [region],
      });
    }
    if (url === "/lifeos/prompts/fragments?limit=100") {
      return json({
        schemaVersion: "chat-prompt-studio-api.v1",
        items: [globalFragment, workspaceFragment],
      });
    }
    if (url === "/lifeos/prompts/workspaces") {
      return json({
        schemaVersion: "chat-prompt-studio-api.v1",
        items: [{ schemaVersion: "chat-prompt-studio-api.v1", rootId: ROOT_ID, title: "Chat" }],
      });
    }
    if (url.endsWith("/prompt-selection") && init?.method !== "PUT") {
      return json({
        schemaVersion: "chat-dsh-prompt-selection.v1",
        workspace: { rootId: ROOT_ID, title: "Chat" },
        workflow: {
          workflowDefinitionRevisionId: "wfr_promptworkflow1",
          title: "规划执行工作流",
        },
        promptSelection: workflowSelection,
      });
    }
    if (url.endsWith("/prompt-selection") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { promptSelection: unknown };
      writes.push(body);
      return json({
        schemaVersion: "chat-dsh-prompt-selection.v1",
        workspace: { rootId: ROOT_ID, title: "Chat" },
        workflow: {
          workflowDefinitionRevisionId: "wfr_promptworkflow1",
          title: "规划执行工作流",
        },
        promptSelection: body.promptSelection,
      });
    }
    return json({ code: "not_found", title: "not found" }, 404);
  };
  const controller = new PromptComposerController(SESSION_ID, fetchImpl, storage);
  await controller.load();
  controller.setMode("rules", "append");
  await untilSaved(controller);
  assert.equal(controller.getSnapshot().selection.regions[0]?.mode, "append");
  assert.deepEqual(
    controller
      .getSnapshot()
      .selection.regions[0]?.selected.map((item) => item.promptFragmentRevisionId),
    ["pfr_globalrulesv1"],
  );

  controller.toggleRevision(workspaceFragment);
  await untilSaved(controller);
  assert.deepEqual(
    controller
      .getSnapshot()
      .selection.regions[0]?.selected.map((item) => item.promptFragmentRevisionId),
    ["pfr_globalrulesv1", "pfr_workspacerulesv1"],
  );
  controller.setMode("rules", "replace");
  await untilSaved(controller);
  controller.toggleRevision(workspaceFragment);
  await untilSaved(controller);
  const selected = controller.getSnapshot().selection;
  assert.equal(selected.schemaVersion, "prompt-turn-selection-input.v2");
  if (selected.schemaVersion !== "prompt-turn-selection-input.v2") {
    assert.fail("Workflow绑定的会话Prompt选择应保持V2兼容形状");
  }
  assert.deepEqual(
    selected.regions[0]?.selected.map((item) => item.promptFragmentRevisionId),
    ["pfr_globalrulesv1"],
  );
  assert.deepEqual(selected.nodeSelections, []);
  assert.equal(writes.length, 4);

  const restored = new PromptComposerController(SESSION_ID, fetchImpl, storage);
  const restoredSelection = restored.getSnapshot().selection;
  assert.equal(restoredSelection.regions[0]?.selected.length, 1);
  assert.equal(
    restoredSelection.schemaVersion === "prompt-turn-selection-input.v2"
      ? restoredSelection.nodeSelections.length
      : -1,
    0,
  );
  restored.dispose();
  controller.dispose();
});

test("提示词配置预览与DSH Bridge发送预览保持两个独立边界", async () => {
  let configurationRequest: { selection?: unknown } | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "/lifeos/prompts/regions") {
      return json({
        schemaVersion: "chat-prompt-studio-api.v1",
        catalogSha256: SHA,
        items: [region],
      });
    }
    if (url === "/lifeos/prompts/fragments?limit=100") {
      return json({ schemaVersion: "chat-prompt-studio-api.v1", items: [globalFragment] });
    }
    if (url === "/lifeos/prompts/workspaces") {
      return json({ schemaVersion: "chat-prompt-studio-api.v1", items: [] });
    }
    if (url.endsWith("/prompt-selection") && init?.method !== "PUT") {
      return json({
        schemaVersion: "chat-dsh-prompt-selection.v1",
        workspace: { rootId: ROOT_ID, title: "Chat" },
        promptSelection: emptySelection,
      });
    }
    if (url === "/lifeos/prompts/configuration-previews") {
      configurationRequest = JSON.parse(String(init?.body)) as typeof configurationRequest;
      return json({
        schemaVersion: "chat-prompt-studio-api.v1",
        profileVersion: "direct-agent-prompt-profile.v1",
        compilerVersion: "direct-agent-prompt-compiler.v1",
        regions: [],
        systemPromptAppend: "",
        messageContext: "",
        sha256: SHA,
      });
    }
    if (url.endsWith("/bridge-send-previews")) {
      return json({
        schemaVersion: "chat-dsh-bridge-send-preview.v2",
        boundary: "dsh_to_lifeos_bridge",
        status: "pre_send_projection",
        workspace: { rootId: ROOT_ID, title: "Chat" },
        workflowSelection: {
          workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
          definitionSha256: SHA,
          title: "执行 Agent（逐次提示词审核）",
          blueprintKey: "direct",
          runConfiguration: {
            schemaVersion: "workflow-run-configuration.v1",
            overrides: [],
          },
        },
        promptSelection: emptySelection,
        promptConfiguration: {
          schemaVersion: "chat-prompt-studio-api.v1",
          profileVersion: "direct-agent-prompt-profile.v1",
          compilerVersion: "direct-agent-prompt-compiler.v1",
          regions: [],
          systemPromptAppend: "",
          messageContext: "",
          sha256: SHA,
        },
        promptTurnPreview: promptTurnPreviewFixture("这是一个什么项目？"),
        dshToBridge: {
          adapterRequest: {
            status: "not_captured",
            reason: "native_send_not_started",
          },
          userInput: { text: "这是一个什么项目？", sha256: SHA },
          contextInjections: {
            schemaVersion: "chat-dsh-context-injections.v1",
            dshSessionId: SESSION_ID,
            status: "not_assembled",
            revision: SHA,
            chatForwarding: "not_forwarded",
            items: [],
            totalItems: 0,
            omittedItems: 0,
            totalContentCharacters: 0,
          },
        },
        bridgeToChat: {
          policy: "direct_prompt_selection",
          payload: {
            text: "这是一个什么项目？",
            workflowSelection: {
              kind: "published_revision",
              workflowDefinitionRevisionId: "wfr_systemdirectagentv1",
              definitionSha256: SHA,
              runConfiguration: {
                schemaVersion: "workflow-run-configuration.v1",
                overrides: [],
              },
            },
            promptSelection: emptySelection,
          },
          payloadJson: JSON.stringify({ text: "这是一个什么项目？" }),
          payloadSha256: SHA,
        },
      });
    }
    return json({ code: "not_found", title: "not found" }, 404);
  };
  const controller = new PromptComposerController(SESSION_ID, fetchImpl, new MemoryStorage());
  await controller.load();
  const configuration = await controller.previewConfiguration();
  assert.equal(configuration?.messageContext, "");
  assert.deepEqual(configurationRequest?.selection, emptySelection);
  const bridge = await controller.previewBridgeSend("这是一个什么项目？");
  assert.equal(bridge?.dshToBridge.userInput.text, "这是一个什么项目？");
  assert.equal(bridge?.bridgeToChat.policy, "direct_prompt_selection");
  assert.equal(bridge?.dshToBridge.adapterRequest.status, "not_captured");
  assert.equal(bridge?.bridgeToChat.payload.text, "这是一个什么项目？");
  controller.dispose();
});
