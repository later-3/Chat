import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  InteractionProjectError,
  isOwnerPrivateTurn,
  readLongAgentInteractionProject,
  setLongAgentInteractionProject,
} from "../../../long-agents/interaction-project.js";
import type { ChatToolProvider } from "../../framework.js";
import { defineChatSystemTool } from "../../framework.js";
import manifest from "./tool.json" with { type: "json" };

function result(details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

function stateDetails(longAgentId: string, state: Awaited<ReturnType<typeof readLongAgentInteractionProject>>) {
  return {
    longAgentId,
    status: state.status,
    projectId: state.projectId,
    revision: state.revision,
    effective: state.effective,
  };
}

/**
 * Agent-side entry for the Friend's own private-chat collaboration project.
 *
 * The identity is the trusted `toolContext.longAgentId`, never a tool argument, so a Friend can only
 * change its own association. Group participation scopes register no Chat system Tool at all
 * (`CONVERSATION_SAFE_SYSTEM_TOOLS` is empty), so a group member cannot use this to change the
 * private preference. It calls exactly the same service as the owner-facing HTTP route.
 */
export const COLLABORATION_PROJECT_TOOL_PROVIDER: ChatToolProvider = defineChatSystemTool(
  manifest,
  (context) => defineTool({
    name: manifest.name,
    label: manifest.label,
    description: manifest.description,
    executionMode: "sequential",
    parameters: Type.Object({
      operation: Type.Union([Type.Literal("read"), Type.Literal("set"), Type.Literal("clear")]),
      projectId: Type.Optional(Type.String({ description: "set：要关联的用户 Project id" })),
      expectedRevision: Type.Optional(Type.Number({ description: "set/clear：当前关联 revision（首次为 0）" })),
    }),
    async execute(_toolCallId, params) {
      if (context.purpose !== "execution") throw new Error("检查模式不能修改协作项目关联");
      const longAgentId = context.longAgentId;
      if (longAgentId === undefined) throw new Error("collaboration_project 只服务于 Long Agent 身份的执行上下文");
      // Identity is not authorization: a channel/scheduled/background turn has the same longAgentId.
      // Only the local owner's own private chat turn may read or change the private association.
      if (!await isOwnerPrivateTurn(context.chatHome, longAgentId, context.longAgentTurnId))
        throw new Error("只有用户本人在私聊中可以读取或修改协作项目关联；渠道、定时与后台执行没有该授权");
      const record = params as Record<string, unknown>;
      const operation = String(record.operation);
      const state = await readLongAgentInteractionProject(context.chatHome, longAgentId);
      if (operation === "read") return result({ operation, ...stateDetails(longAgentId, state) });
      const expectedRevision = Number(record.expectedRevision);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
        throw new Error("set/clear 需要有效的 expectedRevision");
      try {
        if (operation === "clear") {
          return result({ operation, ...stateDetails(longAgentId, await setLongAgentInteractionProject({
            chatHome: context.chatHome, longAgentId, projectId: null, expectedRevision,
          })) });
        }
        if (operation === "set") {
          if (typeof record.projectId !== "string" || record.projectId.trim() === "")
            throw new Error("set 需要 projectId");
          return result({ operation, ...stateDetails(longAgentId, await setLongAgentInteractionProject({
            chatHome: context.chatHome, longAgentId, projectId: record.projectId, expectedRevision,
          })) });
        }
      } catch (error) {
        if (error instanceof InteractionProjectError) throw new Error(error.message);
        throw error;
      }
      throw new Error("operation 必须是 read/set/clear");
    },
  }),
);
