import { useCallback, useState } from "react";
import { SESSION_FIXTURES, type SessionId } from "../viewmodel/workspace-view-model.js";
import { readDraft, writeDraft } from "./draft-store.js";

/**
 * 按会话隔离的受控草稿状态。
 * 输入变化立即写入本地存储；刷新、切换会话或离线都不依赖 beforeunload。
 */
export function useDrafts(storage: Storage) {
  const [drafts, setDrafts] = useState<Readonly<Record<SessionId, string>>>(
    () =>
      Object.fromEntries(
        SESSION_FIXTURES.map((session) => [session.id, readDraft(storage, session.id)]),
      ) as Record<SessionId, string>,
  );

  const setDraft = useCallback(
    (sessionId: SessionId, text: string) => {
      setDrafts((current) => ({ ...current, [sessionId]: text }));
      writeDraft(storage, sessionId, text);
    },
    [storage],
  );

  return { drafts, setDraft };
}
