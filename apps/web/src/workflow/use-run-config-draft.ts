import { useCallback, useEffect, useState } from "react";
import type { SubmitMessagePayload } from "@chat/contracts/public";
import {
  clearWorkflowConfigDraft,
  readWorkflowConfigDraft,
  writeWorkflowConfigDraft,
  type WorkflowSelectionDraft,
} from "./run-config-draft.js";

export function useRunConfigDraft(storage: Storage, sessionId: string) {
  const [draft, setDraftState] = useState<WorkflowSelectionDraft | null>(() =>
    readWorkflowConfigDraft(storage, sessionId),
  );

  // Session定位变化时重读对应草稿，不能把上一个会话的有限选择带到新会话。
  useEffect(() => {
    setDraftState(readWorkflowConfigDraft(storage, sessionId));
  }, [sessionId, storage]);

  const setDraft = useCallback(
    (next: WorkflowSelectionDraft | null) => {
      writeWorkflowConfigDraft(storage, sessionId, next);
      setDraftState(next);
    },
    [sessionId, storage],
  );

  const clearDraft = useCallback(() => {
    clearWorkflowConfigDraft(storage, sessionId);
    setDraftState(null);
  }, [sessionId, storage]);

  /** 当前草稿可直接合入公开Message payload；没有草稿则保留旧兼容发送路径。 */
  const workflowSelection: SubmitMessagePayload["workflowSelection"] | undefined =
    draft ?? undefined;

  return { draft, setDraft, clearDraft, workflowSelection } as const;
}
