import type {
  ISessions,
  IWorkspaces,
  SessionId,
  WorkspaceId,
} from "@deepseek-ai/dsh-client-runtime/client";

type ProjectBootstrapSessions = Pick<ISessions, "list" | "open">;
type ProjectBootstrapWorkspaces = Pick<IWorkspaces, "list" | "connectWorkspace">;

/** 点击时冻结当前Session所属Workspace；后续异步请求或用户导航不能改变目标。 */
export function resolveProjectBootstrapWorkspaceId(
  sessions: ProjectBootstrapSessions,
  workspaces: ProjectBootstrapWorkspaces,
): WorkspaceId {
  const workspaceSnapshot = workspaces.list.getSnapshot();
  if (!workspaceSnapshot.baselinesReady) throw new Error("DSH Workspace仍在加载");
  const currentSessionId = sessions.list.getSnapshot().current;
  const target =
    currentSessionId === undefined
      ? workspaceSnapshot.recentWorkspaceId
      : workspaceSnapshot.items.find((workspace) => workspace.sessionIds.includes(currentSessionId))
          ?.workspaceId;
  if (target === undefined) throw new Error("当前会话没有可用Workspace");
  return target;
}

/** 只接受connectWorkspace返回的精确Session ID；全局current变化不参与判定。 */
export async function connectProjectBootstrapSession(
  sessions: ProjectBootstrapSessions,
  workspaces: ProjectBootstrapWorkspaces,
  workspaceId: WorkspaceId,
  initialize: (sessionId: SessionId) => Promise<void>,
): Promise<SessionId> {
  const sessionId = await workspaces.connectWorkspace(workspaceId);
  await initialize(sessionId);
  sessions.open(sessionId);
  return sessionId;
}
