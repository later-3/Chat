import { createError, defineEventHandler, readBody, setResponseStatus } from "nitro/h3";
import {
  parseChatWorkflowHttpInput,
  type ChatWorkflowHttpInput,
} from "../run-request.js";
import { getStoredAgentConfigs, resolveChatConfig } from "../chat-config.js";
import { resolveRequestProject } from "../projects/request.js";
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
    const body = await readBody<unknown>(event);
    const project = await resolveRequestProject(body, process.cwd());
    const config = (await resolveChatConfig(project.projectId, project.chatHome)).effective;
    const requestedWorkflow = typeof body === "object" && body !== null && "workflow" in body
      && typeof body.workflow === "string"
      ? body.workflow
      : config.defaultWorkflowId;
    const storedAgentConfigs = getStoredAgentConfigs(config, requestedWorkflow);
    input = parseChatWorkflowHttpInput(body, {
      projectId: project.projectId,
      chatHome: project.chatHome,
      cwd: project.cwd,
      prompt: "",
      workflow: config.defaultWorkflowId,
      ...(storedAgentConfigs === undefined ? {} : { defaultAgentConfigs: storedAgentConfigs }),
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
