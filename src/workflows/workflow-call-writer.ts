import { access } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { chatSessionOperationKey, withChatSessionOperationLock } from "../session-operation-lock.js";

/** A tool may use its owner's current manager only while its wait window is open. */
export function createWorkflowCallWriter(manager: SessionManager, projectId: string | undefined) {
  const file = manager.getSessionFile(), directory = manager.getSessionDir(), sessionId = manager.getSessionId();
  let attached = true;
  return {
    release() { attached = false; },
    async write<T>(operation: (current: SessionManager) => T): Promise<T> {
      if (attached) return operation(manager);
      if (!file || !projectId) throw new Error("后台Workflow返回缺少持久Session/Project关联；请从原会话查询结果");
      return withChatSessionOperationLock(chatSessionOperationKey(projectId, sessionId), async () => {
        // A removed parent must not be recreated by SessionManager.open().
        await access(file);
        const current = SessionManager.open(file, directory);
        if (current.getSessionId() !== sessionId) throw new Error("后台Workflow父会话身份已变化");
        return operation(current);
      });
    },
  };
}
