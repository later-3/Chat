import { createError, defineEventHandler, readBody, setResponseStatus } from "nitro/h3";
import {
  parseChatWorkflowHttpInput,
  type ChatWorkflowHttpInput,
} from "../run-request.js";
import { getStoredAgentConfigs, resolveChatConfig } from "../chat-config.js";
import { resolveRequestProject } from "../projects/request.js";
import { localTimestamp } from "../runtime-log.js";
import { startChatWorkflow } from "../workflows/start-chat-workflow.js";
import { openChatSession } from "../chat-session.js";
import {
  collectPendingPlanReview,
  findActivePlanningExecutionRun,
  getPlanningExecutionRun,
} from "../workflows/planning-execution/review-state.js";

const sessionStartTails = new Map<string, Promise<void>>();

async function withSessionStartLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = sessionStartTails.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  sessionStartTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (sessionStartTails.get(key) === tail) sessionStartTails.delete(key);
  }
}

async function assertSessionHasNoActivePlanningRun(input: ChatWorkflowHttpInput): Promise<void> {
  if (input.sessionId === undefined) return;
  const chatSession = await openChatSession(input);
  if (chatSession.projectContext === undefined) return;
  const active = await findActivePlanningExecutionRun(
    chatSession.projectContext.projectDataDir,
    input.sessionId,
  );
  if (active !== undefined) {
    const suffix = active.phase === "waiting_review" && active.currentReview !== undefined
      ? `等待计划v${String(active.currentReview.planRevision)}审核`
      : `处于${active.phase}阶段`;
    throw createError({ statusCode: 400, statusMessage: `Session已有规划执行Workflow${suffix}` });
  }

  // Compatibility fallback for a Session created before durable Run bindings existed.
  const pendingReview = collectPendingPlanReview(chatSession.manager.getEntries());
  if (pendingReview === undefined) return;
  const legacyActive = await getPlanningExecutionRun(
    chatSession.projectContext.projectDataDir,
    pendingReview.workflowInvocationId,
  );
  if (legacyActive?.phase === "waiting_review") {
    throw createError({
      statusCode: 400,
      statusMessage: `Session当前正在等待计划v${String(pendingReview.planRevision)}审核`,
    });
  }
}

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

  const start = () => startChatWorkflow(input);
  const { run: workflowRun, workflow, workflowInvocationId } = input.sessionId === undefined
    ? await start()
    : await withSessionStartLock(`${input.projectId ?? ""}:${input.sessionId}`, async () => {
        await assertSessionHasNoActivePlanningRun(input);
        return start();
      });
  console.log(
    `${localTimestamp()} [workflow] accepted workflow=${workflow} invocationId=${workflowInvocationId} runId=${workflowRun.runId}`,
  );
  setResponseStatus(event, 202);
  return {
    runId: workflowRun.runId,
    workflowInvocationId,
    workflow,
    status: "running" as const,
  };
});
