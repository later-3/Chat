import type { ChatWorkflowDefinition } from "../registry.js";
import { PI_CODING_AGENT } from "./agents/pi-coding-agent.js";
import { minimalPiCodingAgentWorkflow } from "./workflow.js";

// `POST /run` uses this Prompt when the VS Code debug request has no body.
export const MINIMAL_PI_CODING_AGENT_PROMPT = `
回复你好。
`.trim();

/** Complete definition exposed to Chat's Workflow registry. */
export const minimalPiCodingAgentWorkflowDefinition = {
  id: "minimal-pi-coding-agent",
  name: "直接执行",
  description: "使用一个Pi Coding Agent直接处理当前用户请求。",
  stages: [{
    id: "execute",
    name: "执行",
    description: "由Pi Coding Agent处理用户请求。",
    agentId: PI_CODING_AGENT.id,
  }],
  agents: [PI_CODING_AGENT],
  run: minimalPiCodingAgentWorkflow,
} as const satisfies ChatWorkflowDefinition<"minimal-pi-coding-agent">;

export { minimalPiCodingAgentWorkflow } from "./workflow.js";
export { runPiCodingAgentPromptStep } from "./step.js";
