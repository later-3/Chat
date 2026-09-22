import { createError, defineEventHandler, getRouterParam, setResponseHeader } from "nitro/h3";
import { resolveChatHome } from "../../../../../chat-home.js";
import { conversationHttpError, conversationSummary, locateConversationForHttp } from "../../../../../long-agents/conversations/http.js";
import { readDiscussionState } from "../../../../../long-agents/conversations/discussions.js";

/** Owner-facing group detail, optionally including the durable discussion/attempt status. */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const namespace = getRouterParam(event, "longAgentId");
  const conversationId = getRouterParam(event, "conversationId", { decode: true });
  if (!namespace || !conversationId) throw createError({ statusCode: 400, statusMessage: "缺少群或 Friend 标识" });
  try {
    const { conversation, storageProjectId } = await locateConversationForHttp(resolveChatHome(), conversationId, namespace);
    const state = await readDiscussionState(resolveChatHome(), storageProjectId, conversationId);
    return {
      ...conversationSummary(conversation),
      discussions: state.discussions.map((discussion) => ({
        discussionId: discussion.discussionId,
        policy: discussion.policy,
        round: discussion.round,
        status: discussion.status,
        stopReason: discussion.stopReason,
        modelCalls: discussion.modelCalls,
        budget: discussion.budget,
        attempts: discussion.attempts.map((attempt) => ({
          attemptId: attempt.attemptId,
          round: attempt.round,
          speakerLongAgentId: attempt.speakerLongAgentId,
          participationEpoch: attempt.participationEpoch,
          status: attempt.status,
          reason: attempt.reason,
          publicationId: attempt.publicationId,
          causationId: attempt.causationId,
          inputCutoffEntryId: attempt.inputCutoffEntryId,
        })),
      })),
    };
  } catch (error) {
    conversationHttpError(error);
  }
});
