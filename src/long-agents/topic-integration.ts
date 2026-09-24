import { resolveChatHome } from "../chat-home.js";
import { friendExecution } from "./turn-feedback.js";
import { readLongAgentRegistry, readLongAgentState } from "./storage.js";
import { ensureAgentCalendar } from "./project-agent.js";
import { agentDate } from "./calendar.js";
import { isTopicRequestId, readTopicGraph, topicIdOf, topicNodeIdOf, topicRootSessionIdOf } from "./topics.js";
import { startFriendWork } from "./work.js";

/**
 * Owner-facing "说一句建题" entry: resolve the Friend's daily source, start the background INTEGRATION
 * work, and expose the deterministic root node that work will create.
 *
 * The integration itself is a normal (background) Long Agent turn: it reads the source session through
 * `topic_manage` and submits the integrated product with `create_topic` + `create_node`. This service only
 * owns the request identity, the source resolution and the background-work launch — it does NOT integrate
 * and does NOT create the node itself, so there is no second execution path.
 *
 * The node ids are pure functions of the request id (the same derivation `createTopicNode` uses), so a
 * caller can resolve the entryable node before the work finishes and without any extra registry.
 */
export interface TopicIntegrationIds {
  readonly topicId: string;
  readonly sessionId: string;
  readonly nodeId: string;
}

/** The identity of the background work that performs one integration request. */
export function topicIntegrationWorkRequestId(requestId: string): string {
  return `topic-integration:${requestId.trim()}`;
}

export function topicIntegrationIds(longAgentId: string, requestId: string): TopicIntegrationIds {
  const topicId = topicIdOf(longAgentId, requestId);
  const sessionId = topicRootSessionIdOf(longAgentId, requestId);
  return { topicId, sessionId, nodeId: topicNodeIdOf(topicId, sessionId) };
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new Error(`${label}无效`);
  return value.trim();
}

/**
 * Resolves the daily source session server-side. A caller may name a source only to pick among THIS
 * Friend's own daily sessions (never an arbitrary session): `startFriendWork` enforces the same rule
 * again, so a forged source cannot be used as an integration origin.
 */
async function resolveDailySource(home: string, longAgentId: string, sourceSessionId?: unknown): Promise<string> {
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
  readonly sourceSessionId: string;
  readonly requestId: string;
  readonly ids: TopicIntegrationIds;
}): string {
  return [
    "这是一次「整合建题」后台工作：在独立会话里完成，不要干扰来源会话。",
    `目标主题标题：${input.title}`,
    `主题目的：${input.purpose}`,
    `来源日常会话（只读）：${input.sourceSessionId}`,
    "请只使用 topic_manage 工具，按顺序执行：",
    `1. read_fulltext：sourceSessionId=${input.sourceSessionId}，limit=50（内容多时用 beforeEntryId 继续翻页）；若来源已有会话记忆，再 read_memory：sourceSessionId=${input.sourceSessionId}。只读，禁止写入来源。`,
    `2. create_topic：requestId=${input.requestId}，title=${input.title}，purpose=${input.purpose}`,
    `3. create_node：topicId=${input.ids.topicId}，requestId=${input.requestId}，title=${input.title}，integrationSummary=<整合后的摘要：结论、逻辑关系与来源>；初始记忆必须以来源会话的会话记忆条目为 provenance：用 sources=[{storageProjectId:本Friend, sessionId:${input.sourceSessionId}, entryId:<read_memory 返回的条目 id>, content:<整合后的初始会话记忆>}]；若来源没有任何会话记忆条目，则只提交 integrationSummary，不写初始记忆。`,
    `4. 创建结果必须与上面给定的 topicId/requestId/title 一致，不要自造 id。`,
    `完成后只用一句话回复：已建主题「${input.title}」。`,
  ].join("\n");
}

export interface StartTopicIntegrationInput {
  readonly chatHome: string;
  readonly longAgentId: string;
  readonly requestId: unknown;
  readonly title: unknown;
  readonly purpose: unknown;
  readonly sourceSessionId?: unknown;
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
  // A replay after the work produced the node stays a success even across a daily-session rollover: the
  // graph is the durable product, so it is checked before the source is resolved again.
  const existing = await readTopicIntegration({ chatHome: home, longAgentId: input.longAgentId, requestId });
  if (existing.node !== null) return existing;
  const title = text(input.title, "title", 200);
  const purpose = text(input.purpose, "purpose", 2_000);
  const sourceSessionId = await resolveDailySource(home, input.longAgentId, input.sourceSessionId);
  const ids = topicIntegrationIds(input.longAgentId, requestId);
  await startFriendWork({
    chatHome: home,
    longAgentId: input.longAgentId,
    requestId: topicIntegrationWorkRequestId(requestId),
    originSessionId: sourceSessionId,
    contextProjectId: null,
    title: `整合：${title}`.slice(0, 120),
    text: buildIntegrationInstruction({ title, purpose, sourceSessionId, requestId, ids }),
  });
  return readTopicIntegration({ chatHome: home, longAgentId: input.longAgentId, requestId });
}

export interface ReadTopicIntegrationInput {
  readonly chatHome: string;
  readonly longAgentId: string;
  readonly requestId: string;
}

/**
 * Current state of one 建题 request, resolved from durable facts only: the graph answers whether the
 * work produced the root node, and the work turn answers the rest. This is what P3 resumes.
 */
export async function readTopicIntegration(input: ReadTopicIntegrationInput) {
  const home = resolveChatHome(input.chatHome);
  const requestId = text(input.requestId, "requestId", 200);
  const ids = topicIntegrationIds(input.longAgentId, requestId);
  const graph = await readTopicGraph(home, input.longAgentId);
  const node = graph.nodes.find((candidate) => candidate.nodeId === ids.nodeId) ?? null;
  const topic = graph.topics.find((candidate) => candidate.topicId === ids.topicId) ?? null;
  const state = await readLongAgentState(home);
  const work = state.works.find((candidate) => candidate.longAgentId === input.longAgentId
    && candidate.requestId === topicIntegrationWorkRequestId(requestId)) ?? null;
  const turn = work === null ? undefined : state.turns.filter((candidate) => candidate.workId === work.id).at(-1);
  // The node is the product, so its existence wins over a delayed turn status write.
  const status = node !== null ? "completed" : turn === undefined ? "unknown" : turn.status;
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
