import { createHash } from "node:crypto";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveProjectContext } from "./projects/registry.js";
import { requireChatSession } from "./session-read-model.js";
import { readSessionWorkflowActivity } from "./session-workflow-activity.js";
import { collectChatWorkflowTurnConfigurations } from "./workflows/workflow-configuration.js";
import { SessionInputError } from "./session-errors.js";

export function transcriptEntry(entry: SessionEntry) {
  const base = { id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp };
  if (entry.type === "message") {
    if (entry.message.role === "bashExecution") {
      const message = entry.message;
      return { ...base, type: "notice" as const, label: `$ ${message.command}\n${message.output}\n退出码: ${message.exitCode ?? "未知"}${message.cancelled ? " · 已取消" : ""}` };
    }
    return { ...base, type: "message" as const, message: entry.message };
  }
  if (entry.type === "custom_message" && entry.display) {
    return { ...base, type: "message" as const, message: { role: "custom", content: entry.content } };
  }
  if (entry.type === "custom") {
    const data = typeof entry.data === "object" && entry.data !== null ? entry.data as Record<string, unknown> : {};
    if (entry.customType === "chat.workflow_stage") {
      return { ...base, type: "notice" as const, label: [data.workflowId, data.stageId, data.agentId].filter((s) => typeof s === "string").join(" · ") };
    }
    if (entry.customType === "chat.session_fork") return { ...base, type: "notice" as const, label: "从父会话分叉；前面的条目为继承历史" };
    if (entry.customType === "chat.plan_review") return { ...base, type: "notice" as const, label: "计划审核" };
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return { ...base, type: "notice" as const, label: `${entry.type === "compaction" ? "上下文压缩" : "分支摘要"}\n${entry.summary}` };
  }
  // Non-message entries remain navigable without exposing arbitrary extension state or configuration.
  return { ...base, type: "notice" as const, label: "" };
}

export async function readSessionTranscript(input: {
  projectId: string; sessionId: string; cursor?: string; leafId?: string; limit?: number;
}, chatHome?: string) {
  const project = await resolveProjectContext(input.projectId, chatHome);
  const info = await requireChatSession(input.sessionId, project.projectId, chatHome);
  if (info.owner.type !== "ordinary") throw new SessionInputError("本期TUI只支持普通Workflow Session");
  const manager = SessionManager.open(info.path, project.sessionDir);
  if (input.leafId !== undefined && !manager.getEntry(input.leafId)) throw new SessionInputError("历史节点不存在");
  const entries = input.leafId === undefined ? manager.getEntries() : manager.getBranch(input.leafId);
  const start = input.cursor === undefined ? 0 : entries.findIndex((entry) => entry.id === input.cursor) + 1;
  if (input.cursor !== undefined && start === 0) throw new SessionInputError("历史游标已失效，请重新读取");
  const limit = input.limit ?? 200;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new SessionInputError("limit必须为1到500");
  const page = entries.slice(start, start + limit);
  const activeRun = await readSessionWorkflowActivity(project, input.sessionId);
  const configs = collectChatWorkflowTurnConfigurations(manager.getBranch());
  return {
    schemaVersion: 1 as const, projectId: project.projectId, sessionId: input.sessionId,
    name: info.name ?? info.firstMessage, leafId: manager.getLeafId(),
    revision: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    workflowId: configs.at(-1)?.workflowId ?? null,
    entries: page.map(transcriptEntry),
    nextCursor: start + page.length < entries.length ? page.at(-1)?.id ?? null : null,
    activeRun: activeRun ?? null,
  };
}
