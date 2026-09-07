import { validateToolArguments, type Static, type TSchema } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { appendChatAuditEvent } from "../../../audit-log.js";
import { PersistedWriteError, RevisionConflict } from "../../../persistence/versioned-file.js";
import { ProjectManagementError } from "../../../projects/management-contract.js";
import { defineChatSystemTool, type ChatToolRuntimeContext, type ChatToolProvider } from "../../framework.js";

/** Lazy service import at each provider avoids a Tool -> Workflow Registry initialization cycle. */
export function defineProjectTool<T extends TSchema>(
  manifest: unknown,
  parameters: T,
  operation: (params: Static<T>, context: ChatToolRuntimeContext) => Promise<unknown>,
): ChatToolProvider {
  return defineChatSystemTool(manifest, (context, identity) => {
    const name = decodeURIComponent(identity.address.split("/").at(-1) ?? "");
    const writing = name !== "project_search" && name !== "project_read";
    return defineTool({
      name,
      label: name,
      description: typeof manifest === "object" && manifest !== null && "description" in manifest ? String(manifest.description) : name,
      executionMode: "sequential",
      parameters,
      async execute(toolCallId, params, signal) {
        let applied = false;
        try {
          signal?.throwIfAborted();
          const validated: Static<T> = validateToolArguments({ name, description: name, parameters }, { type: "toolCall", id: toolCallId, name, arguments: params });
          if (context.purpose !== "execution") throw new ProjectManagementError("INSPECTION_ONLY", "检查模式不能执行Project操作");
          const details = await operation(validated, context);
          applied = writing && !(typeof details === "object" && details !== null && "status" in details && details.status === "validated");
          const result = typeof details === "object" && details !== null ? details : {};
          await appendChatAuditEvent({
            action: name.replace("_", "."),
            target: "project" in result && typeof result.project === "object" && result.project !== null && "projectId" in result.project
              ? { kind: "project", projectId: result.project.projectId } : { kind: "project-catalog" },
            source: {
              type: "pi-tool", projectId: context.projectId, sessionId: context.sessionId, agentId: context.agentId,
              longAgentId: context.longAgentId ?? null, turnId: context.longAgentTurnId ?? null,
              workflowId: context.workflowId ?? null, workflowInvocationId: context.workflowInvocationId ?? null,
              toolCallId, toolAddress: identity.address, toolVersion: identity.version,
            },
            details: { applied, expectedRevision: "expectedRevision" in params ? params.expectedRevision : null,
              revision: "revision" in result ? result.revision : null,
              changes: "changes" in result ? result.changes : null },
          }, context.chatHome);
          return { content: [{ type: "text", text: JSON.stringify(details) }], details };
        } catch (error) {
          const details = {
            code: error instanceof RevisionConflict ? error.code : error instanceof ProjectManagementError || error instanceof PersistedWriteError ? error.code : applied ? "PERSISTENCE_INCOMPLETE" : "INVALID_INPUT",
            message: error instanceof RevisionConflict || error instanceof ProjectManagementError || error instanceof PersistedWriteError ? error.message : applied ? "变更已完成，但审计写入失败；先读取项目状态再重试" : "Project操作失败，请检查参数、配置与资源是否有效",
            applied: applied || ((error instanceof ProjectManagementError || error instanceof PersistedWriteError) && error.applied),
            retryable: error instanceof RevisionConflict || error instanceof PersistedWriteError,
            ...(error instanceof RevisionConflict ? { currentRevision: error.currentRevision } : {}),
          };
          // Pi marks a native ToolResult as an error only when execute throws.
          throw new Error(JSON.stringify(details), { cause: error });
        }
      },
    });
  });
}
