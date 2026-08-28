import { createError, defineEventHandler, readBody, setResponseStatus } from "nitro/h3";
import { start } from "workflow/api";
import {
  parseMinimalWorkflowHttpInput,
  type MinimalWorkflowHttpInput,
} from "../run-request.js";
import { minimalPiCodingAgentWorkflow } from "../workflows/minimal-pi-coding-agent.js";
import { localTimestamp } from "../runtime-log.js";

/**
 * Pi Web Adapter使用这个接口异步启动Workflow。
 *
 * 与用于人工调试的阻塞式`POST /run`不同，这里只等待Workflow成功创建，
 * 随即返回Run ID；调用方通过`GET /runs/:runId`读取状态和最终结果。
 */
export default defineEventHandler(async (event) => {
  let input: MinimalWorkflowHttpInput;
  try {
    input = parseMinimalWorkflowHttpInput(await readBody<unknown>(event), {
      cwd: process.cwd(),
      prompt: "",
    });
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }

  const workflowRun = await start(minimalPiCodingAgentWorkflow, [input]);
  console.log(`${localTimestamp()} [workflow] accepted runId=${workflowRun.runId}`);
  setResponseStatus(event, 202);
  return { runId: workflowRun.runId, status: "running" as const };
});
