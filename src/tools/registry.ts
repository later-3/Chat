import type { ChatToolRuntimeContext, ResolvedChatTool } from "./framework.js";
import { MEMORY_RECORD_TOOL_PROVIDER } from "./builtins/memory-record/index.js";
import { MEMORY_SEARCH_TOOL_PROVIDER } from "./builtins/memory-search/index.js";
import { WORKFLOW_CALL_TOOL_PROVIDER } from "./builtins/workflow-call/index.js";

export const CHAT_SYSTEM_TOOL_PROVIDERS = [
  MEMORY_SEARCH_TOOL_PROVIDER,
  MEMORY_RECORD_TOOL_PROVIDER,
  WORKFLOW_CALL_TOOL_PROVIDER,
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
