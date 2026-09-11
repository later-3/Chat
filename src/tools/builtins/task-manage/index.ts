import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { appendChatAuditEvent } from "../../../audit-log.js";
import { requestNanoClawTasks, type NanoClawTaskOperation } from "../../../long-agents/nanoclaw-client.js";
import { readLongAgentRegistry } from "../../../long-agents/storage.js";
import type { ChatToolProvider } from "../../framework.js";
import { defineChatSystemTool } from "../../framework.js";
import manifest from "./tool.json" with { type: "json" };

const MAX_PROMPT_LENGTH = 8_000;

/**
 * Long Agent 管理自己的定时任务。任务事实源仍是 NanoClaw 的调度（cron/时区/复发/限流），
 * 这里只做窄合同代理：Agent 只能操作自己 Agent Group 的任务，且写操作全部进审计。
 */
export const TASK_MANAGE_TOOL_PROVIDER: ChatToolProvider = defineChatSystemTool(
  manifest,
  (context) => defineTool({
    name: manifest.name,
    label: manifest.label,
    description: manifest.description,
    executionMode: "sequential",
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("list"),
        Type.Literal("get"),
        Type.Literal("create"),
        Type.Literal("update"),
        Type.Literal("pause"),
        Type.Literal("resume"),
        Type.Literal("delete"),
        Type.Literal("run"),
      ]),
      taskId: Type.Optional(Type.String({ description: "get/update/pause/resume/delete/run 的目标任务 id" })),
      name: Type.Optional(Type.String({ description: "create 的可读名称（用于生成稳定 id）" })),
      prompt: Type.Optional(Type.String({ description: "create/update 的触发指令：到点后给自己的任务说明" })),
      recurrence: Type.Optional(Type.String({ description: "cron 表达式，例如每天 23:30 为 '30 23 * * *'；一次性任务省略" })),
      processAfter: Type.Optional(Type.String({ description: "下次触发时间（ISO 8601）；省略时按 recurrence 计算" })),
      reason: Type.Optional(Type.String({ description: "为什么创建或修改这个任务（写入审计）" })),
    }),
    async execute(_toolCallId, params) {
      if (context.purpose !== "execution") throw new Error("检查模式不能管理定时任务");
      if (context.longAgentId === undefined) throw new Error("task_manage只服务于Long Agent身份的执行上下文");
      const registry = await readLongAgentRegistry(context.chatHome);
      const agent = registry.agents.find((candidate) => candidate.id === context.longAgentId);
      if (agent === undefined) throw new Error(`找不到Long Agent: ${context.longAgentId}`);
      if (agent.status !== "active" || !agent.enabled) {
        throw new Error(`Long Agent ${agent.id}已归档或停用，不能管理定时任务`);
      }
      const instance = registry.instances.find((candidate) => candidate.id === agent.instanceId);
      if (instance === undefined) throw new Error(`找不到NanoClaw实例: ${agent.instanceId}`);

      const operation = String((params as { operation: string }).operation);
      const record = params as Record<string, unknown>;
      const taskId = typeof record.taskId === "string" ? record.taskId : undefined;
      const prompt = typeof record.prompt === "string" ? record.prompt.trim() : undefined;
      if (prompt !== undefined && prompt.length > MAX_PROMPT_LENGTH) {
        throw new Error(`prompt不能超过${String(MAX_PROMPT_LENGTH)}字符`);
      }
      const recurrence = typeof record.recurrence === "string" ? record.recurrence.trim() : undefined;

      if (operation === "create" && (prompt === undefined || prompt === "")) {
        throw new Error("create需要prompt：说明到点后要做什么");
      }
      if (operation !== "list" && operation !== "create" && (taskId === undefined || taskId === "")) {
        throw new Error(`${operation}需要taskId`);
      }
      const createPrompt = prompt ?? "";

      const request: NanoClawTaskOperation = operation === "list"
        ? { operation: "list" as const }
        : operation === "create"
          ? {
              operation: "create" as const,
              ...(typeof record.name === "string" && record.name.trim() !== "" ? { name: record.name.trim() } : {}),
              prompt: createPrompt,
              ...(recurrence === undefined || recurrence === "" ? {} : { recurrence }),
              ...(typeof record.processAfter === "string" ? { processAfter: record.processAfter } : {}),
              ...(context.sessionId === undefined ? {} : { originSessionId: context.sessionId }),
            }
          : operation === "update"
            ? {
                operation: "update" as const,
                taskId: taskId ?? "",
                ...(prompt === undefined ? {} : { prompt }),
                ...(recurrence === undefined ? {} : { recurrence: recurrence === "" ? null : recurrence }),
                ...(typeof record.processAfter === "string" ? { processAfter: record.processAfter } : {}),
              }
            : { operation: operation as "get" | "pause" | "resume" | "delete" | "run", taskId: taskId ?? "" };

      const response = await requestNanoClawTasks({
        instance,
        agentGroupId: agent.nanoclawAgentGroupId,
        operation: request,
      });
      if (operation !== "list" && operation !== "get") {
        await appendChatAuditEvent({
          action: `long-agent.task.${operation}`,
          target: { type: "long-agent", longAgentId: agent.id },
          details: {
            taskId: taskId ?? null,
            createdTaskId: response.task?.id ?? null,
            recurrence: recurrence ?? null,
            ...(typeof record.reason === "string" ? { reason: record.reason.slice(0, 500) } : {}),
          },
        }, context.chatHome);
      }
      const details = {
        operation,
        ...(response.tasks === undefined ? {} : { tasks: response.tasks }),
        ...(response.task === undefined ? {} : { task: response.task }),
        ...(response.firedTaskId === undefined ? {} : { firedTaskId: response.firedTaskId }),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    },
  }),
);
