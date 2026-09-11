import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { appendChatAuditEvent } from "../../../audit-log.js";
import {
  listLongAgentSummaries,
  LongAgentSummaryError,
  readLongAgentSummary,
  searchLongAgentSummaries,
  writeLongAgentSummary,
} from "../../../long-agents/summaries.js";
import { readLongAgentRegistry } from "../../../long-agents/storage.js";
import type { ChatToolProvider } from "../../framework.js";
import { defineChatSystemTool } from "../../framework.js";
import manifest from "./tool.json" with { type: "json" };

function result(details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

function localDate(): string {
  const now = new Date();
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * Long Agent 管理自己的每日总结。总结是它与 workflow/用户共同产出的事实，
 * 换日交接由程序从这里读取并注入，因此 write 必须写清"做了什么"和"接下来要做什么"。
 */
export const SUMMARY_MANAGE_TOOL_PROVIDER: ChatToolProvider = defineChatSystemTool(
  manifest,
  (context) => defineTool({
    name: manifest.name,
    label: manifest.label,
    description: manifest.description,
    executionMode: "sequential",
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("write"),
        Type.Literal("read"),
        Type.Literal("list"),
        Type.Literal("search"),
      ]),
      date: Type.Optional(Type.String({ description: "write/read 的目标日期（YYYY-MM-DD）；write 省略表示今天" })),
      did: Type.Optional(Type.Array(Type.String(), { description: "write：今天实际完成/推进的事（事实与结果）" })),
      reflections: Type.Optional(Type.Array(Type.String(), { description: "write：哪里没做好、原因、下次怎么改" })),
      handoff: Type.Optional(Type.String({ description: "write：给后天的交接上下文——未完成事项与下一步" })),
      socialPost: Type.Optional(Type.String({ description: "write：可选，要发到朋友圈的一段话" })),
      query: Type.Optional(Type.String({ description: "search：关键词" })),
      limit: Type.Optional(Type.Number({ description: "list/search：最多返回条数" })),
    }),
    async execute(_toolCallId, params) {
      if (context.purpose !== "execution") throw new Error("检查模式不能读写每日总结");
      if (context.longAgentId === undefined) throw new Error("summary_manage只服务于Long Agent身份的执行上下文");
      const registry = await readLongAgentRegistry(context.chatHome);
      const agent = registry.agents.find((candidate) => candidate.id === context.longAgentId);
      if (agent === undefined) throw new Error(`找不到Long Agent: ${context.longAgentId}`);
      const record = params as Record<string, unknown>;
      const operation = String(record.operation);
      const date = typeof record.date === "string" && record.date.trim() !== "" ? record.date.trim() : localDate();

      try {
        if (operation === "write") {
          const summary = await writeLongAgentSummary({
            chatHome: context.chatHome,
            longAgentId: agent.id,
            date,
            did: record.did,
            reflections: record.reflections,
            handoff: record.handoff,
            socialPost: record.socialPost,
          });
          await appendChatAuditEvent({
            action: "long-agent.summary.write",
            target: { type: "long-agent", longAgentId: agent.id },
            details: { date: summary.date, did: summary.did.length, reflections: summary.reflections.length, hasHandoff: summary.handoff !== "" },
          }, context.chatHome);
          return result({ operation, summary });
        }
        if (operation === "read") {
          const summary = await readLongAgentSummary(context.chatHome, agent.id, date);
          return result({ operation, date, summary: summary ?? null });
        }
        if (operation === "list") {
          const summaries = await listLongAgentSummaries({
            chatHome: context.chatHome,
            longAgentId: agent.id,
            ...(typeof record.limit === "number" ? { limit: record.limit } : {}),
          });
          return result({ operation, summaries });
        }
        if (operation === "search") {
          const summaries = await searchLongAgentSummaries({
            chatHome: context.chatHome,
            longAgentId: agent.id,
            query: typeof record.query === "string" ? record.query : "",
            ...(typeof record.limit === "number" ? { limit: record.limit } : {}),
          });
          return result({ operation, summaries });
        }
        throw new Error(`未知operation: ${operation}`);
      } catch (error) {
        if (error instanceof LongAgentSummaryError) throw new Error(error.message);
        throw error;
      }
    },
  }),
);
