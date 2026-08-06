/**
 * 会话草稿的浏览器本地存储。
 *
 * 边界（见任务书 p1.2 §5.4）：
 * - 草稿是浏览器本地、可丢弃的页面状态，不是 Message，也不是产品事实。
 * - 键名包含产品前缀、Schema 版本和会话 ID：`chat:draft:v1:<sessionId>`。
 * - 值带版本字段并经运行时守卫读取；损坏、未知版本或 Storage 异常一律回退为空草稿。
 */
const DRAFT_KEY_PREFIX = "chat:draft:v1:";
const DRAFT_SCHEMA_VERSION = 1;

export function draftStorageKey(sessionId: string): string {
  return `${DRAFT_KEY_PREFIX}${sessionId}`;
}

export function readDraft(storage: Storage, sessionId: string): string {
  try {
    const raw = storage.getItem(draftStorageKey(sessionId));
    if (raw === null) return "";
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return "";
    const record = parsed as Record<string, unknown>;
    if (record.version !== DRAFT_SCHEMA_VERSION || typeof record.text !== "string") return "";
    return record.text;
  } catch {
    return "";
  }
}

export function writeDraft(storage: Storage, sessionId: string, text: string): void {
  try {
    if (text === "") {
      storage.removeItem(draftStorageKey(sessionId));
      return;
    }
    storage.setItem(
      draftStorageKey(sessionId),
      JSON.stringify({ version: DRAFT_SCHEMA_VERSION, text }),
    );
  } catch {
    // Storage 不可用（隐私模式、配额满）时静默降级：草稿只保留在内存，不影响使用。
  }
}

export function clearDraft(storage: Storage, sessionId: string): void {
  try {
    storage.removeItem(draftStorageKey(sessionId));
  } catch {
    // 同上：清理失败不阻塞界面。
  }
}
