import { createError, defineEventHandler, readBody, setResponseStatus } from "nitro/h3";
import {
  DEFAULT_CHAT_WORKFLOW_ID,
  parseChatWorkflowHttpInput,
  type ChatWorkflowHttpInput,
} from "../run-request.js";
import { localTimestamp } from "../runtime-log.js";
import { startChatWorkflow } from "../workflows/start-chat-workflow.js";

/**
 * Chat浏览器前端使用这个接口异步启动用户选择的Workflow。
 *
 * 与用于人工调试的阻塞式`POST /run`不同，这里只等待Workflow成功创建，
 * 随即返回Run ID；调用方通过`GET /runs/:runId`读取状态和最终结果。
 */
export default defineEventHandler(async (event) => {
  let input: ChatWorkflowHttpInput;
  try {
    input = parseChatWorkflowHttpInput(await readBody<unknown>(event), {
      cwd: process.cwd(),
      prompt: "",
      workflow: DEFAULT_CHAT_WORKFLOW_ID,
    });
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }

  const { run: workflowRun, workflow, workflowInvocationId } = await startChatWorkflow(input);
  console.log(
    `${localTimestamp()} [workflow] accepted workflow=${workflow} invocationId=${workflowInvocationId} runId=${workflowRun.runId}`,
  );
  setResponseStatus(event, 202);
  return { runId: workflowRun.runId, workflow, status: "running" as const };
});
