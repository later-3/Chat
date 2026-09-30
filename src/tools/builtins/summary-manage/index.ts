import { ensureAgentCalendar } from "../../../long-agents/project-agent.js";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { appendChatAuditEvent } from "../../../audit-log.js";
import {
  listLongAgentSummaries, assertSummarySourcesReadable,
  LongAgentSummaryError,
  readLongAgentSummary,
  searchLongAgentSummaries,
  writeLongAgentSummary,
} from "../../../long-agents/summaries.js";
import { agentDate } from "../../../long-agents/calendar.js";
import { readAgentDaySources, readAgentArchiveSession } from "../../../long-agents/day-archive.js";
import { readTaskState } from "../../../long-agents/tasks/storage.js";
import { readLongAgentState, readLongAgentRegistry } from "../../../long-agents/storage.js";
import type { ChatToolProvider } from "../../framework.js";
import { defineChatSystemTool } from "../../framework.js";
import manifest from "./tool.json" with { type: "json" };

function result(details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
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
        Type.Literal("day"), Type.Literal("session"),
        Type.Literal("write"),
        Type.Literal("read"),
        Type.Literal("list"),
        Type.Literal("search"),
      ]),
      date: Type.Optional(Type.String({ description: "write/read 的目标日期（YYYY-MM-DD）；write 省略表示今天" })),
      sessionId: Type.Optional(Type.String({ description: "session：日目录提供的 Session ID，身份由服务器绑定" })),
      cursor: Type.Optional(Type.String({ description: "session：上一页的 nextCursor；day：下一页的数字游标" })),
      from: Type.Optional(Type.String({ description: "list：起始日期（含）" })),
      to: Type.Optional(Type.String({ description: "list：结束日期（含）" })),
      expectedRevision: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "write：read 返回的 revision，不存在时为 null；已有总结必须提供" })),
      did: Type.Optional(Type.Array(Type.String(), { description: "write：今天实际完成/推进的事（事实与结果）" })),
      reflections: Type.Optional(Type.Array(Type.String(), { description: "write：哪里没做好、原因、下次怎么改" })),
      handoff: Type.Optional(Type.String({ description: "write：给下一天的交接上下文——未完成事项与下一步" })),
      socialPost: Type.Optional(Type.String({ description: "write：可选，要发到朋友圈的一段话" })),
      query: Type.Optional(Type.String({ description: "search：关键词" })),
      limit: Type.Optional(Type.Number({ description: "list/search：最多返回条数" })),
    }),
    async execute(_toolCallId, params) {
      if (context.purpose !== "execution") throw new Error("检查模式不能读写每日总结");
      if (context.longAgentId === undefined) throw new Error("summary_manage只服务于Long Agent身份的执行上下文");
      const registry = await readLongAgentRegistry(context.chatHome);
      const found = registry.agents.find((candidate) => candidate.id === context.longAgentId);
      if (found === undefined) throw new Error(`找不到Long Agent: ${context.longAgentId}`);
      const agent = await ensureAgentCalendar(found, context.chatHome);
      const record = params as Record<string, unknown>;
      const operation = String(record.operation);
      const date = typeof record.date === "string" && record.date.trim() !== "" ? record.date.trim() : agentDate(agent.timeZone);

      const state = await readLongAgentState(context.chatHome);
      const work = state.works.find(work => work.longAgentId === agent.id && work.sessionId === context.sessionId);
      const occurrence = work ? (await readTaskState(context.chatHome, agent.id)).occurrences.find(item => item.id === work.requestId) : undefined;
      const archiveTimeZone = occurrence?.summaryDate ? occurrence.definition.timeZone : agent.timeZone;
      try {
        if (operation === "session") {
          if (typeof record.sessionId !== "string") throw new Error("需要 sessionId");
          return result({ operation, ...await readAgentArchiveSession(context.chatHome, agent.id, record.sessionId,
            typeof record.cursor === "string" ? record.cursor : undefined, typeof record.date === "string" ? date : undefined, archiveTimeZone) });
        }
        if (operation === "day") {
          const sources = await readAgentDaySources(context.chatHome, agent.id, date, archiveTimeZone);
          const items = [...sources.sessions.map(value => ({ ...value, category: "session" })),
            ...sources.works.map(value => ({ kind: "work", ...value })), ...sources.occurrences.map(value => ({ ...value, kind: "occurrence" }))];
          const offset = record.cursor === undefined ? 0 : Number(record.cursor);
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length) throw new Error("无效日目录游标");
          return result({ operation, date, timeZone: sources.timeZone, items: items.slice(offset, offset + 50),
            nextCursor: offset + 50 < items.length ? String(offset + 50) : null, total: items.length });
        }
        if (operation === "write") {
          if (occurrence?.summaryDate !== undefined && date !== occurrence.summaryDate) throw new Error("总结日期与此次任务的覆盖日期不一致");
          if (typeof record.expectedRevision !== "string" && record.expectedRevision !== null) throw new Error("写入总结必须先 read，并提供 expectedRevision（不存在为 null）");
          const sources = await readAgentDaySources(context.chatHome, agent.id, date, archiveTimeZone);

          const summary = await writeLongAgentSummary({
            chatHome: context.chatHome,
            longAgentId: agent.id,
            date,
            did: record.did,
            reflections: record.reflections,
            handoff: record.handoff,
            socialPost: record.socialPost,
            expectedRevision: record.expectedRevision,
            archive: { sessionId: context.sessionId, workId: work?.id ?? null, occurrenceId: occurrence?.id ?? null, sources },
          });
          await appendChatAuditEvent({
            action: "long-agent.summary.write",
            target: { type: "long-agent", longAgentId: agent.id },
            details: { date: summary.date, did: summary.did.length, reflections: summary.reflections.length, hasHandoff: summary.handoff !== "" },
          }, context.chatHome);
          return result({ operation, saved: true, date: summary.date, revision: summary.revision, fileName: "summary.md" });
        }
        if (operation === "read") {
          const summary = await readLongAgentSummary(context.chatHome, agent.id, date);
          if (summary) await assertSummarySourcesReadable(context.chatHome, agent.id, summary);
          return result({ operation, date, summary: summary ?? null });
        }
        if (operation === "list") {
          const summaries = await listLongAgentSummaries({
            chatHome: context.chatHome,
            longAgentId: agent.id,
            ...(typeof record.from === "string" ? { from: record.from } : {}),
            ...(typeof record.to === "string" ? { to: record.to } : {}),
            limit: typeof record.limit === "number" ? Math.max(1, Math.min(100, Math.floor(record.limit))) : 30,
          });
          for (const summary of summaries) await assertSummarySourcesReadable(context.chatHome, agent.id, summary);
          return result({ operation, summaries });
        }
        if (operation === "search") {
          const summaries = await searchLongAgentSummaries({
            chatHome: context.chatHome,
            longAgentId: agent.id,
            query: typeof record.query === "string" ? record.query : "",
            ...(typeof record.from === "string" ? { from: record.from } : {}),
            ...(typeof record.to === "string" ? { to: record.to } : {}),
            limit: typeof record.limit === "number" ? Math.max(1, Math.min(100, Math.floor(record.limit))) : 30,
          });
          for (const summary of summaries) await assertSummarySourcesReadable(context.chatHome, agent.id, summary);
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
