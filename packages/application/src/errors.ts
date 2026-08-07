import type { ProblemCode, RecoveryAction } from "@chat/contracts";

/**
 * Application层稳定错误。
 *
 * 边界规则：Provider、文件系统或Workflow原始异常不得穿透到浏览器；
 * 它们在各自Adapter内归一化为带稳定code的ApplicationError。
 */
export class ApplicationError extends Error {
  readonly code: ProblemCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly recoveryAction: RecoveryAction;

  constructor(options: {
    code: ProblemCode;
    httpStatus: number;
    message: string;
    retryable?: boolean;
    recoveryAction?: RecoveryAction;
  }) {
    super(options.message);
    this.name = "ApplicationError";
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.retryable = options.retryable ?? false;
    this.recoveryAction = options.recoveryAction ?? "none";
  }
}

export function notFound(message: string): ApplicationError {
  return new ApplicationError({ code: "not_found", httpStatus: 404, message });
}

export function forbidden(message: string): ApplicationError {
  return new ApplicationError({ code: "forbidden", httpStatus: 403, message });
}

export function revisionConflict(message: string): ApplicationError {
  return new ApplicationError({
    code: "revision_conflict",
    httpStatus: 409,
    message,
    recoveryAction: "rehydrate_and_retry",
  });
}

/** 同一commandId携带不同请求Hash；由Product Store Adapter在幂等校验时抛出。 */
export class CommandIdReusedError extends Error {
  readonly code = "command_id_reused" as const;
  constructor(commandId: string) {
    super(`commandId已被不同请求使用:${commandId}`);
    this.name = "CommandIdReusedError";
  }
}

/** 快照损坏/未知Schema/悬空引用/Hash不一致；启动与读取失败关闭时抛出。 */
export class StoreCorruptedError extends Error {
  readonly code = "store_corrupted" as const;
  constructor(message: string) {
    super(message);
    this.name = "StoreCorruptedError";
  }
}
