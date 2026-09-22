import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { defineChatSystemTool } from "../../framework.js";
import manifest from "./tool.json" with { type: "json" };

/** Web and Agent mutate the same revisioned duty definitions through one backend service. */
export const DUTY_MANAGE_TOOL_PROVIDER = defineChatSystemTool(
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
            "end",
            "advance",
            "cancel-advance",
            "report",
          ].map((v) => Type.Literal(v)),
        ),
        dutyId: Type.Optional(Type.String()),
        expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
        requestId: Type.Optional(Type.String()),
        occurrenceId: Type.Optional(Type.String()),
        expectedTurnId: Type.Optional(Type.String()),
        definition: Type.Optional(
          Type.Object({
            name: Type.String({ maxLength: 120 }),
            objective: Type.String({ maxLength: 65536 }),
            materials: Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 100 }),
            outcome: Type.String({ maxLength: 65536 }),
            timeZone: Type.String(),
            cadence: Type.Union([
              Type.Object({ kind: Type.Literal("none") }),
              Type.Object({ kind: Type.Literal("cron"), expression: Type.String() }),
            ]),
            allowedHours: Type.Union([
              Type.Null(),
              Type.Object({
                start: Type.Integer({ minimum: 0, maximum: 23 }),
                end: Type.Integer({ minimum: 1, maximum: 24 }),
              }),
            ]),
            budget: Type.Union([
              Type.Null(),
              Type.Object({ tokensPerDay: Type.Integer({ minimum: 1 }) }),
            ]),
            totalUnits: Type.Union([Type.Null(), Type.Integer({ minimum: 1 })]),
          }),
        ),
        report: Type.Optional(
          Type.Object({
            summary: Type.String({ maxLength: 20000 }),
            evidence: Type.Array(
              Type.Union([
                Type.Object({ kind: Type.Literal("file"), path: Type.String({ maxLength: 1024 }) }),
                Type.Object({ kind: Type.Literal("work"), workId: Type.String() }),
                Type.Object({ kind: Type.Literal("note"), text: Type.String({ maxLength: 2000 }) }),
              ]),
              { maxItems: 20 },
            ),
            unitsDone: Type.Union([Type.Null(), Type.Integer({ minimum: 0 })]),
            nextStep: Type.Union([Type.Null(), Type.String({ maxLength: 65536 })]),
            nextCheckAt: Type.Union([Type.Null(), Type.String({ description: "ISO时间，必须含时区" })]),
            awaitingMaterial: Type.Boolean(),
          }),
        ),
      }),
      async execute(callId, params) {
        if (context.purpose !== "execution" || !context.longAgentId)
          throw new Error("duty_manage只服务于当前Friend执行上下文");
        // Interactive reports must serialize against the revision the caller actually observed.
        if ((params.operation === "report" || params.operation === "update" || params.operation === "pause" || params.operation === "resume" || params.operation === "end") && params.expectedRevision === undefined)
          throw new Error("该操作需要 expectedRevision：先用 duty_manage 的 list 读取当前 revision，再带上它重试");
        const { manageFriendDuty } = await import("../../../long-agents/duties/service.js");
        const result = await manageFriendDuty(context.chatHome, context.longAgentId, {
          ...params,
          schemaVersion: 1,
          source: "agent",
          ...(params.operation === "report"
            ? { turnId: context.longAgentTurnId ?? "" }
            : {}),
          // The request id is stable per tool call: it de-duplicates create/advance retries and
          // keys a management correction when the report comes from the direct conversation.
          ...(params.operation === "create" || params.operation === "advance" || params.operation === "report"
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
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      },
    }),
);
