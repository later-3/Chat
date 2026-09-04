import { Type } from "@earendil-works/pi-ai";
import { defineTool, type SessionManager } from "@earendil-works/pi-coding-agent";
import {
  listAgentCallableWorkflowTargets,
  type AgentCallableWorkflowTarget,
} from "./catalog.js";
import {
  type ChatWorkflowCallDescription,
  DEFAULT_CHAT_WORKFLOW_CALL_WAIT_TIMEOUT_MS,
  MAX_CHAT_WORKFLOW_CALL_WAIT_TIMEOUT_MS,
  type ChatWorkflowCallRuntime,
  type ChatWorkflowCallResult,
} from "./workflow-call-contract.js";
import {
  cancelChatWorkflowCall,
  describeChatWorkflowCallTarget,
  startChatWorkflowCall,
  waitChatWorkflowCall,
} from "./workflow-call-runtime.js";
import type { WorkflowCallProgress } from "./workflow-call-progress.js";
import { MAX_ACTIVE_CHAT_WORKFLOW_CALLS_PER_PARENT } from "./workflow-call-capacity.js";

export interface WorkflowCallToolContext {
  readonly purpose: "execution" | "inspection";
  readonly projectId?: string;
  readonly chatHome?: string;
  readonly cwd: string;
  readonly sessionManager: SessionManager;
  readonly workflowId: string;
  readonly workflowInvocationId: string;
  readonly stageId: string;
  readonly agentId: string;
}

const DEFAULT_WORKFLOW_CALL_RUNTIME: ChatWorkflowCallRuntime = {
  describe: describeChatWorkflowCallTarget,
  start: startChatWorkflowCall,
  wait: waitChatWorkflowCall,
  cancel: cancelChatWorkflowCall,
};

function descriptionText(description: ChatWorkflowCallDescription): string {
  const lines = [
    `Workflow ${description.workflowId} (${description.name})`,
    description.description,
  ];
  for (const agent of description.agents) {
    lines.push("", `Agent ${agent.agentId} (${agent.name})`, agent.description, "Tools:");
    lines.push(...(agent.tools.length === 0
      ? ["- none"]
      : agent.tools.map((tool) => `- ${tool.name}: ${tool.description.replace(/\s+/g, " ").trim()}`)));
    lines.push("Skills:");
    lines.push(...(agent.skills.length === 0
      ? ["- none"]
      : agent.skills.map((skill) => `- ${skill.name}: ${skill.description.replace(/\s+/g, " ").trim()}`)));
  }
  lines.push(
    "",
    "Use these exact Agent, Tool, and Skill names in action=start. Every listed Child Agent requires one explicit selection; empty tools/skills arrays are allowed.",
  );
  return lines.join("\n");
}

function resultText(result: ChatWorkflowCallResult): string {
  if (result.status === "running") {
    return [
      `Workflow ${result.workflowId} is still running after waiting ${String(result.waitTimeoutMs)}ms.`,
      `callId=${result.callId}`,
      `runId=${result.runId}`,
      `workflowInvocationId=${result.workflowInvocationId}`,
      `sessionId=${result.sessionId}`,
      `elapsedMs=${String(result.elapsedMs)}`,
      "Use workflow_call action=wait with this callId to wait again, or action=cancel to stop it.",
    ].join("\n");
  }
  if (result.status === "cancelled") {
    return [
      `Workflow ${result.workflowId} was cancelled after ${String(result.durationMs)}ms.`,
      `callId=${result.callId}`,
      `runId=${result.runId}`,
      `workflowInvocationId=${result.workflowInvocationId}`,
      `sessionId=${result.sessionId}`,
    ].join("\n");
  }
  return [
    `Workflow ${result.workflowId} completed in ${String(result.durationMs)}ms.`,
    `callId=${result.callId}`,
    `runId=${result.runId}`,
    `workflowInvocationId=${result.workflowInvocationId}`,
    `sessionId=${result.sessionId}`,
    "",
    result.text,
  ].join("\n");
}

function progressText(progress: WorkflowCallProgress): string {
  const location = progress.childToolName ?? progress.stageId ?? progress.phase;
  return `Workflow ${progress.workflowId} ${progress.status}: ${location} · ${String(progress.elapsedMs)}ms`;
}

function targetCatalogLines(targets: readonly AgentCallableWorkflowTarget[]): string[] {
  if (targets.length === 0) return ["- No Workflow is currently available to this caller."];
  return targets.map((target) => (
    `- \`${target.id}\` (${target.name}) [agents: ${target.agentIds.join(", ")}]: ${target.description.replace(/\s+/g, " ").trim()}`
  ));
}

function targetIdSchema(targets: readonly AgentCallableWorkflowTarget[]) {
  const description = targets.length === 0
    ? "No target Workflow is currently available to this caller."
    : `Exact target Workflow ID. Available IDs: ${targets.map((target) => target.id).join(", ")}.`;
  return targets.length === 0
    ? Type.String({ minLength: 1, maxLength: 100, description })
    : Type.Union(
        targets.map((target) => Type.Literal(target.id)),
        { description },
      );
}

function waitTimeoutSchema() {
  return Type.Optional(Type.Integer({
    minimum: 0,
    maximum: MAX_CHAT_WORKFLOW_CALL_WAIT_TIMEOUT_MS,
    default: DEFAULT_CHAT_WORKFLOW_CALL_WAIT_TIMEOUT_MS,
    description: [
      "How long this Tool invocation waits for a terminal result in milliseconds.",
      "A timeout returns status=running and does not cancel the child; 0 returns immediately after start.",
    ].join(" "),
  }));
}

/** Pi Tool underlying the private workflow-delegation Skill. */
export function createWorkflowCallTool(
  context: WorkflowCallToolContext,
  runtime: ChatWorkflowCallRuntime = DEFAULT_WORKFLOW_CALL_RUNTIME,
  targets: readonly AgentCallableWorkflowTarget[] = listAgentCallableWorkflowTargets(),
) {
  const catalogLines = targetCatalogLines(targets);
  return defineTool({
    name: "workflow_call",
    label: "Call workflow",
    description: [
      "Describe, start, wait for, or cancel one Chat Workflow running in an isolated Subsession.",
      `Each start/wait waits at most ${String(DEFAULT_CHAT_WORKFLOW_CALL_WAIT_TIMEOUT_MS)}ms by default and returns a resumable callId if the child is still running.`,
      `One parent Session may have at most ${String(MAX_ACTIVE_CHAT_WORKFLOW_CALLS_PER_PARENT)} active child calls; terminal calls free capacity and do not limit later calls.`,
      "Available targets for the current caller:",
      ...catalogLines,
    ].join("\n"),
    promptSnippet: [
      "Use workflow_call when a listed Workflow is better suited to a self-contained part of the current request.",
      "Use action=describe before start to discover the exact Child Agent, Tool, and Skill names you may choose.",
      "Use action=start to create a child and explicitly select tools and skills for every Child Agent. If it returns status=running, use action=wait repeatedly until terminal, or action=cancel when the child is no longer needed.",
      "A wait timeout only yields control back to you; it never cancels the child. Only cancel when stopping it is intentional.",
      "Do not start the same work package again or claim it finished while its call is still running. Control one call with at most one wait or cancel operation per turn.",
      "You can explain the exact available targets and their purposes from this catalog:",
      ...catalogLines,
      "Use only a listed Workflow ID. The prompt must contain the objective, relevant context, constraints, expected output, and authorization boundary. Child capabilities come only from your explicit start selection.",
    ].join("\n"),
    executionMode: "parallel",
    parameters: Type.Union([
      Type.Object({
        action: Type.Literal("describe"),
        workflowId: targetIdSchema(targets),
      }, { additionalProperties: false }),
      Type.Object({
        action: Type.Literal("start"),
        workflowId: targetIdSchema(targets),
        prompt: Type.String({ minLength: 1, maxLength: 100_000 }),
        agents: Type.Array(Type.Object({
          agentId: Type.String({ minLength: 1, maxLength: 100 }),
          tools: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 128 }),
          skills: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 128 }),
        }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }),
        waitTimeoutMs: waitTimeoutSchema(),
      }, { additionalProperties: false }),
      Type.Object({
        action: Type.Literal("wait"),
        callId: Type.String({ minLength: 1, maxLength: 100 }),
        waitTimeoutMs: waitTimeoutSchema(),
      }, { additionalProperties: false }),
      Type.Object({
        action: Type.Literal("cancel"),
        callId: Type.String({ minLength: 1, maxLength: 100 }),
      }, { additionalProperties: false }),
    ]),
    async execute(toolCallId, params, signal, onUpdate) {
      if (context.purpose !== "execution") throw new Error("Agent检查期间不能调用Workflow");
      const controlInput = {
        parentSessionManager: context.sessionManager,
        ...(signal === undefined ? {} : { signal }),
        onProgress: (progress: WorkflowCallProgress) => {
          onUpdate?.({
            content: [{ type: "text", text: progressText(progress) }],
            details: progress,
          });
        },
      };
      if (params.action === "describe") {
        if (context.projectId === undefined || context.chatHome === undefined) {
          throw new Error("Workflow调用缺少Project运行上下文");
        }
        const description = await runtime.describe({
          projectId: context.projectId,
          chatHome: context.chatHome,
          cwd: context.cwd,
          targetWorkflowId: params.workflowId,
        });
        return {
          content: [{ type: "text", text: descriptionText(description) }],
          details: description,
        };
      }
      let result: ChatWorkflowCallResult;
      if (params.action === "start") {
        if (context.projectId === undefined || context.chatHome === undefined) {
          throw new Error("Workflow调用缺少Project运行上下文");
        }
        result = await runtime.start({
          ...controlInput,
          projectId: context.projectId,
          chatHome: context.chatHome,
          cwd: context.cwd,
          parentWorkflowId: context.workflowId,
          parentWorkflowInvocationId: context.workflowInvocationId,
          parentStageId: context.stageId,
          parentAgentId: context.agentId,
          toolCallId,
          targetWorkflowId: params.workflowId,
          prompt: params.prompt,
          agents: params.agents,
          ...(params.waitTimeoutMs === undefined ? {} : { waitTimeoutMs: params.waitTimeoutMs }),
        });
      } else if (params.action === "wait") {
        result = await runtime.wait({
          ...controlInput,
          callId: params.callId,
          ...(params.waitTimeoutMs === undefined ? {} : { waitTimeoutMs: params.waitTimeoutMs }),
        });
      } else {
        result = await runtime.cancel({
          ...controlInput,
          callId: params.callId,
        });
      }
      return {
        content: [{ type: "text", text: resultText(result) }],
        details: result,
      };
    },
  });
}
