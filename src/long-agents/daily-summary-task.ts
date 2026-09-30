import { ensureAgentCalendar } from "./project-agent.js";
import { createHash, randomUUID } from "node:crypto";
import { agentDate } from "./calendar.js";
import { readLongAgentRegistry } from "./storage.js";
import { changeTaskState } from "./tasks/storage.js";
import type { LongAgentConfig } from "./types.js";
import type { FriendTask } from "./tasks/contract.js";
import { assertSummaryDate } from "./summaries.js";

export const DAILY_ARCHIVE_INSTRUCTIONS = `每日工作机制：每日总结是一项可在日程中查看、调整或暂停的独立定时任务，默认按任务时区在次日 00:10 总结前一天。它属于你的连续性记忆，不是用户的一条聊天消息。summary_manage 的 day 操作提供会话及各种任务的当日目录，session 操作分页读取已授权历史，read/list/search 读取以往总结；write 保存独立 Markdown。必须依据实际记录区分已完成、失败、进行中、待决策与下一步。新日会话加载昨天的总结，缺失时不要虚构。需要更早资料时主动读取，不要求用户重新转述。工具未授权时应明确能力缺失，不能绕过权限直接读取其他 Agent 或项目。`;

/** Provision once in the existing task store. A paused/cancelled task is still provisioned. */
export async function ensureDailySummaryTask(home: string, agent: LongAgentConfig): Promise<FriendTask | undefined> {
  if (!agent.enabled || agent.status === "archived") return undefined;
  agent = await ensureAgentCalendar(agent, home);
  return changeTaskState(home, agent.id, state => {
    if (state.migration !== "complete") return undefined;
    const id = `task-${createHash("sha256").update(`daily-summary-v1:${agent.id}`).digest("hex").slice(0, 32)}`;
    const existing = state.tasks.find(task => task.id === id);
    if (existing) return existing;
    const now = new Date().toISOString();
    const task: FriendTask = {
      id, longAgentId: agent.id, purpose: "daily-summary", revision: 1, status: "active",
      name: "每日总结与归档", prompt: "整理自己的全天事项，写下事实、反思、未完成事项和下一步，保存每日总结。不要向聊天或外部渠道发送总结。",
      contextProjectId: null, timeZone: agent.timeZone ?? "UTC", schedule: { kind: "cron", expression: "10 0 * * *" },
      missed: "latest", overlap: "queue-one", createdAt: now, updatedAt: now,
    };
    state.tasks.push(task); state.revisions.push(task);
    return task;
  });
}

export function summaryTaskInstruction(date: string): string {
  return `[每日归档任务，覆盖日期 ${date}]
这是独立工作，不是用户发言。先调用 summary_manage operation=day date=${date}，逐页检查该日目录中的所有会话与各类任务；通过 operation=session、sessionId 和 cursor 读取需要的记录，不要只总结本工作 Session。未结束、失败、跳过的事项也要记录，不把计划当完成。
调用 summary_manage read 读取该日已有总结，使用返回的 revision 作为 write 的 expectedRevision（不存在为 null）；最后调用 write date=${date} 保存总结，包含 did、reflections、handoff。不要使用 channel_send 或发帖。写入成功回执才表示归档完成；工具不可用或资料缺失时明确报告失败。`;
}

/** Historical retry uses the same task/occurrence/work path; no model call in the maintenance loop. */
export async function requestDailySummary(home: string, id: string, date: string): Promise<void> {
  assertSummaryDate(date);
  const agent = (await readLongAgentRegistry(home)).agents.find(item => item.id === id);
  if (!agent || date >= agentDate((await ensureAgentCalendar(agent, home)).timeZone)) throw new Error("仅可补写过去日期的总结");
  const service = await import("./tasks/service.js");
  await service.migrateFriendTasks(home, id);
  const task = await ensureDailySummaryTask(home, agent);
  if (!task || task.status === "cancelled") throw new Error("每日总结任务已停用或取消");
  await service.acceptTaskTrigger(home, { schemaVersion: 1, instanceId: agent.instanceId,
    agentGroupId: agent.nanoclawAgentGroupId, taskId: task.id, revision: task.revision,
    source: "manual", sourceId: randomUUID(), scheduledAt: new Date().toISOString() }, date);
}
