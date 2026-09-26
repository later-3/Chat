import { openChatSession } from "../../chat-session.js";
import { resolveChatHome } from "../../chat-home.js";
import { SESSION_MEMORY_NOTICE_CUSTOM_TYPE } from "./tail-policy.js";

/**
 * A failed or cancelled memory node leaves a durable, VIEWABLE record in the round's Session.
 *
 * Both callers share this: the Workflow `remember` Step and the Long Agent queue worker (which runs the
 * same writer turn as the second half of a Friend round). Without it the Friend path failed silently —
 * the work answer stayed, but the owner had no way to see that memory was not written.
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
        ? "本轮已取消，会话记忆未写入。工作答案已保留；需要时可重新发送或手动整理记忆。"
        : `会话记忆本轮未写入：${message}。工作答案已保留，可在本会话重新发起一轮或手动整理记忆。`,
      // DISPLAYED: the public session read drops `display === false` entries.
      true,
      { status: cancelled ? "cancelled" : "failed", workflowId: input.ownerWorkflowId, invocationId: input.workflowInvocationId },
    );
    session.manager.flush();
  } catch (noticeError) {
    console.error(`[${input.ownerWorkflowId}] 会话记忆失败记录写入失败`, noticeError instanceof Error ? noticeError.message : String(noticeError));
  }
}
