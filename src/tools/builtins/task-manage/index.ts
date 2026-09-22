import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { defineChatSystemTool } from "../../framework.js";
import manifest from "./tool.json" with { type: "json" };

/** Both Web and Agent mutate the same revisioned task definition. Nano is only a trigger projection. */
export const TASK_MANAGE_TOOL_PROVIDER = defineChatSystemTool(
  manifest,
  (context) =>
    defineTool({
      name: manifest.name,
      label: manifest.label,
      description: manifest.description,
      executionMode: "sequential",
      parameters: Type.Object({
        operation: Type.Union(
          [
            "list",
            "create",
            "update",
            "pause",
            "resume",
            "cancel",
            "run",
            "cancel-run",
          ].map((v) => Type.Literal(v)),
        ),
        taskId: Type.Optional(Type.String()),
        expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
        occurrenceId: Type.Optional(Type.String()),
        expectedTurnId: Type.Optional(Type.String()),
        definition: Type.Optional(
          Type.Object({
            name: Type.String({ maxLength: 120 }),
            prompt: Type.String({ maxLength: 65536 }),
            timeZone: Type.String(),
            schedule: Type.Union([
              Type.Object({
                kind: Type.Literal("once"),
                at: Type.String({ description: "ISO时间，必须含时区" }),
              }),
              Type.Object({
                kind: Type.Literal("cron"),
                expression: Type.String(),
              }),
              Type.Object({
                kind: Type.Literal("event"),
                source: Type.String(),
              }),
            ]),
            missed: Type.Union([Type.Literal("skip"), Type.Literal("latest")]),
            overlap: Type.Union([
              Type.Literal("skip"),
              Type.Literal("queue-one"),
            ]),
          }),
        ),
      }),
      async execute(callId, params) {
        if (context.purpose !== "execution" || !context.longAgentId)
          throw new Error("task_manage只服务于当前Friend执行上下文");
        const { manageFriendTask } =
          await import("../../../long-agents/tasks/service.js");
        const result = await manageFriendTask(
          context.chatHome,
          context.longAgentId,
          {
            ...params,
            schemaVersion: 2,
            ...(params.operation === "create" || params.operation === "run"
              ? { requestId: `tool:${context.longAgentTurnId}:${callId}` }
              : {}),
            ...(params.definition
              ? {
                  definition: {
                    ...params.definition,
                    contextProjectId: context.collaborationProjectId ?? null,
                  },
                }
              : {}),
          },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      },
    }),
);
