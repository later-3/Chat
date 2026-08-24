import assert from "node:assert/strict";
import test from "node:test";
import type { ChatProductClient } from "../src/chat-client.ts";
import {
  PromptStudioBridgeService,
  agentVersionCreateRequestSchema,
} from "../src/prompt-studio-bridge-service.ts";

test("Prompt Studio service forwards the optional Agent Profile workspace scope to Chat", async () => {
  const calls: unknown[] = [];
  const response = { schemaVersion: "chat-agent-profile-api.v3", items: [] };
  const chat = {
    getAgentProfiles: async (workspaceRootId?: string) => {
      calls.push(workspaceRootId);
      return response;
    },
  } as unknown as ChatProductClient;
  const service = new PromptStudioBridgeService(chat);

  assert.equal(await service.agents(), response);
  assert.equal(await service.agents({ workspaceRootId: "root_chat" }), response);
  assert.deepEqual(calls, [undefined, "root_chat"]);
});

test("Prompt Studio service forwards an immutable Agent Version command to Chat", async () => {
  const calls: unknown[] = [];
  const response = { agentKey: "direct", versions: [{ agentVersionId: "avn_servicev1" }] };
  const chat = {
    createAgentVersion: async (agentKey: string, commandId: string, payload: unknown) => {
      calls.push({ agentKey, commandId, payload });
      return response;
    },
  } as unknown as ChatProductClient;
  const service = new PromptStudioBridgeService(chat);
  const request = agentVersionCreateRequestSchema.parse({
    commandId: "cmd_agentservicev1",
    payload: {
      title: "Direct Agent · Service版本",
      description: "验证DSH Host只做协议转换。",
      scope: { kind: "global" },
      runtime: { kind: "pi_coding_agent", baseVariantKey: "pi_cli_default" },
      systemPrompt: { mode: "inherit_runtime" },
      enabledToolNames: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      resources: {
        contextFiles: "inherit_runtime_default",
        skills: "inherit_runtime_default",
        promptTemplates: "inherit_runtime_default",
        extensions: "inherit_runtime_default",
      },
    },
  });

  assert.equal(await service.createAgentVersion("direct", request), response);
  assert.deepEqual(calls, [
    {
      agentKey: "direct",
      commandId: "cmd_agentservicev1",
      payload: request.payload,
    },
  ]);
});
