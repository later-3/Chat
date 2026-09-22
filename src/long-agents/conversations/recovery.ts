import { listAllConversations } from "./storage.js";
import { recoverDiscussionState } from "./discussions.js";

/**
 * Startup recovery for group state after a Backend restart.
 *
 * A `running` speech attempt that lost its terminal state is marked `interrupted` (never replayed,
 * because its model/tool side effects are unknown), while `queued` attempts and background tasks are
 * safe to resume. Queue draining is fire-and-forget so startup never waits on a model call.
 */
export async function recoverConversationsOnStartup(chatHome: string, options: { readonly drain?: boolean } = {}): Promise<{
  conversations: number;
  interrupted: number;
  queued: number;
}> {
  const conversations = await listAllConversations(chatHome);
  let interrupted = 0;
  let queued = 0;
  for (const { conversation, storageProjectId } of conversations) {
    const recovered = await recoverDiscussionState({ chatHome, storageProjectId, conversationId: conversation.id });
    interrupted += recovered.interrupted.length;
    queued += recovered.queued.length;
    const { recoverConversationWorks } = await import("./work.js");
    const works = await recoverConversationWorks({ chatHome, storageProjectId, conversationId: conversation.id });
    interrupted += works.interrupted;
    queued += works.queued;
    if (options.drain === false) continue;
    void (async () => {
      const { drainConversationAttempts } = await import("./dispatch.js");
      const { drainConversationWorks } = await import("./work.js");
      await drainConversationAttempts({ chatHome, storageProjectId, conversationId: conversation.id }).catch(() => undefined);
      await drainConversationWorks({ chatHome, storageProjectId, conversationId: conversation.id }).catch(() => undefined);
    })().catch(() => undefined);
  }
  return { conversations: conversations.length, interrupted, queued };
}
