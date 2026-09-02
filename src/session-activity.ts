import type { ChatProjectContext } from "./projects/types.js";
import { SessionLifecycleError } from "./session-errors.js";
import { getSessionExecution } from "./workflows/execution-registry.js";
import { findActivePlanningExecutionRun, setPlanningExecutionPhase } from "./workflows/planning-execution/review-state.js";
import {
  cancelChatSessionRun,
  findActiveChatSessionRun,
  listNonTerminalChatSessionRuns,
} from "./workflows/session-run-registry.js";

/**
 * 宽限期：一个 Run 刚被接受、Workflow 协程尚未被 Runtime pickup 的窗口内，
 * 进程内登记表还没有该 Session 的条目；此时保守视为运行中，避免误杀刚发起的 Run。
 */
const EXECUTION_GRACE_MS = 10_000;

/**
 * 对账崩溃窗口留下的非终态持久化记录。
 *
 * durable 记录在 Run 被接受时写入，进程死亡后无法自愈；只有本进程登记表
 * 说"没在跑"且记录已过宽限期时，才能判定它属于已死进程，并通过 Runtime
 * 公开 API 把状态收敛到终态，而不是让守卫永远拦截。
 */
export async function reconcileStaleChatSessionRuns(
  project: ChatProjectContext,
  sessionId: string,
): Promise<void> {
  if (getSessionExecution(sessionId) !== undefined) return;
  const now = Date.now();
  const planning = await findActivePlanningExecutionRun(project.projectDataDir, sessionId);
  if (planning !== undefined && planning.phase !== "waiting_review"
    && now - Date.parse(planning.updatedAt) > EXECUTION_GRACE_MS) {
    if (planning.runId !== undefined) await cancelChatSessionRun(planning.runId);
    await setPlanningExecutionPhase({
      projectDataDir: project.projectDataDir,
      projectId: project.projectId,
      workflowInvocationId: planning.workflowInvocationId,
      sessionId,
      phase: "failed",
    });
  }
  for (const run of await listNonTerminalChatSessionRuns(project.projectDataDir, sessionId)) {
    if (now - Date.parse(run.startedAt) <= EXECUTION_GRACE_MS) continue;
    await cancelChatSessionRun(run.runId);
  }
}

/** Prevents a Session file mutation while Workflow Runtime may still write it. */
export async function assertChatSessionIsIdle(project: ChatProjectContext, sessionId: string): Promise<void> {
  // 进程内登记表是唯一存活真源：登记条目存在即表示 Workflow 协程仍在本进程
  // 内驱动（含挂起等待审核）；崩溃后条目自然消失。
  const executing = getSessionExecution(sessionId);
  if (executing !== undefined) {
    throw new SessionLifecycleError(
      "SESSION_BUSY",
      `Session正在运行Workflow ${executing.workflowId}，暂时不能修改`,
    );
  }
  await reconcileStaleChatSessionRuns(project, sessionId);
  const [run, planningRun] = await Promise.all([
    findActiveChatSessionRun(project.projectDataDir, sessionId),
    findActivePlanningExecutionRun(project.projectDataDir, sessionId),
  ]);
  if (run !== undefined) {
    throw new SessionLifecycleError(
      "SESSION_BUSY",
      `Session正在运行Workflow ${run.workflowId}，暂时不能修改`,
    );
  }
  if (planningRun !== undefined) {
    throw new SessionLifecycleError("SESSION_BUSY", "Session存在未结束的Planning Workflow，暂时不能修改");
  }
}
