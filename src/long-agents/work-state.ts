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
  /**
   * Frozen integration target for a 建题 work (root or fork). Persisted so a status read can return the
   * SAME topicId/nodeId/sessionId before, during and after the node exists, instead of re-deriving a
   * root for a fork. Absent on ordinary background work.
   */
  readonly topicIntegration?: { readonly topicId: string; readonly sessionId: string; readonly nodeId: string } | undefined;
}

const REQUIRED_WORK_FIELDS = ["id", "longAgentId", "sessionId", "originSessionId", "originEntryId", "contextProjectId", "requestId", "payloadHash", "title", "createdAt"] as const;
const OPTIONAL_WORK_FIELDS = ["topicIntegration"] as const;

function parseTopicIntegration(value: unknown): FriendWork["topicIntegration"] {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("后台工作主题目标必须为对象");
  const record = value as Record<string, unknown>;
  const keys = ["topicId", "sessionId", "nodeId"];
  if (Object.keys(record).some(key => !keys.includes(key)) || keys.some(key => typeof record[key] !== "string" || !(record[key] as string).trim()))
    throw new Error("后台工作主题目标字段无效");
  return { topicId: record.topicId as string, sessionId: record.sessionId as string, nodeId: record.nodeId as string };
}

export function parseFriendWork(value: unknown): FriendWork {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("后台工作绑定必须为对象");
  const v = value as Record<string, unknown>;
  const allowed: readonly string[] = [...REQUIRED_WORK_FIELDS, ...OPTIONAL_WORK_FIELDS];
  if (Object.keys(v).some(key => !allowed.includes(key)) || REQUIRED_WORK_FIELDS.some(key => !(key in v))) throw new Error("后台工作绑定字段无效");
  for (const key of REQUIRED_WORK_FIELDS.filter(key => key !== "originEntryId" && key !== "contextProjectId")) {
    if (typeof v[key] !== "string" || !(v[key] as string).trim()) throw new Error(`后台工作字段无效: ${key}`);
  }
  for (const key of ["originEntryId", "contextProjectId"]) {
    if (v[key] !== null && (typeof v[key] !== "string" || !v[key])) throw new Error(`后台工作字段无效: ${key}`);
  }
  if (!/^work-[a-f0-9]{32}$/.test(String(v.id)) || !/^[a-f0-9]{64}$/.test(String(v.payloadHash))
    || !Number.isFinite(Date.parse(String(v.createdAt))) || String(v.title).length > 120) throw new Error("后台工作标识或时间无效");
  const topicIntegration = parseTopicIntegration(v.topicIntegration);
  return { ...(v as unknown as FriendWork), ...(topicIntegration === undefined ? {} : { topicIntegration }) };
}
