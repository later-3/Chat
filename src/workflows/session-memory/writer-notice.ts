import { openChatSession } from "../../chat-session.js";
import { resolveChatHome } from "../../chat-home.js";

/** Custom session entry that records a failed/cancelled memory round so it stays viewable, not just logged. */
export const SESSION_MEMORY_NOTICE_CUSTOM_TYPE = "chat.session_memory_notice";

/**
 * A failed or cancelled session-memory round leaves a durable, VIEWABLE record in the round's Session.
 *
 * The caller is the session-memory round step itself: the round failed, so the failure is the round's
 * outcome and the owner needs a way to see that memory was not written.
 */
export async function recordSessionMemoryNotice(input: {
  readonly chatHome?: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly ownerWorkflowId: string;
  readonly workflowInvocationId: string;
  readonly error: unknown;
}): Promise<void> {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const cancelled = /cancel|abort|取消/i.test(message);
  try {
    const session = await openChatSession({ projectId: input.projectId, chatHome: resolveChatHome(input.chatHome), sessionId: input.sessionId });
    session.manager.appendCustomMessageEntry(
      SESSION_MEMORY_NOTICE_CUSTOM_TYPE,
      cancelled
        ? "本轮会话记忆整理已取消，未写入。可重新发起一轮。"
        : `本轮会话记忆整理未完成：${message}。可重新发起一轮。`,
      // DISPLAYED: the public session read drops `display === false` entries.
      true,
      { status: cancelled ? "cancelled" : "failed", workflowId: input.ownerWorkflowId, invocationId: input.workflowInvocationId },
    );
    session.manager.flush();
  } catch (noticeError) {
    console.error(`[${input.ownerWorkflowId}] 会话记忆失败记录写入失败`, noticeError instanceof Error ? noticeError.message : String(noticeError));
  }
}
