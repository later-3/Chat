import { CHAT_DIRECT_WORKFLOW_MANIFEST } from "../catalog.js";
import { defineChatWorkflow } from "../framework.js";
import { chatDirectWorkflow } from "./workflow.js";

// `POST /run` uses this Prompt when the VS Code debug request has no body.
export const CHAT_DIRECT_PROMPT = `
回复你好。
`.trim();

/** Complete definition exposed to Chat's Workflow registry. */
export const chatDirectWorkflowDefinition = defineChatWorkflow({
  manifest: CHAT_DIRECT_WORKFLOW_MANIFEST,
  // 工作流不再定义 Agent：执行主体由本轮 Long Agent 决定（装配唯一出口）。
  agents: [],
  run: chatDirectWorkflow,
  // The single Agent step forwards user images straight into the Pi prompt.
  supportsImageInput: true,
});

export { chatDirectWorkflow } from "./workflow.js";
export { runChatDirectStep } from "./step.js";
