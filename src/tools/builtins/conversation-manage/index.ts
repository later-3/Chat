import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { conversationSummary } from "../../../long-agents/conversations/contract.js";
import { readDiscussionState } from "../../../long-agents/conversations/discussions.js";
import { readConversationPublicMessages } from "../../../long-agents/conversations/publication.js";
import { listConversationsForMember } from "../../../long-agents/conversations/storage.js";
import { listConversationWorks } from "../../../long-agents/conversations/work-store.js";
import type { ChatToolProvider } from "../../framework.js";
import { defineChatSystemTool } from "../../framework.js";
import manifest from "./tool.json" with { type: "json" };

function result(details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

/**
 * Read-only group management for a Friend's own participations.
 *
 * The identity is the trusted `toolContext.longAgentId`, never a tool argument, so a Friend can only
 * ever see groups it is actually a member of. `propose` returns a reviewable proposal and never
 * applies it: a Friend cannot widen members, grants or policy by itself, and this tool cannot read
 * another group, a private Session or any data outside the member's authorized public projection.
 */
export const CONVERSATION_MANAGE_TOOL_PROVIDER: ChatToolProvider = defineChatSystemTool(
  manifest,
  (context) => defineTool({
    name: manifest.name,
    label: manifest.label,
    description: manifest.description,
    executionMode: "sequential",
    parameters: Type.Object({
      operation: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("propose")]),
      conversationId: Type.Optional(Type.String({ description: "read/propose：群 id" })),
      proposal: Type.Optional(Type.Object({
        kind: Type.Union([Type.Literal("add-member"), Type.Literal("remove-member"), Type.Literal("set-policy")]),
        longAgentId: Type.Optional(Type.String()),
        policy: Type.Optional(Type.String()),
        reason: Type.Optional(Type.String()),
      }, { description: "propose：待用户确认的建议" })),
    }),
    async execute(_toolCallId, params) {
      if (context.purpose !== "execution") throw new Error("检查模式不能读取群参与");
      const longAgentId = context.longAgentId;
      if (longAgentId === undefined) throw new Error("conversation_manage 只服务于 Long Agent 身份的执行上下文");
      const record = params as Record<string, unknown>;
      const operation = String(record.operation);
      const memberships = await listConversationsForMember(context.chatHome, longAgentId);
      if (operation === "list") {
        return result({
          operation,
          conversations: memberships.map(({ conversation }) => ({
            id: conversation.id,
            title: conversation.title,
            lifecycle: conversation.lifecycle,
            member: conversation.members.find((member) => member.longAgentId === longAgentId)?.revokedAt === null,
            members: conversation.members.map((member) => ({ longAgentId: member.longAgentId, active: member.revokedAt === null })),
            policy: conversation.policy,
            budget: conversation.budget,
          })),
        });
      }
      const conversationId = typeof record.conversationId === "string" ? record.conversationId : "";
      const located = memberships.find(({ conversation }) => conversation.id === conversationId);
      if (located === undefined) throw new Error("找不到你参与的该群，或你已不是成员");
      if (operation === "read") {
        const messages = await readConversationPublicMessages({
          chatHome: context.chatHome, storageProjectId: located.storageProjectId, conversationId,
          viewerLongAgentId: longAgentId,
        });
        const discussions = await readDiscussionState(context.chatHome, located.storageProjectId, conversationId);
        const works = await listConversationWorks(context.chatHome, located.storageProjectId, conversationId);
        return result({
          operation,
          conversation: conversationSummary(located.conversation),
          messages: messages.map((message) => ({
            entryId: message.entryId, cursor: message.cursor, author: message.authorLongAgentId,
            text: message.text, unavailableReason: message.unavailableReason, postedAt: message.postedAt,
          })),
          discussions: discussions.discussions.map((discussion) => ({
            discussionId: discussion.discussionId, policy: discussion.policy, status: discussion.status,
            stopReason: discussion.stopReason, modelCalls: discussion.modelCalls,
            attempts: discussion.attempts.map((attempt) => ({
              attemptId: attempt.attemptId, speakerLongAgentId: attempt.speakerLongAgentId, status: attempt.status, publicationId: attempt.publicationId,
            })),
          })),
          works: works.map((work) => ({ workId: work.workId, title: work.title, status: work.status, publicationId: work.publicationId })),
        });
      }
      if (operation === "propose") {
        const proposal = record.proposal;
        if (typeof proposal !== "object" || proposal === null) throw new Error("propose 需要 proposal");
        const body = proposal as Record<string, unknown>;
        // Proposals are data for the user to review; nothing is written and no authorization changes.
        return result({
          operation,
          applied: false,
          conversationId,
          proposal: {
            kind: String(body.kind),
            ...(body.longAgentId === undefined ? {} : { longAgentId: String(body.longAgentId) }),
            ...(body.policy === undefined ? {} : { policy: String(body.policy) }),
            reason: body.reason === undefined ? "" : String(body.reason),
          },
          note: "提案不会自行应用；请由用户在你的会话或群管理界面确认后再执行。",
        });
      }
      throw new Error("operation 必须是 list/read/propose");
    },
  }),
);
