import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { appendChatAuditEvent } from "../../../audit-log.js";
import { sendNanoClawAgentMessage } from "../../../long-agents/nanoclaw-client.js";
import { readLongAgentRegistry } from "../../../long-agents/storage.js";
import type { ChatToolProvider } from "../../framework.js";
import { defineChatSystemTool } from "../../framework.js";
import manifest from "./tool.json" with { type: "json" };

const MAX_TEXT_LENGTH = 4_000;

/**
 * Proactive channel message from a Long Agent to its own bound destination.
 * The destination always comes from the server-side registry binding for the
 * calling Agent's trusted identity; the model can never pick a recipient.
 */
export const CHANNEL_SEND_TOOL_PROVIDER: ChatToolProvider = defineChatSystemTool(
  manifest,
  (context) => defineTool({
    name: manifest.name,
    label: manifest.label,
    description: manifest.description,
    executionMode: "sequential",
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: MAX_TEXT_LENGTH, description: "要发送的文本消息" }),
    }),
    async execute(_toolCallId, params) {
      if (context.purpose !== "execution") throw new Error("检查模式不能发送通道消息");
      if (context.longAgentId === undefined) {
        throw new Error("channel_send只服务于Long Agent身份的执行上下文");
      }
      const text = typeof params === "object" && params !== null && "text" in params
        ? String(params.text).trim()
        : "";
      if (text === "") throw new Error("text不能为空");
      const registry = await readLongAgentRegistry(context.chatHome);
      const agent = registry.agents.find((candidate) => candidate.id === context.longAgentId);
      if (agent === undefined) throw new Error(`找不到Long Agent: ${context.longAgentId}`);
      if (agent.status !== "active" || !agent.enabled) {
        throw new Error(`Long Agent ${agent.id}已归档或停用，不能发送通道消息`);
      }
      if (agent.inbox === undefined) {
        throw new Error(`Long Agent ${agent.id}未绑定通道目的地；请先在配置中完成Channel绑定`);
      }
      const instance = registry.instances.find((candidate) => candidate.id === agent.instanceId);
      if (instance === undefined) throw new Error(`找不到NanoClaw实例: ${agent.instanceId}`);
      const messageId = `chat-pi:proactive:${randomUUID()}`;
      const { nanoSessionId } = await sendNanoClawAgentMessage({
        instance,
        agentGroupId: agent.nanoclawAgentGroupId,
        destination: agent.inbox,
        messageId,
        text,
      });
      await appendChatAuditEvent({
        action: "long-agent.channel.send",
        target: { type: "long-agent", longAgentId: agent.id },
        details: { messageId, nanoSessionId, textLength: text.length },
      }, context.chatHome);
      const details = { sent: true, messageId, nanoSessionId, destination: agent.inbox.channelType };
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    },
  }),
);
