import type { ChatWorkflowInput, ChatWorkflowResult } from "../types.js";

export async function runChatDirectStep(
  input: ChatWorkflowInput,
): Promise<ChatWorkflowResult> {
  "use step";

  if (input.acceptedLongAgentTurn === undefined) {
    // 默认工作流（连续会话）**只有一个运行路径**：先受理（Long Agent 冻结），再由 Long Agent 执行。
    // 旧的"无受理直连"路径已删除——它依赖工作流内置 Agent（`pi-coding-agent`），与"工作流不再定义 Agent"冲突。
    throw new Error("chat-direct 需要已受理的 Long Agent 轮次（缺少 acceptedLongAgentTurn）");
  }
  const { executeLongAgentWorkflowStep } = await import("../long-agent-context.js");
  return executeLongAgentWorkflowStep(input);
}

runChatDirectStep.maxRetries = 0;
