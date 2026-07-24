const DRAFT_STORAGE_PREFIX = "chat.session-draft.v1";
const MAX_DRAFT_LENGTH = 100_000;

function draftStorageKey(sessionId: string): string {
  return `${DRAFT_STORAGE_PREFIX}:${sessionId}`;
}

/**
 * Product Session drafts are device-local interaction state. They never count
 * as accepted Product Messages until the backend acknowledges a send.
 */
export function readSessionDraft(
  sessionId: string,
  storage: Storage = window.localStorage,
): string {
  try {
    return storage.getItem(draftStorageKey(sessionId)) ?? "";
  } catch {
    return "";
  }
}

export function writeSessionDraft(
  sessionId: string,
  value: string,
  storage: Storage = window.localStorage,
): void {
  try {
    if (!value) {
      storage.removeItem(draftStorageKey(sessionId));
      return;
    }
    storage.setItem(draftStorageKey(sessionId), value.slice(0, MAX_DRAFT_LENGTH));
  } catch {
    // Private browsing and storage quotas can reject writes. The in-memory
    // draft remains usable, so storage failure is deliberately non-fatal.
  }
}
