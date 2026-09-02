export type SessionLifecycleErrorCode =
  | "SESSION_BUSY"
  | "SESSION_NOT_FOUND"
  | "SESSION_REMOVED"
  | "SESSION_PURGED"
  | "SESSION_STORAGE_CONFLICT";

export class SessionLifecycleError extends Error {
  readonly code: SessionLifecycleErrorCode;

  constructor(code: SessionLifecycleErrorCode, message: string) {
    super(message);
    this.name = "SessionLifecycleError";
    this.code = code;
  }
}
