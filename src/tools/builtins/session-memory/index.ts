import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { defineChatSystemTool } from "../../framework.js";
import { SESSION_MEMORY_PURPOSES, SESSION_MEMORY_PURPOSE_HINTS } from "../../../long-agents/session-memory-purposes.js";
import manifest from "./tool.json" with { type: "json" };

/** Agent-facing read/write entry for the current session's session memory. */
export const SESSION_MEMORY_TOOL_PROVIDER = defineChatSystemTool(
  manifest,
  (context) =>
    defineTool({
      name: manifest.name,
      label: manifest.label,
      description: manifest.description,
      executionMode: "sequential",
      parameters: Type.Object({
        operation: Type.Union([
          Type.Literal("list"),
          Type.Literal("write"),
          Type.Literal("supersede"),
          Type.Literal("history"),
        ]),
        // The defaults come from the SAME taxonomy the backend validates, but the label is OPEN: when
        // none of them fits, the agent may name its own short tag.
        purpose: Type.Optional(Type.String({
          maxLength: 40,
          description: `${SESSION_MEMORY_PURPOSES.map((purpose) => `${purpose}（${SESSION_MEMORY_PURPOSE_HINTS[purpose] ?? ""}）`).join("；")}；都不合适时可以自定义一个短标签`,
        })),
        author: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("user")])),
        content: Type.Optional(Type.String({ maxLength: 4000 })),
        originEntryId: Type.Optional(Type.String({ maxLength: 200 })),
        supersedes: Type.Optional(Type.String({ maxLength: 120 })),
        expectedRevision: Type.Optional(Type.Integer({ minimum: 0 })),
        afterEntryId: Type.Optional(Type.String({ maxLength: 200 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      }),
      async execute(_callId, params) {
        if (context.purpose !== "execution") throw new Error("session_memory 只服务于执行上下文，检查页不能读写会话记忆");
        const memory = await import("../../../long-agents/session-memory.js");
        const target = await memory.resolveSessionMemoryTarget({
          chatHome: context.chatHome,
          projectId: context.projectId,
          sessionId: context.sessionId,
          ...(context.longAgentId === undefined ? {} : { longAgentId: context.longAgentId }),
          binding: context.sessionMemoryTarget ?? null,
        });
        const result: unknown = await (async () => {
          if (params.operation === "list") {
            return await memory.readSessionMemory(context.chatHome, target.longAgentId, target.sessionId);
          }
          if (params.operation === "history") {
            return await memory.readSessionMemoryHistory({
              chatHome: context.chatHome,
              longAgentId: target.longAgentId,
              sessionId: target.sessionId,
              ...(params.afterEntryId === undefined ? {} : { afterEntryId: params.afterEntryId }),
              ...(params.limit === undefined ? {} : { limit: params.limit }),
            });
          }
          if (params.purpose === undefined || params.author === undefined || params.content === undefined || params.expectedRevision === undefined)
            throw new Error("write/supersede 需要 purpose、author、content 与 expectedRevision（先 list 读取 revision）");
          return await memory.writeSessionMemoryEntry({
            chatHome: context.chatHome,
            longAgentId: target.longAgentId,
            sessionId: target.sessionId,
            operation: params.operation,
            purpose: params.purpose,
            author: params.author,
            content: params.content,
            ...(params.originEntryId === undefined ? {} : { originEntryId: params.originEntryId }),
            ...(params.supersedes === undefined ? {} : { supersedes: params.supersedes }),
            expectedRevision: params.expectedRevision,
          });
        })();
        // The returned revision/entry ids are what the visible reply must cite (not the model's claim).
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
      },
    }),
);
