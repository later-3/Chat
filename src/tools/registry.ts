import { PROJECT_SEARCH_TOOL_PROVIDER } from "./builtins/project-search/index.js";
import { PROJECT_READ_TOOL_PROVIDER } from "./builtins/project-read/index.js";
import { PROJECT_CREATE_TOOL_PROVIDER } from "./builtins/project-create/index.js";
import { PROJECT_OPEN_TOOL_PROVIDER } from "./builtins/project-open/index.js";
import { PROJECT_UPDATE_TOOL_PROVIDER } from "./builtins/project-update/index.js";
import { PROJECT_CONFIGURE_TOOL_PROVIDER } from "./builtins/project-configure/index.js";
import type { ChatToolRuntimeContext, ResolvedChatTool } from "./framework.js";
import { MEMORY_RECORD_TOOL_PROVIDER } from "./builtins/memory-record/index.js";
import { MEMORY_SEARCH_TOOL_PROVIDER } from "./builtins/memory-search/index.js";
import { WORKFLOW_CALL_TOOL_PROVIDER } from "./builtins/workflow-call/index.js";
import { AGENT_MEMORY_SEARCH_TOOL_PROVIDER } from "./builtins/agent-memory-search/index.js";
import { AGENT_MEMORY_READ_TOOL_PROVIDER } from "./builtins/agent-memory-read/index.js";
import { AGENT_MEMORY_WRITE_TOOL_PROVIDER } from "./builtins/agent-memory-write/index.js";
import { LONG_AGENT_MANAGE_TOOL_PROVIDER } from "./builtins/long-agent-manage/index.js";
import { CHANNEL_SEND_TOOL_PROVIDER } from "./builtins/channel-send/index.js";

export const CHAT_SYSTEM_TOOL_PROVIDERS = [
  MEMORY_SEARCH_TOOL_PROVIDER,
  MEMORY_RECORD_TOOL_PROVIDER,
  WORKFLOW_CALL_TOOL_PROVIDER,
  AGENT_MEMORY_SEARCH_TOOL_PROVIDER,
  AGENT_MEMORY_READ_TOOL_PROVIDER,
  AGENT_MEMORY_WRITE_TOOL_PROVIDER,
  PROJECT_SEARCH_TOOL_PROVIDER,
  PROJECT_READ_TOOL_PROVIDER,
  PROJECT_CREATE_TOOL_PROVIDER,
  PROJECT_OPEN_TOOL_PROVIDER,
  PROJECT_UPDATE_TOOL_PROVIDER,
  PROJECT_CONFIGURE_TOOL_PROVIDER,
  LONG_AGENT_MANAGE_TOOL_PROVIDER,
  CHANNEL_SEND_TOOL_PROVIDER,
] as const;

const providersByAddress = new Map(CHAT_SYSTEM_TOOL_PROVIDERS.map((provider) => [provider.address, provider]));

export function listChatSystemTools() {
  return CHAT_SYSTEM_TOOL_PROVIDERS.map(({ manifest, address, version }) => ({
    manifest,
    address,
    version,
    sourceInfo: {
      path: `<chat-system:${manifest.id}>`,
      source: "chat-system",
      scope: "system",
      origin: "builtin",
    },
  }));
}

export function resolveChatSystemTools(
  addresses: readonly string[],
  context: ChatToolRuntimeContext,
): ResolvedChatTool[] {
  const unique = [...new Set(addresses)];
  return unique.map((address) => {
    const provider = providersByAddress.get(address);
    if (provider === undefined) throw new Error(`找不到Chat系统Tool: ${address}`);
    return {
      manifest: provider.manifest,
      address: provider.address,
      version: provider.version,
      definition: provider.create(context),
    };
  });
}
