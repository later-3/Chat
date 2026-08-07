import { createHash } from "node:crypto";

/**
 * Canonical JSON与SHA-256（任务书§8.6）。
 *
 * 用途：Plan、Command Request、Execution Contract和候选证据的审批/幂等Hash。
 *
 * 规则：
 * - 对象键按规范排序；数组保持业务顺序。
 * - 禁止undefined、函数、Symbol、BigInt、非有限数字和循环引用，遇到即抛错，
 *   不静默跳过或降级为插入顺序序列化。
 * - 日期必须在进入Hash前校验为ISO字符串；本函数不接受Date对象。
 * - Hash输入必须携带Schema版本域，防止跨版本误比较。
 * - 禁止直接对未规范化对象使用依赖插入顺序的JSON.stringify()作为审批Hash。
 */
export function canonicalJsonStringify(value: unknown): string {
  return stringify(value, new Set());
}

function stringify(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (value === undefined) {
    throw new CanonicalJsonError("canonical_json_undefined", "canonical JSON不允许undefined");
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError("canonical_json_non_finite", "canonical JSON不允许非有限数字");
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      throw new CanonicalJsonError(
        "canonical_json_unsupported_type",
        `canonical JSON不允许类型${typeof value}`,
      );
    case "object":
      return stringifyObject(value, seen);
    default:
      // typeof的兜底；上面的分支已覆盖全部JavaScript类型
      throw new CanonicalJsonError("canonical_json_unsupported_type", "canonical JSON遇到未知类型");
  }
}

function stringifyObject(value: object, seen: Set<object>): string {
  if (value instanceof Date) {
    throw new CanonicalJsonError(
      "canonical_json_date_object",
      "Date必须先校验为ISO字符串，不得直接进入canonical JSON",
    );
  }
  if (seen.has(value)) {
    throw new CanonicalJsonError("canonical_json_circular", "canonical JSON不允许循环引用");
  }
  if (Array.isArray(value)) {
    seen.add(value);
    const items = value.map((item) => stringify(item, seen));
    seen.delete(value);
    return `[${items.join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  seen.add(value);
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stringify(record[key], seen)}`);
  seen.delete(value);
  return `{${entries.join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 对带Schema版本域的对象计算稳定SHA-256。
 * domain示例："plan-revision.v1"、"command.submit-user-message.v1"、"execution-contract.v1"。
 */
export function hashCanonical(domain: string, value: unknown): string {
  if (!/^[a-z][a-z0-9.-]*\.v\d+$/.test(domain)) {
    throw new CanonicalJsonError("canonical_json_bad_domain", `非法Hash版本域:${domain}`);
  }
  return sha256Hex(`${domain}\n${canonicalJsonStringify(value)}`);
}

export class CanonicalJsonError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CanonicalJsonError";
    this.code = code;
  }
}
