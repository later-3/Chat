import { resolveChatHome } from "../chat-home.js";
import { friendExecution } from "./turn-feedback.js";
import { readLongAgentRegistry, readLongAgentState } from "./storage.js";
import { ensureAgentCalendar } from "./project-agent.js";
import { agentDate } from "./calendar.js";
import { isTopicRequestId, readTopicGraph, topicIdOf, topicNodeIdOf, topicNodeSessionIdOf } from "./topics.js";
import { startFriendWork } from "./work.js";

/**
 * Owner/agent "说一句建题" entry: resolve the Friend's daily source, start the background INTEGRATION
 * work, and expose the deterministic node that work will create (root, or a child at a settled anchor).
 *
 * The integration itself is a normal (background) Long Agent turn: it reads the source through
 * `topic_manage` and submits the integrated product with `create_topic`/`create_node`. This service only
 * owns the request identity, the source resolution and the background-work launch — it does NOT integrate
 * and does NOT create the node itself, so there is no second execution path.
 *
 * The node ids are pure functions of the request id (and, for a fork, of the parent's topic), the same
 * derivation `createTopicNode` uses, so a caller can resolve the entryable node before the work finishes.
 */
export interface TopicIntegrationIds {
  readonly topicId: string;
  readonly sessionId: string;
  readonly nodeId: string;
}

/** A fork source: the parent topic node plus the settled anchor the child branches from. */
export interface TopicIntegrationParent {
  readonly nodeId: string;
  readonly anchorEntryId: string;
  readonly anchorSequence: number;
}

/** The identity of the background work that performs one integration request. */
export function topicIntegrationWorkRequestId(requestId: string): string {
  return `topic-integration:${requestId.trim()}`;
}

/** Root ids derive the topic from (owner, requestId); a fork reuses the parent's topic. */
export function topicIntegrationIds(longAgentId: string, requestId: string, topicId = topicIdOf(longAgentId, requestId)): TopicIntegrationIds {
  const sessionId = topicNodeSessionIdOf(topicId, requestId);
  return { topicId, sessionId, nodeId: topicNodeIdOf(topicId, sessionId) };
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new Error(`${label}无效`);
  return value.trim();
}

function normalizeParents(value: unknown): TopicIntegrationParent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) throw new Error("parents 无效");
  return value.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) throw new Error("parents 无效");
    const record = candidate as Record<string, unknown>;
    const anchorSequence = Number(record.anchorSequence);
    if (!Number.isSafeInteger(anchorSequence) || anchorSequence < 1) throw new Error("parents.anchorSequence 无效");
    return { nodeId: text(record.nodeId, "parents.nodeId", 200), anchorEntryId: text(record.anchorEntryId, "parents.anchorEntryId", 200), anchorSequence };
  });
}

/**
 * Resolves the daily origin session server-side. A caller may name a source only to pick among THIS
 * Friend's own daily sessions (never an arbitrary session): `startFriendWork` enforces the same rule
 * again, so a forged source cannot be used as an integration origin.
 */
export async function resolveDailySource(home: string, longAgentId: string, sourceSessionId?: unknown): Promise<string> {
  const agent = (await readLongAgentRegistry(home)).agents.find((candidate) => candidate.id === longAgentId && candidate.enabled && candidate.status !== "archived");
  if (agent === undefined) throw new Error("Friend已停用或不存在");
  const state = await readLongAgentState(home);
  if (sourceSessionId !== undefined) {
    const requested = text(sourceSessionId, "sourceSessionId", 200);
    const day = state.dailySessions.find((candidate) => candidate.longAgentId === longAgentId && candidate.sessionId === requested);
    if (day === undefined) throw new Error("来源会话不是该Friend的日常会话，不能作为整合来源");
    return day.sessionId;
  }
  const calendar = await ensureAgentCalendar(agent, home);
  const day = state.dailySessions.find((candidate) => candidate.longAgentId === longAgentId && candidate.date === agentDate(calendar.timeZone));
  if (day === undefined) throw new Error("今天还没有日常会话，无法建题");
  return day.sessionId;
}

function buildIntegrationInstruction(input: {
  readonly title: string;
  readonly purpose: string;
  readonly requestId: string;
  readonly ids: TopicIntegrationIds;
  readonly readSourceSessionId: string;
  readonly parents: readonly TopicIntegrationParent[];
}): string {
  const lines = [
    "这是一次「整合建题」后台工作：在独立会话里完成，不要干扰来源会话。",
    `目标节点标题：${input.title}`,
    `目的：${input.purpose}`,
  ];
  if (input.parents.length === 0) {
    lines.push(`来源日常会话（只读）：${input.readSourceSessionId}`);
    lines.push("请只使用 topic_manage 工具，按顺序执行：");
    lines.push(`1. read_fulltext：sourceSessionId=${input.readSourceSessionId}，limit=50（内容多时用 beforeEntryId 继续翻页）；若来源已有会话记忆，再 read_memory：sourceSessionId=${input.readSourceSessionId}。只读，禁止写入来源。`);
    lines.push(`2. create_topic：requestId=${input.requestId}，title=${input.title}，purpose=${input.purpose}`);
    lines.push(`3. create_node：topicId=${input.ids.topicId}，requestId=${input.requestId}，title=${input.title}，integrationSummary=<整合后的摘要：结论、逻辑关系与来源>；初始记忆必须以来源会话记忆条目为 provenance：sources=[{storageProjectId:本Friend, sessionId:${input.readSourceSessionId}, entryId:<read_memory 返回的条目 id>, content:<整合后的初始会话记忆>}]；若来源没有任何会话记忆条目，则只提交 integrationSummary，不写初始记忆。`);
  } else {
    lines.push(`父节点会话（整合来源，只读）：${input.readSourceSessionId}`);
    lines.push(`父边（必须原样传给 create_node.parents）：${JSON.stringify(input.parents)}`);
    lines.push("主题已存在，不要 create_topic。请只使用 topic_manage 工具，按顺序执行：");
    lines.push(`1. read_memory：sourceSessionId=${input.readSourceSessionId}；需要上下文时再 read_fulltext：sourceSessionId=${input.readSourceSessionId}。只读。`);
    lines.push(`2. create_node：topicId=${input.ids.topicId}，requestId=${input.requestId}，title=${input.title}，integrationSummary=<整合后的摘要：结论、逻辑关系与来源>，parents=<上面的父边>；初始记忆以父节点会话记忆条目为 sources=[{storageProjectId:本Friend, sessionId:${input.readSourceSessionId}, entryId:<read_memory 返回的条目 id>, content:<整合后的初始会话记忆>}]；若父节点没有会话记忆条目，则只提交 integrationSummary。`);
  }
  lines.push("创建结果必须与上面给定的 topicId/requestId/title 一致，不要自造 id。");
  lines.push(`完成后只用一句话回复：已建节点「${input.title}」。`);
  return lines.join("\n");
}

export interface StartTopicIntegrationInput {
  readonly chatHome: string;
  readonly longAgentId: string;
  readonly requestId: unknown;
  readonly title: unknown;
  readonly purpose: unknown;
  readonly sourceSessionId?: unknown;
  /** Present only for a fork; the child integrates from the parent node and its settled anchor. */
  readonly parents?: readonly TopicIntegrationParent[];
}

/**
 * Starts (or replays) the integration background work for one 建题 request. Idempotent through the
 * work's own request identity: the same request id with the same source/title/purpose returns the same
 * work, while a changed payload is a conflict instead of a second integration.
 */
export async function startTopicIntegration(input: StartTopicIntegrationInput) {
  const home = resolveChatHome(input.chatHome);
  const requestId = text(input.requestId, "requestId", 200);
  if (!isTopicRequestId(requestId)) throw new Error("requestId 格式无效");
  const title = text(input.title, "title", 200);
  const purpose = text(input.purpose, "purpose", 2_000);
  const parents = normalizeParents(input.parents);
  // The persisted work is the request identity, so it is read BEFORE anything is skipped: a request
  // that already produced (or is producing) a node must still be re-checked against it.
  const existing = await readTopicIntegration({ chatHome: home, longAgentId: input.longAgentId, requestId });
  // A work that exists froze its origin: a replay must not re-resolve "today's" daily session (which may
  // have rolled over) and must not be allowed to change the source.
  let originSessionId: string;
  if (existing.work !== null) {
    originSessionId = existing.work.originSessionId;
    if (input.sourceSessionId !== undefined && text(input.sourceSessionId, "sourceSessionId", 200) !== originSessionId)
      throw new Error("该 requestId 的建题来源已固定，不能更改");
  } else {
    if (existing.node !== null) throw new Error("建题节点已存在但缺少后台工作记录，无法核对请求身份");
    originSessionId = await resolveDailySource(home, input.longAgentId, input.sourceSessionId);
  }
  const graph = await readTopicGraph(home, input.longAgentId);
  let topicId: string;
  let readSourceSessionId: string;
  if (parents.length > 0) {
    const parentNodes = parents.map((parent) => graph.nodes.find((node) => node.nodeId === parent.nodeId));
    if (parentNodes.some((node) => node === undefined)) throw new Error("父节点不存在，不能作为 fork 来源");
    if (new Set(parentNodes.map((node) => node!.topicId)).size !== 1) throw new Error("父边必须属于同一主题");
    topicId = parentNodes[0]!.topicId;
    readSourceSessionId = parentNodes[0]!.sessionId;
  } else {
    topicId = topicIdOf(input.longAgentId, requestId);
    readSourceSessionId = originSessionId;
  }
  const ids = topicIntegrationIds(input.longAgentId, requestId, topicId);
  // startFriendWork owns the payload comparison, so title/purpose/source/parents changes after creation
  // are a conflict (it throws) instead of a silent success.
  await startFriendWork({
    chatHome: home,
    longAgentId: input.longAgentId,
    requestId: topicIntegrationWorkRequestId(requestId),
    originSessionId,
    contextProjectId: null,
    title: `整合：${title}`.slice(0, 120),
    text: buildIntegrationInstruction({ title, purpose, requestId, ids, readSourceSessionId, parents }),
    topicIntegration: ids,
  });
  // The computed ids are authoritative for this request (a fork derives them from the parent topic);
  // readTopicIntegration can only recover them from the graph once the node exists.
  return { ...(await readTopicIntegration({ chatHome: home, longAgentId: input.longAgentId, requestId })), ...ids };
}

export interface ReadTopicIntegrationInput {
  readonly chatHome: string;
  readonly longAgentId: string;
  readonly requestId: string;
}

/**
 * Current state of one 建题 request, resolved from durable facts only: the graph answers whether the
 * work produced its node (root or fork), and the work turn answers progress/failure. This is what P3
 * resumes. A theme shell with no node is NEVER reported as completed.
 */
export async function readTopicIntegration(input: ReadTopicIntegrationInput) {
  const home = resolveChatHome(input.chatHome);
  const requestId = text(input.requestId, "requestId", 200);
  const graph = await readTopicGraph(home, input.longAgentId);
  const state = await readLongAgentState(home);
  const work = state.works.find((candidate) => candidate.longAgentId === input.longAgentId
    && candidate.requestId === topicIntegrationWorkRequestId(requestId)) ?? null;
  const node = graph.nodes.find((candidate) => candidate.createdByRequestId === requestId) ?? null;
  // The FROZEN target wins over a re-derivation: in-progress, failed and completed queries must all
  // return the same ids, and a fork's ids (parent topic based) cannot be recovered from the graph before
  // the node exists. The node is only a fallback for records written before the freeze was persisted.
  const frozen = work?.topicIntegration ?? null;
  const ids: TopicIntegrationIds = frozen !== null
    ? { topicId: frozen.topicId, sessionId: frozen.sessionId, nodeId: frozen.nodeId }
    : node === null
      ? topicIntegrationIds(input.longAgentId, requestId)
      : { topicId: node.topicId, sessionId: node.sessionId, nodeId: node.nodeId };
  const topic = graph.topics.find((candidate) => candidate.topicId === ids.topicId) ?? null;
  const turn = work === null ? undefined : state.turns.filter((candidate) => candidate.workId === work.id).at(-1);
  // The node is the product, so its existence wins over a delayed turn status write. A work that
  // FINISHED without producing its node is a failure, never a success (a topic shell is not a product).
  const status = node !== null ? "completed"
    : turn === undefined ? "unknown"
      : turn.status === "completed" ? "failed"
        : turn.status;
  return {
    schemaVersion: 1 as const,
    requestId,
    ...ids,
    sourceSessionId: work?.originSessionId ?? null,
    status,
    topic,
    node,
    work,
    execution: turn === undefined ? null : friendExecution(home, turn),
  };
}
