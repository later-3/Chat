import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ChatToolProvider } from "../../framework.js";
import { defineChatSystemTool } from "../../framework.js";
import manifest from "./tool.json" with { type: "json" };

const parameters = Type.Object({
  operation: Type.Union([
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("create"),
    Type.Literal("archive"),
    Type.Literal("unarchive"),
    Type.Literal("delete"),
  ]),
  longAgentId: Type.Optional(Type.String({ description: "get/archive/unarchive/delete 的目标 Agent ID" })),
  id: Type.Optional(Type.String({ description: "create 的新 Agent ID：小写字母/数字/连字符" })),
  name: Type.Optional(Type.String({ description: "create 的显示名称" })),
  description: Type.Optional(Type.String({ description: "create 的简介" })),
  nanoclawAgentGroupId: Type.Optional(Type.String({ description: "create 绑定的 NanoClaw Agent Group ID" })),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function result(details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

export const LONG_AGENT_MANAGE_TOOL_PROVIDER: ChatToolProvider = defineChatSystemTool(
  manifest,
  (context) => defineTool({
    name: manifest.name,
    label: manifest.label,
    description: manifest.description,
    executionMode: "sequential",
    parameters,
    async execute(_toolCallId, params) {
      if (context.purpose !== "execution") throw new Error("检查模式不能执行Long Agent管理操作");
      const lifecycle = await import("../../../long-agents/lifecycle.js");
      const storage = await import("../../../long-agents/storage.js");
      if (!isRecord(params) || typeof params.operation !== "string") throw new Error("缺少operation");

      switch (params.operation) {
        case "list": {
          const registry = await storage.readLongAgentRegistry(context.chatHome);
          const agents = registry.agents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            description: agent.description,
            enabled: agent.enabled,
            status: agent.status,
            defaultProjectId: agent.defaultProjectId,
            nanoclawAgentGroupId: agent.nanoclawAgentGroupId,
          }));
          return result({ agents });
        }
        case "get": {
          if (typeof params.longAgentId !== "string") throw new Error("get需要longAgentId");
          const registry = await storage.readLongAgentRegistry(context.chatHome);
          const agent = registry.agents.find((candidate) => candidate.id === params.longAgentId);
          if (agent === undefined) throw new Error(`找不到Long Agent: ${params.longAgentId}`);
          const details = {
            id: agent.id,
            name: agent.name,
            description: agent.description,
            enabled: agent.enabled,
            status: agent.status,
            defaultProjectId: agent.defaultProjectId,
            tools: agent.definition.tools,
            resources: agent.definition.resources,
          };
          return result(details);
        }
        case "create": {
          if (typeof params.id !== "string" || typeof params.name !== "string"
            || typeof params.nanoclawAgentGroupId !== "string") {
            throw new Error("create需要id、name和nanoclawAgentGroupId");
          }
          const registry = await storage.readLongAgentRegistry(context.chatHome);
          const instance = registry.instances[0];
          if (instance === undefined) throw new Error("没有可用的NanoClaw实例");
          const agent = await lifecycle.createLongAgent({
            id: params.id,
            name: params.name,
            ...(typeof params.description === "string" ? { description: params.description } : {}),
            instanceId: instance.id,
            nanoclawAgentGroupId: params.nanoclawAgentGroupId,
            chatHome: context.chatHome,
          });
          const details = { id: agent.id, defaultProjectId: agent.defaultProjectId, status: agent.status };
          return result(details);
        }
        case "archive":
        case "unarchive":
        case "delete": {
          if (typeof params.longAgentId !== "string") throw new Error(`${params.operation}需要longAgentId`);
          if (params.operation === "archive") await lifecycle.archiveLongAgent(params.longAgentId, context.chatHome);
          else if (params.operation === "unarchive") await lifecycle.unarchiveLongAgent(params.longAgentId, context.chatHome);
          else await lifecycle.deleteLongAgent(params.longAgentId, context.chatHome);
          const details = { longAgentId: params.longAgentId, operation: params.operation, done: true };
          return result(details);
        }
        default:
          throw new Error(`未知operation: ${params.operation}`);
      }
    },
  }),
);
