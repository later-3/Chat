import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { defineChatSystemTool } from "../../framework.js";
import manifest from "./tool.json" with { type: "json" };

export const FRIEND_WORK_TOOL_PROVIDER = defineChatSystemTool(manifest, context => defineTool({
  name: manifest.name, label: manifest.label, description: manifest.description, executionMode: "sequential",
  parameters: Type.Object({
    operation: Type.Union([Type.Literal("start"), Type.Literal("list"), Type.Literal("get"), Type.Literal("cancel")]),
    title: Type.Optional(Type.String()), text: Type.Optional(Type.String()), workId: Type.Optional(Type.String()),
    expectedTurnId: Type.Optional(Type.String()),
  }),
  async execute(callId, params) {
    if (context.purpose !== "execution" || !context.longAgentId) throw new Error("friend_work仅用于当前Friend的执行上下文");
    // Registry construction must not import the lifecycle that assembles this registry.
    const { startFriendWork, listFriendWork, readFriendWork, cancelFriendWork } = await import("../../../long-agents/work.js");
    const home = context.chatHome, agent = context.longAgentId;
    const result = params.operation === "list" ? await listFriendWork(home, agent)
      : params.operation === "get" ? await readFriendWork(home, agent, params.workId ?? "")
      : params.operation === "cancel" ? await cancelFriendWork(home, agent, params.workId ?? "", params.expectedTurnId ?? "")
      : await startFriendWork({ chatHome: home, longAgentId: agent, requestId: `tool:${context.longAgentTurnId}:${callId}`,
        originSessionId: context.sessionId, contextProjectId: context.collaborationProjectId ?? null, title: params.title ?? "", text: params.text ?? "" });
    return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
  },
}));
