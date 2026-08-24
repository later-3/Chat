import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ProjectBootstrapProductPort } from "./direct-executor-service.js";

export const PROJECT_BOOTSTRAP_TOOL = "project_bootstrap_prepare";
export const PROJECT_BOOTSTRAP_PROVIDER_SCOPE = "chat:project-bootstrap-candidate.v1";

/**
 * Profile检查与真实AgentSession共用同一Tool定义和实现模块。该Tool只耐久准备Candidate，
 * 不执行Plane或Workspace写入；实际外部写仍由任务02的专用Outbox/Dispatcher负责。
 */
export function createProjectBootstrapExtension(input: {
  readonly productRunId: string;
  readonly product: ProjectBootstrapProductPort;
}): ExtensionFactory {
  return (pi) => {
    pi.registerTool(
      defineTool({
        name: PROJECT_BOOTSTRAP_TOOL,
        label: "准备项目初始化",
        description:
          "预检本地Workspace与Plane CE名称，生成需要用户确认的项目初始化候选；不会直接创建目录或Plane项目。",
        promptSnippet: "准备受控的Plane CE + Git Workspace项目初始化候选",
        promptGuidelines: [
          "先确认项目目标、Plane标识、本地目录和初始模块，再调用一次。",
          "工具返回prepared只表示候选已落盘；必须明确告诉用户仍需审核确认，不能声称项目已创建。",
        ],
        executionMode: "sequential",
        parameters: Type.Object(
          {
            name: Type.String({ minLength: 1, maxLength: 160 }),
            objective: Type.String({ minLength: 1, maxLength: 4000 }),
            planeWorkspaceSlug: Type.String({ minLength: 1, maxLength: 80 }),
            planeProjectIdentifier: Type.String({ minLength: 1, maxLength: 12 }),
            workspaceRootId: Type.String({ minLength: 1, maxLength: 120 }),
            directoryName: Type.String({ minLength: 1, maxLength: 120 }),
            initializerProfile: Type.Union([Type.Literal("blank"), Type.Literal("ai_learning")]),
            initialModules: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), {
              maxItems: 8,
            }),
          },
          { additionalProperties: false },
        ),
        async execute(toolCallId, params, signal) {
          if (signal?.aborted === true) throw new Error("direct_executor.timeout");
          const commandId = `cmd_${createHash("sha256")
            .update(`${input.productRunId}\n${toolCallId}`, "utf8")
            .digest("hex")
            .slice(0, 48)}`;
          const candidate = await input.product.prepare({
            commandId,
            productRunId: input.productRunId,
            proposal: {
              name: params.name,
              objective: params.objective,
              planeWorkspaceSlug: params.planeWorkspaceSlug,
              planeProjectIdentifier: params.planeProjectIdentifier,
              workspaceRootId: params.workspaceRootId,
              directoryName: params.directoryName,
              initializerProfile: params.initializerProfile,
              initialModules: params.initialModules,
            },
          });
          const summary = {
            projectBootstrapCandidateId: candidate.projectBootstrapCandidateId,
            candidateRevision: candidate.revision,
            candidateSha256: candidate.sha256,
            status: candidate.status,
            preview: candidate.preview,
          };
          return {
            content: [
              {
                type: "text",
                text: `${JSON.stringify(summary)}\n候选已准备，尚未创建任何外部资源；请让用户审核确认。`,
              },
            ],
            details: summary,
          };
        },
      }),
    );
  };
}
