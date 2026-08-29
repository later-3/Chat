import { createError, defineEventHandler, readBody } from "nitro/h3";
import {
  DEFAULT_CHAT_WORKFLOW_ID,
  parseChatWorkflowHttpInput,
  type ChatWorkflowHttpInput,
} from "../run-request.js";
import { MINIMAL_PI_CODING_AGENT_PROMPT } from "../workflows/minimal-pi-coding-agent.js";
import { localTimestamp } from "../runtime-log.js";
import { startChatWorkflow } from "../workflows/start-chat-workflow.js";

/**
 * Nitro从`src/routes`扫描HTTP路由文件。当前文件名决定了请求方法和路径：
 *
 * - `run`对应路径`/run`；
 * - `post`对应HTTP POST方法；
 * - 默认导出的Event Handler处理匹配的请求。
 *
 * 因此这个文件处理`POST /run`。`src`下不在`routes`或`api`目录中的
 * `*.post.ts`文件不会因为文件名而成为HTTP路由。
 */
export default defineEventHandler(async (event) => {
  const requestStartedAt = Date.now();
  console.log(`${localTimestamp()} [http] POST /run received`);

  let input: ChatWorkflowHttpInput;
  try {
    const body = await readBody<unknown>(event);
    input = parseChatWorkflowHttpInput(body, {
      cwd: process.cwd(),
      prompt: MINIMAL_PI_CODING_AGENT_PROMPT,
      workflow: DEFAULT_CHAT_WORKFLOW_ID,
    });
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }

  /**
   * `startChatWorkflow()`调用Workflow Runtime创建一次Run，返回Run ID和结果Promise。
   * 变量名`workflowRun`与HTTP路径`/run`没有关联。
   *
   * 无请求体时，`input`使用固定Prompt和Nitro进程的启动目录；显式请求体
   * 可以传入其他Prompt和工作目录。
   */
  const { run: workflowRun, workflow, workflowInvocationId } = await startChatWorkflow(input);
  console.log(
    `${localTimestamp()} [workflow] started workflow=${workflow} invocationId=${workflowInvocationId} runId=${workflowRun.runId} elapsedMs=${Date.now() - requestStartedAt}`,
  );

  try {
    // 等待Workflow结束。成功时得到返回值；失败或取消时Promise会被拒绝。
    const result = await workflowRun.returnValue;
    console.log(
      `${localTimestamp()} [workflow] completed runId=${workflowRun.runId} elapsedMs=${Date.now() - requestStartedAt}`,
    );
    for (const line of result.text.split(/\r?\n/)) {
      console.log(`${localTimestamp()} [pi] response: ${line}`);
    }

    // 上面把Assistant文本打印到Nitro终端；这里再把完整结果作为HTTP JSON响应返回。
    return { runId: workflowRun.runId, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `${localTimestamp()} [workflow] failed runId=${workflowRun.runId} elapsedMs=${Date.now() - requestStartedAt} error=${message}`,
    );

    // 抛出原错误，由Nitro生成失败的HTTP响应。
    throw error;
  }
});
