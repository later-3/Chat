import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { defineChatSystemTool } from "../../framework.js";
import manifest from "./tool.json" with { type: "json" };

/** Content generation happens in the model; identity, commit and verification stay on the server. */
export const ARTIFACT_MANAGE_TOOL_PROVIDER = defineChatSystemTool(
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
          Type.Literal("submit"),
          Type.Literal("resubmit"),
          Type.Literal("revise"),
          Type.Literal("notify"),
        ]),
        kind: Type.Optional(Type.Union([Type.Literal("post"), Type.Literal("note")])),
        content: Type.Optional(Type.String({ maxLength: 60000, description: "submit/revise：笔记或动态正文" })),
        path: Type.Optional(Type.String({ maxLength: 1024, description: "submit(kind=note)：相对工作区的笔记路径" })),
        artifactId: Type.Optional(Type.String({ description: "resubmit/revise/notify：产物 id" })),
        from: Type.Optional(Type.String({ description: "list：起始日期 YYYY-MM-DD" })),
        to: Type.Optional(Type.String({ description: "list：结束日期 YYYY-MM-DD" })),
        state: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("committed"), Type.Literal("failed")])),
      }),
      async execute(_callId, params) {
        if (context.purpose !== "execution" || !context.longAgentId)
          throw new Error("artifact_manage只服务于当前Friend执行上下文");
        const artifacts = await import("../../../long-agents/artifacts/service.js");
        const operation = String(params.operation);
        const home = context.chatHome;
        const agentId = context.longAgentId;
        const result =
          operation === "list"
            ? await artifacts.listFriendArtifacts(home, agentId, {
                ...(params.from === undefined ? {} : { from: params.from }),
                ...(params.to === undefined ? {} : { to: params.to }),
                ...(params.state === undefined ? {} : { state: params.state }),
              })
            : operation === "submit"
              ? await artifacts.submitArtifact(home, agentId, {
                  kind: params.kind,
                  content: params.content,
                  path: params.path,
                  turnId: context.longAgentTurnId ?? "",
                })
              : operation === "resubmit"
                ? await artifacts.resubmitArtifact(home, agentId, String(params.artifactId ?? ""))
                : operation === "revise"
                  ? await artifacts.reviseArtifact(home, agentId, { artifactId: params.artifactId, content: params.content })
                  : operation === "notify"
                    ? await artifacts.notifyArtifact(home, agentId, String(params.artifactId ?? ""))
                    : (() => {
                        throw new Error(`未知operation: ${operation}`);
                      })();
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result as Record<string, unknown> };
      },
    }),
);
