/** A detached execution binding, not a second task scheduler or transcript. */
export interface FriendWork {
  readonly id: string;
  readonly longAgentId: string;
  readonly sessionId: string;
  readonly originSessionId: string;
  readonly originEntryId: string | null;
  readonly contextProjectId: string | null;
  readonly requestId: string;
  readonly payloadHash: string;
  readonly title: string;
  readonly createdAt: string;
}

export function parseFriendWork(value: unknown): FriendWork {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("后台工作绑定必须为对象");
  const v = value as Record<string, unknown>;
  const keys = ["id", "longAgentId", "sessionId", "originSessionId", "originEntryId", "contextProjectId", "requestId", "payloadHash", "title", "createdAt"];
  if (Object.keys(v).some(key => !keys.includes(key)) || keys.some(key => !(key in v))) throw new Error("后台工作绑定字段无效");
  for (const key of keys.filter(key => !["originEntryId", "contextProjectId"].includes(key))) {
    if (typeof v[key] !== "string" || !(v[key] as string).trim()) throw new Error(`后台工作字段无效: ${key}`);
  }
  for (const key of ["originEntryId", "contextProjectId"]) {
    if (v[key] !== null && (typeof v[key] !== "string" || !v[key])) throw new Error(`后台工作字段无效: ${key}`);
  }
  if (!/^work-[a-f0-9]{32}$/.test(String(v.id)) || !/^[a-f0-9]{64}$/.test(String(v.payloadHash))
    || !Number.isFinite(Date.parse(String(v.createdAt))) || String(v.title).length > 120) throw new Error("后台工作标识或时间无效");
  return v as unknown as FriendWork;
}
