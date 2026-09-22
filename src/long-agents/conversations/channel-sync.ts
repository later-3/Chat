import { syncNanoClawConversationChannel } from "../nanoclaw-client.js";
import { readLongAgentRegistry } from "../storage.js";
import {
  listPendingConversationChannelSyncs,
  markConversationChannelSynced,
  type ConversationChannelBinding,
} from "./channel.js";

/**
 * LA6 B binding mirror recovery. Chat owns the binding; NanoClaw only stores a mirror. Every bind/unbind
 * bumps `syncRevision`, and this reconciler pushes any binding whose mirror is behind, confirming the
 * exact revision it sent. It is safe to call from any owner entry (bind/unbind/retry/explicit sync) and
 * from retries, so a failed mirror is eventually repaired instead of silently staying stale.
 */
export async function syncConversationChannels(input: {
  chatHome: string;
  storageProjectId: string;
  conversationId: string;
}): Promise<{ synced: string[]; pending: string[] }> {
  const pendingBindings = await listPendingConversationChannelSyncs(input.chatHome, input.storageProjectId, input.conversationId);
  if (pendingBindings.length === 0) return { synced: [], pending: [] };
  const registry = await readLongAgentRegistry(input.chatHome);
  const synced: string[] = [];
  const pending: string[] = [];
  for (const binding of pendingBindings) {
    const revision = binding.syncRevision;
    const confirmed = await pushBinding(input, binding, revision, registry.instances);
    await markConversationChannelSynced({
      chatHome: input.chatHome, storageProjectId: input.storageProjectId, conversationId: input.conversationId,
      bindingId: binding.bindingId, syncRevision: revision, synced: confirmed,
    });
    if (confirmed) synced.push(binding.bindingId);
    else pending.push(binding.bindingId);
  }
  return { synced, pending };
}

async function pushBinding(
  input: { chatHome: string; storageProjectId: string; conversationId: string },
  binding: ConversationChannelBinding,
  revision: number,
  instances: Awaited<ReturnType<typeof readLongAgentRegistry>>["instances"],
): Promise<boolean> {
  const instance = instances.find((candidate) => candidate.id === binding.instanceId);
  if (instance === undefined) return false;
  try {
    await syncNanoClawConversationChannel({
      instance,
      action: binding.status === "active" ? "bind" : "unbind",
      bindingId: binding.bindingId,
      revision,
      agentGroupId: binding.agentGroupId,
      channelType: binding.destination.channelType,
      channelInstance: binding.destination.instance,
      platformId: binding.destination.platformId,
      messagingGroupId: binding.destination.messagingGroupId,
      threadId: binding.destination.threadId,
      botPlatformId: binding.botPlatformId,
    });
    return true;
  } catch {
    // The binding stays durable and pending; the next sync call retries the same revision.
    return false;
  }
}
