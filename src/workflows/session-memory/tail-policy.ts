import type { ChatWorkflowInput } from "../types.js";

/**
 * Whether this round's LAST node (the `remember` writer) will run after the work stage.
 *
 * This is the ONE decision that tells the work stage whether it still owns the round's event stream:
 * when a memory node follows, the work stage must RELEASE its stage observer without closing the stream,
 * and the memory stage closes it. Otherwise the work answer is shown but the memory process is invisible
 * (its events would be written to an already-closed stream). Dependency-free: both the work Steps and the
 * tail import it, and a Step must not import the tail (that would pull the Step graph into itself).
 */
export function memoryTailFollows(input: Pick<ChatWorkflowInput, "sessionMemoryEnabled">): boolean {
  return input.sessionMemoryEnabled !== false;
}

/** Custom session entry that records a failed/cancelled memory write so it stays viewable, not just logged. */
export const SESSION_MEMORY_NOTICE_CUSTOM_TYPE = "chat.session_memory_notice";

/**
 * Who releases the round's event stream. Exactly one stage closes it:
 *  - the WORK stage closes only when no memory node follows (it is then the Last node);
 *  - the MEMORY stage always closes, because it is the last node of the round.
 */
export function stageFinishClosesStream(input: Pick<ChatWorkflowInput, "sessionMemoryEnabled">): boolean {
  return !memoryTailFollows(input);
}
