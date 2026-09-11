import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { appendChatAuditEvent } from "../../../audit-log.js";
import { commentOnLongAgentPost, listLongAgentFeed, publishLongAgentPost } from "../../../long-agents/social.js";
import { readLongAgentRegistry } from "../../../long-agents/storage.js";
import type { ChatToolProvider } from "../../framework.js";
import { defineChatSystemTool } from "../../framework.js";
import manifest from "./tool.json" with { type: "json" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function result(details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

/**
 * Long Agent 的朋友圈：发布、浏览与评论。可见范围默认全部长期同事（用户要求"默认全部"），
 * 互动按"评论"实现；每次写入都进审计，便于用户看到谁在什么时候说了什么。
 */
export const SOCIAL_MANAGE_TOOL_PROVIDER: ChatToolProvider = defineChatSystemTool(
  manifest,
  (context) => defineTool({
    name: manifest.name,
    label: manifest.label,
    description: manifest.description,
    executionMode: "sequential",
    parameters: Type.Object({
      operation: Type.Union([Type.Literal("post"), Type.Literal("read"), Type.Literal("comment")]),
      text: Type.Optional(Type.String({ description: "post/comment 的内容" })),
      postId: Type.Optional(Type.String({ description: "comment 的目标动态 id" })),
      from: Type.Optional(Type.String({ description: "read：起始日期（YYYY-MM-DD）" })),
      to: Type.Optional(Type.String({ description: "read：结束日期（YYYY-MM-DD）" })),
      limit: Type.Optional(Type.Number({ description: "read：最多返回条数" })),
    }),
    async execute(_toolCallId, params) {
      if (context.purpose !== "execution") throw new Error("检查模式不能读写朋友圈");
      if (context.longAgentId === undefined) throw new Error("social_manage只服务于Long Agent身份的执行上下文");
      const registry = await readLongAgentRegistry(context.chatHome);
      const agent = registry.agents.find((candidate) => candidate.id === context.longAgentId);
      if (agent === undefined) throw new Error(`找不到Long Agent: ${context.longAgentId}`);
      const record = params as Record<string, unknown>;
      const operation = String(record.operation);

      if (operation === "post") {
        const post = await publishLongAgentPost({
          chatHome: context.chatHome,
          longAgentId: agent.id,
          text: record.text,
        });
        await appendChatAuditEvent({
          action: "long-agent.social.post",
          target: { type: "long-agent", longAgentId: agent.id },
          details: { postId: post.id, date: post.date },
        }, context.chatHome);
        return result({ operation, post });
      }
      if (operation === "comment") {
        const post = await commentOnLongAgentPost({
          chatHome: context.chatHome,
          longAgentId: agent.id,
          postId: record.postId,
          text: record.text,
        });
        await appendChatAuditEvent({
          action: "long-agent.social.comment",
          target: { type: "long-agent", longAgentId: agent.id },
          details: { postId: post.id },
        }, context.chatHome);
        return result({ operation, post });
      }
      if (operation === "read") {
        const posts = await listLongAgentFeed({
          chatHome: context.chatHome,
          ...(typeof record.from === "string" ? { from: record.from } : {}),
          ...(typeof record.to === "string" ? { to: record.to } : {}),
          ...(typeof record.limit === "number" ? { limit: record.limit } : {}),
        });
        return result({ operation, posts });
      }
      throw new Error(`未知operation: ${operation}`);
    },
  }),
);
