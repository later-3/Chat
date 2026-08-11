import { submitMessagePayloadSchema, type SubmitMessagePayload } from "@chat/contracts/public";

const WORKFLOW_CONFIG_DRAFT_PREFIX = "chat:workflow-config-draft:v1:";

export type WorkflowSelectionDraft = NonNullable<SubmitMessagePayload["workflowSelection"]>;

export function workflowConfigDraftStorageKey(sessionId: string): string {
  return `${WORKFLOW_CONFIG_DRAFT_PREFIX}${sessionId}`;
}

/**
 * 这里只保存已公开的Definition identity及有限覆盖。借用公开Submit schema恢复草稿，
 * 因而未知字段、任意config、secret形态或损坏值都会被丢弃，绝不成为后续发送载荷。
 */
export function readWorkflowConfigDraft(
  storage: Storage,
  sessionId: string,
): WorkflowSelectionDraft | null {
  try {
    const raw = storage.getItem(workflowConfigDraftStorageKey(sessionId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as Record<string, unknown>).version !== 1
    ) {
      return null;
    }
    const result = submitMessagePayloadSchema.safeParse({
      text: "workflow-draft",
      workflowSelection: (parsed as Record<string, unknown>).workflowSelection,
    });
    return result.success ? (result.data.workflowSelection ?? null) : null;
  } catch {
    return null;
  }
}

export function writeWorkflowConfigDraft(
  storage: Storage,
  sessionId: string,
  workflowSelection: WorkflowSelectionDraft | null,
): void {
  try {
    if (workflowSelection === null) {
      storage.removeItem(workflowConfigDraftStorageKey(sessionId));
      return;
    }
    // 先走同一公开Command边界，再落本地；不信任调用方传入的对象。
    const parsed = submitMessagePayloadSchema.safeParse({
      text: "workflow-draft",
      workflowSelection,
    });
    if (!parsed.success || parsed.data.workflowSelection === undefined) {
      storage.removeItem(workflowConfigDraftStorageKey(sessionId));
      return;
    }
    storage.setItem(
      workflowConfigDraftStorageKey(sessionId),
      JSON.stringify({ version: 1, workflowSelection: parsed.data.workflowSelection }),
    );
  } catch {
    // localStorage不可用时草稿只留在当前页面，不能影响正式命令。
  }
}

export function clearWorkflowConfigDraft(storage: Storage, sessionId: string): void {
  try {
    storage.removeItem(workflowConfigDraftStorageKey(sessionId));
  } catch {
    // 同上。
  }
}
