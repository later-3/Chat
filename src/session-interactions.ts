/**
 * Interaction recording v2 (pi-004 P1-U3/U4/U5).
 *
 * 存储（<sessionDir>/interactions/<sessionId>/）：
 *   - index.jsonl    请求行（v2；区域摘要，不含全文；单行 ≤4096 字节——超限降级写最小行并报错日志）
 *   - outcomes.jsonl 结果追加（outcome 补写=追加合并读，避免原地改写 JSONL 的撕裂风险）
 *   - requests/<requestId>.json.gz  完整原文（**开关 on 才写**；开关只控制 gz，区域行无条件写——D4）
 *
 * 判定规则（D1/D2/D5）：
 *   - outcome：recorder 订阅 session 事件，message_end(assistant) 按 AgentSession 内序与待决请求 FIFO 配对
 *   - attempt：事件为主（auto_retry_start 置位、记录时消费）+ 同实例同 sha 归并为辅；边界=recorder 实例
 *     （每次 createChatPiAgentSession 新建，天然隔离跨轮同 payload 误归并）
 *   - direct 轮（压缩/摘要等）：stage={id:"direct",nodeKind:"system"}，读模型聚合成“系统调用”组
 *
 * 旧数据：prompt-captures（schema1）只读，adaptLegacyPromptCaptures 提供纯读转换（不写回）。
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { parseProviderPayloadRegions, type PromptCaptureRecord } from "./session-prompt-capture.js";
import { resolveOwnedSessionProject } from "./session-location.js";
import { requireActiveChatSessionFile } from "./session-state.js";
import { chatSessionOwner, readChatSessionOwnerIndex, readWritableFriendSessionIds } from "./session-owner.js";
import { chatSessionOperationKey, withChatSessionOperationLock } from "./session-operation-lock.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export const INTERACTION_SCHEMA_VERSION = 2;
export const INTERACTION_RECORDING_CUSTOM_TYPE = "chat.interaction-recording";
const INDEX_LIMIT_BYTES = 4096;

export interface InteractionStage { readonly id: string; readonly nodeKind: "agent" | "system" | "task" }
export interface InteractionTurn {
  readonly source: "workflow" | "direct";
  readonly workflowId?: string;
  readonly workflowInvocationId?: string;
  readonly stageId?: string;
  readonly turnKey?: string;
  readonly stage: InteractionStage;
}
export interface InteractionRegionRef { readonly id: string; readonly chars: number; readonly revision?: string; /** 人话展示名：读侧从注册表补（F6/F-09） */ readonly label?: string; /** B5：内容前 80 字符预览（识别块用；**无条件记录，不依赖完整记录开关**） */ readonly preview?: string; /** B5：XML 标签名（= registry.id，如 chat_identity；pi-base 无标签不写）——发送前编辑的 blockId 依据 */ readonly tag?: string }
export interface InteractionRequestRow {
  readonly schemaVersion: typeof INTERACTION_SCHEMA_VERSION;
  readonly requestId: string;
  readonly seq: number;
  readonly timestamp: string;
  readonly storageProjectId: string;
  readonly sessionId: string;
  readonly turn: InteractionTurn;
  readonly agent: { readonly agentId: string; readonly agentName?: string; readonly longAgentId?: string };
  readonly longAgentId?: string;
  readonly model: { readonly provider: string; readonly modelId: string; readonly api?: string };
  readonly kind: "agent" | "direct";
  readonly attempt: number;
  readonly retryOf?: string;
  readonly regions: readonly InteractionRegionRef[];
  readonly toolCount: number;
  /** B5：工具名清单（发送前编辑入口用；**无条件记录**）；超限降级时省略 */
  readonly toolNames?: readonly string[];
  readonly messageCount: number;
  /** 上下文排除：被编辑层剔除的块数（B5 实数化） */
  readonly excluded: { readonly count: number };
  readonly payload: { readonly sha256: string; readonly chars: number; readonly file?: string };
  /** 仅旧数据适配视图携带（读取时标记，不落新盘） */
  readonly legacy?: boolean;
  /** 行超限降级标记（regions/counters 省略，原文仍可查） */
  readonly degraded?: boolean;
}
export interface InteractionOutcomeRecord {
  readonly requestId: string;
  readonly timestamp: string;
  readonly outcome: {
    readonly status: "success" | "error" | "aborted";
    readonly stopReason?: string;
    readonly errorMessage?: string;
    readonly usage?: unknown;
    readonly durationMs?: number;
    readonly responseId?: string;
  };
}

// 与旧 recorder 相同的目录内串行写队列（先来后到，失败不阻断后续）。
// U3：记录失败不再静默——后台写盘失败进运行日志并计数（会话执行不受影响）。
const writeQueues = new Map<string, Promise<void>>();
let interactionWriteFailures = 0;
/** 记录写盘失败累计（测试与诊断用；进程内计数）。 */
export function interactionWriteFailureCount(): number {
  return interactionWriteFailures;
}
function enqueueWrite(directory: string, write: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(directory) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(write);
  writeQueues.set(directory, next);
  void next.catch((error: unknown) => {
    interactionWriteFailures += 1;
    console.error(`[interactions] 写盘失败（不阻断会话）第 ${interactionWriteFailures} 次 dir=${directory}: ${error instanceof Error ? error.message : String(error)}`);
  });
  return next;
}

export interface InteractionRecorderInput {
  readonly sessionDir: string;
  readonly storageProjectId: string;
  readonly sessionId: string;
  readonly turn: InteractionTurn;
  readonly agent: { readonly agentId: string; readonly agentName?: string; readonly longAgentId?: string };
  /** 完整记录开关：只控制 gz 原文（D4）；区域行无条件写 */
  readonly enabled: boolean;
}

export interface InteractionRecorder {
  readonly turn: InteractionTurn;
  pushNeutralContext: (messages: readonly AgentMessage[]) => void;
  record: (payload: unknown, model: { provider: string; modelId: string; api?: string }, excludedCount?: number) => Promise<void>;
  handleSessionEvent: (event: { readonly type: string; readonly [key: string]: unknown }) => void;
}

interface SessionEventLike {
  readonly type: string;
  readonly attempt?: number;
  readonly message?: {
    readonly role?: string;
    readonly stopReason?: string;
    readonly errorMessage?: string;
    readonly usage?: unknown;
    readonly responseId?: string;
    readonly timestamp?: number;
  };
}

function statusFromStopReason(stopReason: string | undefined, errorMessage: string | undefined): "success" | "error" | "aborted" {
  if (stopReason === "error" || errorMessage !== undefined && errorMessage !== "") return "error";
  if (stopReason === "cancelled" || stopReason === "aborted") return "aborted";
  return "success";
}

export function interactionDirectory(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "interactions", sessionId);
}

export function createInteractionRecorder(input: InteractionRecorderInput): InteractionRecorder {
  const directory = interactionDirectory(input.sessionDir, input.sessionId);
  const neutralQueue: (readonly AgentMessage[] | undefined)[] = [];
  const pending: { requestId: string; tsMs: number }[] = [];
  let seq = 0;
  let lastSha: string | undefined;
  let lastAttempt = 1;
  let awaitingRetry = false;

  return {
    turn: input.turn,
    pushNeutralContext(messages) { neutralQueue.push(messages); },
    async record(payload, model, excludedCount) {
      seq += 1;
      const neutral = neutralQueue.shift();
      const requestId = randomUUID();
      const timestamp = new Date();
      const sha256 = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      // D2：事件为主（auto_retry_start 置位即消费）、同实例同 sha 归并为辅；实例边界天然隔离跨轮。
      const attempt = awaitingRetry || (lastSha === sha256) ? lastAttempt + 1 : 1;
      awaitingRetry = false;
      lastSha = sha256;
      lastAttempt = attempt;
      const parsed = parseProviderPayloadRegions(payload, model.api, neutral);
      const regions: InteractionRegionRef[] = (parsed.systemPrompt?.sections ?? []).map((section) => {
        const revision = /revision="([^"]+)"/.exec(section.text)?.[1];
        const preview = section.text.trim().slice(0, 80);
        // B5：带出 XML 标签名（编辑层 blockId 用）；第一个实测区域的 kind 与 id 对应同一 registry 条目。
        const tag = PROMPT_REGION_REGISTRY.find((region) => region.kind === section.kind || region.id === section.kind)?.tag;
        return { id: section.kind, chars: section.text.length, ...(revision === undefined ? {} : { revision }),
          ...(tag === undefined || tag === "" ? {} : { tag }),
          ...(preview === "" ? {} : { preview }) };
      });
      const payloadRecord = payload as { messages?: unknown[]; tools?: unknown[] };
      const toolNames: string[] = [];
      if (Array.isArray(payloadRecord.tools)) {
        for (const tool of payloadRecord.tools) {
          if (tool === null || typeof tool !== "object") continue;
          const record = tool as { name?: unknown; function?: { name?: unknown } };
          if (typeof record.name === "string") { toolNames.push(record.name); continue; }
          const nested = record.function;
          if (nested !== null && typeof nested === "object" && typeof nested.name === "string") toolNames.push(nested.name);
        }
      }
      const turn = input.turn;
      const row: InteractionRequestRow = {
        schemaVersion: INTERACTION_SCHEMA_VERSION,
        requestId, seq, timestamp: timestamp.toISOString(),
        storageProjectId: input.storageProjectId, sessionId: input.sessionId,
        turn,
        agent: {
          agentId: input.agent.agentId,
          ...(input.agent.agentName === undefined ? {} : { agentName: input.agent.agentName }),
          ...(input.agent.longAgentId === undefined ? {} : { longAgentId: input.agent.longAgentId }),
        },
        ...(input.agent.longAgentId === undefined ? {} : { longAgentId: input.agent.longAgentId }),
        model: { provider: model.provider, modelId: model.modelId, ...(model.api === undefined ? {} : { api: model.api }) },
        kind: turn.source === "direct" ? "direct" : "agent",
        attempt,
        ...(() => { const prev = attempt > 1 ? pending[pending.length - 1]?.requestId : undefined; return prev === undefined ? {} : { retryOf: prev }; })(),
        regions,
        toolCount: Array.isArray(payloadRecord.tools) ? payloadRecord.tools.length : 0,
        ...(toolNames.length === 0 ? {} : { toolNames }),
        messageCount: Array.isArray(payloadRecord.messages) ? payloadRecord.messages.length : 0,
        excluded: { count: excludedCount ?? 0 }, // B5：装配时实数化（gate 应用编辑层后传入）
        payload: { sha256, chars: JSON.stringify(payload).length, ...(input.enabled ? { file: `${requestId}.json.gz` } : {}) },
      };
      let line = `${JSON.stringify(row)}\n`;
      if (Buffer.byteLength(line, "utf8") > INDEX_LIMIT_BYTES) {
        // D4/上限保护：超限时退化为最小行（保留定位与计数），并保留原文可查。
        console.error(`[interactions] 请求行超限 ${Buffer.byteLength(line, "utf8")}B，降级写入 sessionId=${input.sessionId} seq=${seq}`);
        line = `${JSON.stringify({ ...row, regions: [], toolCount: 0, messageCount: 0, degraded: true } satisfies InteractionRequestRow)}\n`;
      }
      await enqueueWrite(directory, async () => {
        await mkdir(directory, { recursive: true });
        const gz = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
        if (input.enabled) {
          await mkdir(join(directory, "requests"), { recursive: true });
          await appendFile(join(directory, "requests", `${requestId}.json.gz`), gz);
        }
        // B5：**无条件**保存最近一次的完整请求体（覆盖式）——发送前编辑入口要展开区块看条目与内容，
        // 必须有全文；“完整记录”开关仍然只控制逐请求归档（requests/<id>.json.gz）。
        await writeFile(join(directory, "latest-payload.json.gz"), gz);
        await appendFile(join(directory, "index.jsonl"), line, "utf8");
      }).catch(() => undefined); // 失败已由 enqueueWrite 记日志+计数；不抛给调用方，不阻断会话
      pending.push({ requestId, tsMs: timestamp.getTime() });
    },
    handleSessionEvent(event) {
      const typed = event as SessionEventLike;
      if (typed.type === "auto_retry_start") { awaitingRetry = true; return; }
      if (typed.type === "auto_retry_end") { awaitingRetry = false; return; }
      if (typed.type !== "message_end" || typed.message?.role !== "assistant") return;
      const request = pending.shift();
      if (request === undefined) return; // 无待决请求的结果（如压缩自触发）不归属
      const message = typed.message;
      const record: InteractionOutcomeRecord = {
        requestId: request.requestId,
        timestamp: new Date().toISOString(),
        outcome: {
          status: statusFromStopReason(message.stopReason, message.errorMessage),
          ...(message.stopReason === undefined ? {} : { stopReason: message.stopReason }),
          ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
          ...(message.usage === undefined ? {} : { usage: message.usage }),
          ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
          ...(message.timestamp === undefined ? {} : { durationMs: Math.max(0, message.timestamp - request.tsMs) }),
        },
      };
      void enqueueWrite(directory, () => appendFile(join(directory, "outcomes.jsonl"), `${JSON.stringify(record)}\n`, "utf8"));
    },
  };
}

// ---------------------------------------------------------------------------
// 读模型（U5）
// ---------------------------------------------------------------------------

async function readJsonl<T>(path: string): Promise<T[]> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const rows: T[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try { rows.push(JSON.parse(line) as T); } catch { /* 撕裂尾行跳过，不隐藏既有记录 */ }
  }
  return rows;
}

export interface InteractionPage {
  readonly rows: readonly (InteractionRequestRow & { readonly outcome?: InteractionOutcomeRecord["outcome"] })[];
  readonly nextCursor?: number;
}

export async function readInteractionPage(sessionDir: string, sessionId: string, options: { cursor?: number; limit?: number } = {}): Promise<InteractionPage> {
  const directory = interactionDirectory(sessionDir, sessionId);
  const all = await readJsonl<InteractionRequestRow>(join(directory, "index.jsonl"));
  const outcomes = await readJsonl<InteractionOutcomeRecord>(join(directory, "outcomes.jsonl"));
  const outcomeByRequest = new Map(outcomes.map((record) => [record.requestId, record.outcome]));
  const cursor = options.cursor ?? 0;
  const limit = options.limit ?? 200;
  const window = all.filter((row) => row.seq > cursor).slice(0, limit);
  const rows = window.map((row) => {
    const outcome = outcomeByRequest.get(row.requestId);
    // B5：读侧补齐 label 与 tag（tag 供发送前编辑入口的 blockId；旧记录（B2 时期）无 tag 且无 preview）。
    const withLabel = { ...row, regions: enrichRegionMetadata(row.regions) };
    return outcome === undefined ? withLabel : { ...withLabel, outcome };
  });
  const last = rows.at(-1);
  return { rows, ...(last === undefined || rows.length < limit ? {} : { nextCursor: last.seq }) };
}

export interface InteractionRequestGroup {
  /** 锚行（链首）requestId */
  readonly requestId: string;
  readonly attemptIds: readonly string[];
  readonly attempts: number;
  /** 有 outcome 且非 success 的尝试数（outcome 缺失不计入，也不算成功） */
  readonly failures: number;
  readonly regions: readonly { readonly id: string; readonly chars: number }[];
  readonly messageCount: number;
  readonly toolCount: number;
  readonly lastOutcome?: InteractionOutcomeRecord["outcome"];
}

export interface InteractionTurnSummary {
  /** 去重后的请求数（retryOf 链聚合）——与 attempts 分开（E1 修复） */
  readonly requestCount: number;
  readonly attempts: number;
  readonly failures: number;
  readonly tokenOut: number;
  /** 该轮请求 prompt 字符合计（回复 bar 用，聚合在后端） */
  readonly promptChars: number;
  /** 该轮模型（首行） */
  readonly model: string;
  /** 轮内是否存在任何 outcome——false（且 legacy）时 UI 显示"未记录"而非 0（E2/E3/E4） */
  readonly hasOutcome: boolean;
}

type OutcomeRow = InteractionRequestRow & { readonly outcome?: InteractionOutcomeRecord["outcome"] };

function isFailedOutcome(outcome: InteractionOutcomeRecord["outcome"] | undefined): boolean {
  return outcome !== undefined && outcome.status !== "success";
}
function usageTokens(usage: unknown): number {
  if (typeof usage !== "object" || usage === null) return 0;
  const total = (usage as { totalTokens?: unknown }).totalTokens;
  return typeof total === "number" ? total : 0;
}

/**
 * 轮内请求级聚合（D-1，02 T9：聚合在后端）。按 retryOf 链把多次尝试归为一个请求组；
 * legacy 适配行同样携带 retryOf/attempt，走同一逻辑。只在读侧做，不改行存储。
 */
export interface InteractionStageSummary {
  readonly id: string;
  readonly nodeKind: string;
  readonly requestCount: number;
  readonly attempts: number;
  readonly failures: number;
}

export function aggregateInteractionRows(rows: readonly OutcomeRow[]): {
  readonly requests: readonly InteractionRequestGroup[];
  readonly summary: InteractionTurnSummary;
  readonly stages: readonly InteractionStageSummary[];
} {
  const chains: { anchor: string; members: OutcomeRow[] }[] = [];
  const chainByMember = new Map<string, number>();
  for (const row of rows) {
    const target = row.retryOf === undefined ? undefined : chainByMember.get(row.retryOf);
    if (target === undefined) {
      chains.push({ anchor: row.requestId, members: [row] });
      chainByMember.set(row.requestId, chains.length - 1);
    } else {
      chains[target]!.members.push(row);
      chainByMember.set(row.requestId, target);
    }
  }
  let failures = 0;
  let tokenOut = 0;
  let attempts = 0;
  for (const row of rows) {
    if (isFailedOutcome(row.outcome)) failures += 1;
    tokenOut += usageTokens(row.outcome?.usage);
  }
  const stageMap = new Map<string, InteractionStageSummary>();
  let promptChars = 0;
  let model = "";
  let hasOutcome = false;
  for (const row of rows) {
    promptChars += row.payload.chars;
    if (!model) model = `${row.model.provider}/${row.model.modelId}`;
    if (row.outcome !== undefined) hasOutcome = true;
  }
  const requests = chains.map((chain) => {
    attempts += chain.members.length;
    const last = chain.members.at(-1)!;
    const group: InteractionRequestGroup = {
      requestId: chain.anchor,
      attemptIds: chain.members.map((member) => member.requestId),
      attempts: chain.members.length,
      failures: chain.members.filter((member) => isFailedOutcome(member.outcome)).length,
      regions: chain.anchor === last.requestId ? last.regions : rows.find((row) => row.requestId === chain.anchor)?.regions ?? last.regions,
      messageCount: last.messageCount,
      toolCount: last.toolCount,
      ...(last.outcome === undefined ? {} : { lastOutcome: last.outcome }),
    };
    const stage = last.turn.stage;
    const stageKey = `${stage.id}::${stage.nodeKind}`;
    const stageSummary = stageMap.get(stageKey) ?? { id: stage.id, nodeKind: stage.nodeKind, requestCount: 0, attempts: 0, failures: 0 };
    stageMap.set(stageKey, {
      ...stageSummary,
      requestCount: stageSummary.requestCount + 1,
      attempts: stageSummary.attempts + chain.members.length,
      failures: stageSummary.failures + chain.members.filter((member) => isFailedOutcome(member.outcome)).length,
    });
    return group;
  });
  return { requests, summary: { requestCount: requests.length, attempts, failures, tokenOut, promptChars, model, hasOutcome }, stages: [...stageMap.values()] };
}

export interface InteractionTurnGroupPage extends InteractionPage {
  readonly summary: InteractionTurnSummary;
  readonly requests: readonly InteractionRequestGroup[];
  readonly stages: readonly InteractionStageSummary[];
}

function regionLabelOf(id: string): string {
  // 行内 id 是 section.kind（虚线，如 chat-identity）；注册表按 id 或 kind 命中（F6：人话名）。
  return PROMPT_REGION_REGISTRY.find((region) => region.id === id || region.kind === id)?.label ?? id;
}

/**
 * B5：读侧补齐区域元数据——label（人话名，F6 既有语义）+ tag（XML 标签名，发送前编辑的 blockId 依据）。
 * 旧记录（B2 时期）只有 id/chars：必须靠 registry 反查补齐，否则老会话在发送前面板里没有勾选框。
 */
export function enrichRegionMetadata(regions: readonly InteractionRegionRef[]): readonly InteractionRegionRef[] {
  return regions.map((region) => {
    const def = PROMPT_REGION_REGISTRY.find((candidate) => candidate.id === region.id || candidate.kind === region.id);
    return { ...region, label: regionLabelOf(region.id),
      ...(region.tag === undefined && def !== undefined && def.tag !== "" ? { tag: def.tag } : {}) };
  });
}

/** 轮分组键（F2）：与旧前端 groupPromptCaptures 同源——workflowInvocationId ?? turnKey ?? 系统调用。 */
export function interactionTurnKeyOf(row: Pick<InteractionRequestRow, "turn">): string {
  return row.turn.workflowInvocationId ?? row.turn.turnKey ?? "系统调用";
}

export async function readInteractionTurnGroup(sessionDir: string, sessionId: string, groupKey: string): Promise<InteractionTurnGroupPage> {
  const page = await readInteractionPage(sessionDir, sessionId, { limit: 10_000 });
  const rows = page.rows.filter((row) => interactionTurnKeyOf(row) === groupKey);
  const aggregated = aggregateInteractionRows(rows);
  return { rows, summary: aggregated.summary, requests: aggregated.requests, stages: aggregated.stages };
}

/** D2：payload=1 附带的消息区域标注（index→region；text/chars 不给——原文已在 payload messages 里）。 */
export interface InteractionMessageRegionMark {
  readonly index: number;
  readonly role: string;
  readonly region: string;
  readonly customType?: string;
  readonly timestamp?: number;
}

export async function readInteractionRequest(sessionDir: string, sessionId: string, requestId: string, withPayload: boolean): Promise<{
  readonly row: (InteractionRequestRow & { readonly outcome?: InteractionOutcomeRecord["outcome"] }) | undefined;
  readonly payload?: string;
  readonly messageRegions?: readonly InteractionMessageRegionMark[];
  readonly payloadPresent: boolean;
}> {
  const page = await readInteractionPage(sessionDir, sessionId, { limit: 10_000 });
  const row = page.rows.find((candidate) => candidate.requestId === requestId);
  if (row === undefined) return { row: undefined, payloadPresent: false };
  if (!withPayload || row.payload.file === undefined) return { row, payloadPresent: false };
  try {
    const gz = await readFile(join(interactionDirectory(sessionDir, sessionId), "requests", row.payload.file));
    const payloadText = gunzipSync(gz).toString("utf8");
    // D2：复用写侧同一解析（classifyRegions 无 neutral 也能按角色与末条 user 定位本轮输入），
    // 输出索引语义与 v1 capture、FE 现有对齐逻辑一致；裁掉 text/chars 避免与 payload 重复。
    const parsed = parseProviderPayloadRegions(safeJsonParse(payloadText), row.model.api, undefined);
    const messageRegions = parsed.messages?.map((message) => ({
      index: message.index,
      role: message.role,
      region: message.region,
      ...(message.customType === undefined ? {} : { customType: message.customType }),
      ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
    }));
    return {
      row,
      payload: payloadText,
      ...(messageRegions === undefined ? {} : { messageRegions }),
      payloadPresent: true,
    };
  } catch (error) {
    console.error("[interactions] 详情读取失败", requestId, error);
    return { row, payloadPresent: false };
  }
}

function safeJsonParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// 旧 prompt-captures（schema1）纯读适配（不写回——设计偏差 3）
// ---------------------------------------------------------------------------

export async function hasInteractions(sessionDir: string, sessionId: string): Promise<boolean> {
  try { await readFile(join(interactionDirectory(sessionDir, sessionId), "index.jsonl")); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export function adaptLegacyPromptCaptures(records: readonly PromptCaptureRecord[]): {
  readonly rows: readonly (InteractionRequestRow & { readonly legacy: true })[];
  readonly groupKeys: readonly string[];
} {
  const rows: (InteractionRequestRow & { readonly legacy: true })[] = [];
  const lastShaByKey = new Map<string, { sha: string; attempt: number; requestId: string }>();
  let groupSeq = 0;
  for (const record of records) {
    const key = record.turn.turnKey ?? "系统调用";
    const state = lastShaByKey.get(key);
    const attempt = state !== undefined && state.sha === record.payloadSha256 ? state.attempt + 1 : 1;
    lastShaByKey.set(key, { sha: record.payloadSha256, attempt, requestId: record.requestId });
    groupSeq += 1;
    const direct = record.turn.stageId === undefined;
    rows.push({
      schemaVersion: INTERACTION_SCHEMA_VERSION,
      requestId: record.requestId,
      seq: groupSeq,
      timestamp: record.timestamp,
      storageProjectId: record.storageProjectId,
      sessionId: record.sessionId,
      turn: {
        source: record.turn.source,
        ...(record.turn.workflowId === undefined ? {} : { workflowId: record.turn.workflowId }),
        ...(record.turn.workflowInvocationId === undefined ? {} : { workflowInvocationId: record.turn.workflowInvocationId }),
        ...(record.turn.stageId === undefined ? {} : { stageId: record.turn.stageId }),
        ...(record.turn.turnKey === undefined ? {} : { turnKey: record.turn.turnKey }),
        stage: direct ? { id: "direct", nodeKind: "system" } : { id: record.turn.stageId ?? "execute", nodeKind: "agent" },
      },
      agent: record.agent,
      ...(record.agent.longAgentId === undefined ? {} : { longAgentId: record.agent.longAgentId }),
      model: { provider: record.model.provider, modelId: record.model.modelId, ...(record.model.api === undefined ? {} : { api: record.model.api }) },
      kind: record.kind,
      attempt,
      ...(() => { const prev = attempt > 1 ? rows.at(-1) : undefined; return prev === undefined ? {} : { retryOf: prev.requestId }; })(),
      regions: (record.regions.systemPrompt?.sections ?? []).map((section) => ({
        id: section.kind, chars: section.text.length, label: section.label || regionLabelOf(section.kind),
      })),
      toolCount: record.regions.tools?.length ?? 0,
      messageCount: record.regions.messages?.length ?? 0,
      excluded: { count: 0 },
      payload: { sha256: record.payloadSha256, chars: record.payloadChars },
      legacy: true,
    });
  }
  return { rows, groupKeys: [...new Set(rows.map((row) => row.turn.turnKey ?? "系统调用"))] };
}

// ---------------------------------------------------------------------------
// 开关（U4）
// ---------------------------------------------------------------------------

export interface RecordingResolution { readonly promptCapture: "on" | undefined }

/**
 * 开关解析（过渡链，设计 §2 U4）：请求体显式值（on/off，body 最高优先） > 会话条目 > Long Agent 默认（DP-3 缺省关）。
 * 返回值沿用 AcceptedTurn 的既有形态：仅 "on" 落盘（off = 省略字段）。
 */
export function resolvePromptCapture(input: {
  readonly body?: "on" | "off" | undefined;
  readonly entries: readonly { readonly type: string; readonly customType?: unknown; readonly data?: unknown }[];
  readonly agentDefault?: "on" | "off" | undefined;
}): RecordingResolution {
  if (input.body !== undefined) return { promptCapture: input.body === "on" ? "on" : undefined };
  for (let i = input.entries.length - 1; i >= 0; i -= 1) {
    const entry = input.entries[i];
    if (entry === undefined) continue;
    if (entry.type === "custom" && entry.customType === INTERACTION_RECORDING_CUSTOM_TYPE) {
      const data = entry.data as { enabled?: unknown };
      return { promptCapture: data.enabled === true ? "on" : undefined };
    }
  }
  return { promptCapture: input.agentDefault === "on" ? "on" : undefined };
}

export async function readSessionRecording(sessionDir: string, sessionId: string): Promise<{ readonly enabled: boolean; readonly revision: number }> {
  const directory = interactionDirectory(sessionDir, sessionId);
  const entries = await readJsonl<{ enabled?: unknown }>(join(directory, "index.jsonl"));
  void entries;
  throw new Error("使用 readSessionRecordingEntries（会话条目路径）");
}

/** 从已打开会话的 entries 读开关（受理链使用，entries 由调用方提供）。 */
export function readRecordingFromEntries(entries: readonly { readonly type: string; readonly customType?: unknown; readonly data?: unknown }[]): { readonly enabled: boolean; readonly revision: number } | undefined {
  let revision = 0;
  let result: { readonly enabled: boolean; readonly revision: number } | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === INTERACTION_RECORDING_CUSTOM_TYPE) {
      revision += 1;
      const data = entry.data as { enabled?: unknown };
      result = { enabled: data.enabled === true, revision };
    }
  }
  return result;
}

/**
 * PUT /api/sessions/:id/interaction-recording（U4）。
 * 约定：revision = 会话内该类型条目数（读写同源、单调）；expectedRevision 不符 → 冲突错误（路由映射 409）。
 * 与 rename 同锁；**不 assert idle**——开关从下一轮生效是产品语义（02 §2.1），允许活动会话切换。
 */
export async function setSessionInteractionRecording(input: {
  readonly projectId: string;
  readonly sessionId: string;
  readonly enabled: boolean;
  readonly expectedRevision: number;
  readonly chatHome?: string;
}): Promise<{ readonly enabled: boolean; readonly revision: number }> {
  await resolveOwnedSessionProject(input.projectId, input.sessionId, input.chatHome);
  return await withChatSessionOperationLock(chatSessionOperationKey(input.projectId, input.sessionId), async () => {
    const project = await resolveOwnedSessionProject(input.projectId, input.sessionId, input.chatHome);
    const info = await requireActiveChatSessionFile(project, input.sessionId);
    const manager = SessionManager.open(info.path, project.sessionDir);
    const current = readRecordingFromEntries(manager.getEntries()) ?? { enabled: false, revision: 0 };
    if (current.revision !== input.expectedRevision) {
      throw new RecordingConflictError(`开关已被修改（当前 revision ${current.revision}），请重新读取`);
    }
    manager.appendCustomEntry(INTERACTION_RECORDING_CUSTOM_TYPE, { schemaVersion: 1, enabled: input.enabled, revision: current.revision + 1 });
    manager.flush();
    return { enabled: input.enabled, revision: current.revision + 1 };
  });
}

export class RecordingConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string) { super(message); this.name = "RecordingConflictError"; }
}


// ---------------------------------------------------------------------------
// 旧 prompt-captures API 的兼容视图（v2 数据按 v1 形状返回——不双写，读侧适配）
// ---------------------------------------------------------------------------

import { PROMPT_REGION_REGISTRY } from "./long-agents/prompt-region-registry.js";

function sectionLabel(kind: string): string {
  return PROMPT_REGION_REGISTRY.find((region) => region.id === kind || region.kind === kind)?.label ?? kind;
}

/** 兼容视图的 v1 section.kind：虚线 legacy kind（chat-identity…）；无 kind 的区域回退 id（pi-base）。 */
function sectionLegacyKind(regionId: string): string {
  return PROMPT_REGION_REGISTRY.find((region) => region.id === regionId)?.kind ?? regionId;
}

export function toLegacyListResponse(
  rows: readonly (InteractionRequestRow & { readonly outcome?: unknown })[],
  sessionId: string,
): { readonly schemaVersion: 1; readonly sessionId: string; readonly count: number; readonly records: unknown[] } {
  const records = rows.map((row) => {
    const systemPromptChars = row.regions.reduce((total, region) => total + region.chars, 0);
    return {
      requestId: row.requestId,
      seq: row.seq,
      timestamp: row.timestamp,
      // v1 record 兼容字段（测试与旧消费方读 record.sessionId/storageProjectId/payloadSha256/file）
      sessionId: row.sessionId,
      storageProjectId: row.storageProjectId,
      payloadSha256: row.payload.sha256,
      ...(row.payload.file === undefined ? {} : { file: row.payload.file }),
      kind: row.kind,
      turn: row.turn,
      agent: row.agent,
      model: row.model,
      payloadChars: row.payload.chars,
      regions: {
        parsed: true,
        systemPromptChars,
        systemSections: row.regions.map((region) => ({ kind: sectionLegacyKind(region.id), label: sectionLabel(region.id), chars: region.chars })),
        messageCount: row.messageCount,
        regionCounts: {} as Record<string, number>,
        toolCount: row.toolCount,
      },
    };
  });
  return { schemaVersion: 1, sessionId, count: records.length, records };
}

export function toLegacyDetail(row: InteractionRequestRow, payload: unknown): { readonly schemaVersion: 1; readonly record: unknown; readonly payload: unknown } {
  const systemPromptChars = row.regions.reduce((total, region) => total + region.chars, 0);
  const record = {
    requestId: row.requestId,
    seq: row.seq,
    timestamp: row.timestamp,
    sessionId: row.sessionId,
    storageProjectId: row.storageProjectId,
    payloadSha256: row.payload.sha256,
    ...(row.payload.file === undefined ? {} : { file: row.payload.file }),
    kind: row.kind,
    turn: row.turn,
    agent: row.agent,
    model: row.model,
    payloadChars: row.payload.chars,
    regions: {
      parsed: true,
      systemPromptChars,
      systemSections: row.regions.map((region) => ({ kind: sectionLegacyKind(region.id), label: sectionLabel(region.id), chars: region.chars })),
      messageCount: row.messageCount,
      regionCounts: {} as Record<string, number>,
      toolCount: row.toolCount,
    },
  };
  return { schemaVersion: 1, record, payload };
}


/** 会话 purge 时同步删除 interactions 目录（与 purgePromptCaptures 成对，红线：随会话生命周期）。 */
export async function purgeInteractions(sessionDir: string, sessionId: string): Promise<void> {
  await rm(interactionDirectory(sessionDir, sessionId), { recursive: true, force: true });
}


/** 按会话文件读当前开关（读路径；不加锁——纯读 entries）。 */
export async function readRecordingBySessionFile(sessionFile: string): Promise<{ readonly enabled: boolean; readonly revision: number }> {
  const manager = SessionManager.open(sessionFile, dirname(sessionFile));
  return readRecordingFromEntries(manager.getEntries()) ?? { enabled: false, revision: 0 };
}

// ---------------------------------------------------------------------------
// B5：发送前的上下文预览（最近一次请求的完整请求体）
// ---------------------------------------------------------------------------

const LATEST_PAYLOAD_FILE = "latest-payload.json.gz";

/**
 * 读"最近一次发送的完整请求体"——发送前编辑入口用它展开区块看条目与内容。
 * 原文由记录器**无条件**写入（不看"完整记录"开关）；原文与索引行同批写入，故取最后一行为其行记录。
 */
export async function readLatestContextPreview(sessionDir: string, sessionId: string): Promise<{
  readonly row: (InteractionRequestRow & { readonly outcome?: InteractionOutcomeRecord["outcome"] }) | undefined;
  readonly payload?: string;
  readonly messageRegions?: readonly InteractionMessageRegionMark[];
  readonly payloadPresent: boolean;
}> {
  let payloadText: string;
  try {
    payloadText = gunzipSync(await readFile(join(interactionDirectory(sessionDir, sessionId), LATEST_PAYLOAD_FILE))).toString("utf8");
  } catch {
    return { row: undefined, payloadPresent: false };
  }
  const page = await readInteractionPage(sessionDir, sessionId, { limit: 10_000 });
  const rows = [...page.rows].sort((a, b) => a.seq - b.seq);
  const row = rows.at(-1);
  const parsed = parseProviderPayloadRegions(safeJsonParse(payloadText), row?.model.api, undefined);
  const messageRegions = parsed.messages?.map((message) => ({
    index: message.index,
    role: message.role,
    region: message.region,
    ...(message.customType === undefined ? {} : { customType: message.customType }),
    ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
  }));
  return {
    row,
    payload: payloadText,
    ...(messageRegions === undefined ? {} : { messageRegions }),
    payloadPresent: true,
  };
}
