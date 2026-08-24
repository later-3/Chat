import assert from "node:assert/strict";
import test from "node:test";
import type {
  ISessions,
  IWorkspaces,
  SessionId,
  WorkspaceId,
} from "@deepseek-ai/dsh-client-runtime/client";
import {
  connectProjectBootstrapSession,
  resolveProjectBootstrapWorkspaceId,
} from "../src/client/project-bootstrap-session.ts";

test("创建项目冻结当前Workspace并只初始化connectWorkspace返回的精确Session", async () => {
  let current = "session-history" as SessionId;
  const opened: SessionId[] = [];
  const sessions = {
    list: { getSnapshot: () => ({ current }) },
    open: (sessionId: SessionId) => {
      current = sessionId;
      opened.push(sessionId);
    },
  } as unknown as Pick<ISessions, "list" | "open">;
  const requestedWorkspaces: WorkspaceId[] = [];
  let releaseConnect!: (sessionId: SessionId) => void;
  const connected = new Promise<SessionId>((resolve) => {
    releaseConnect = resolve;
  });
  const workspaces = {
    list: {
      getSnapshot: () => ({
        baselinesReady: true,
        recentWorkspaceId: "workspace-recent" as WorkspaceId,
        items: [
          {
            workspaceId: "workspace-target" as WorkspaceId,
            sessionIds: ["session-history" as SessionId],
          },
          {
            workspaceId: "workspace-recent" as WorkspaceId,
            sessionIds: ["session-other" as SessionId],
          },
        ],
      }),
    },
    connectWorkspace: async (workspaceId: WorkspaceId) => {
      requestedWorkspaces.push(workspaceId);
      return connected;
    },
  } as unknown as Pick<IWorkspaces, "list" | "connectWorkspace">;

  const target = resolveProjectBootstrapWorkspaceId(sessions, workspaces);
  assert.equal(target, "workspace-target");
  const initialized: SessionId[] = [];
  const connecting = connectProjectBootstrapSession(
    sessions,
    workspaces,
    target,
    async (sessionId) => {
      initialized.push(sessionId);
    },
  );

  current = "session-other" as SessionId;
  releaseConnect("session-created" as SessionId);
  assert.equal(await connecting, "session-created");
  assert.deepEqual(requestedWorkspaces, ["workspace-target"]);
  assert.deepEqual(initialized, ["session-created"]);
  assert.deepEqual(opened, ["session-created"]);
});
