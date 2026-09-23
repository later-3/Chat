import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertFileWithin, atomicWriteJson, withFileLock } from "../persistence/versioned-file.js";
import { longAgentConfigRoot } from "./storage.js";

/**
 * P2 topic graph: the durable record of a Long Agent's theme trees.
 *
 * A topic is a tree root owned by the Long Agent that created it. A node is a normal Chat session in
 * that agent's home; an edge records "this child was created after the parent's Nth settle point" plus
 * the memory entries it inherited. The graph lives in the agent home and is the single source for
 * provenance: `nodes[].initialMemoryRefs` answers "where did this node's initial context come from"
 * even for a root node (which has no inbound edge).
 */
export const TOPIC_SCHEMA_VERSION = 1;
const TOPIC_ID_PATTERN = /^topic-[a-f0-9]{16,64}$/;
const NODE_ID_PATTERN = /^node-[a-f0-9]{16,64}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

/** Where one initial memory entry came from: the exact durable address, not a bare entry id. */
export interface TopicMemorySource {
  readonly storageProjectId: string;
  readonly sessionId: string;
  readonly entryId: string;
}

export interface TopicNodeInitialMemoryRef {
  /** The entry id inside this node's own session memory. */
  readonly entryId: string;
  readonly source: TopicMemorySource;
}

export interface TopicRecord {
  readonly topicId: string;
  readonly ownerLongAgentId: string;
  readonly title: string;
  readonly purpose: string;
  readonly status: "active" | "archived";
  readonly rootSessionId: string;
  readonly createdByRequestId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TopicNodeRecord {
  readonly nodeId: string;
  readonly topicId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly status: "active" | "archived" | "removed";
  /** Project context frozen when the node was created; null means "explicitly no project". */
  readonly frozenProjectContext: string | null;
  readonly createdBy: "user" | "agent";
  readonly createdByRequestId: string;
  /**
   * Immutable digest of the creation request (topic/session/title/creator/context, initial memory
   * sources and the full parent-edge spec). Retry idempotency compares THIS, never the node's current
   * inbound edges, which are mutable through supplementary integration.
   */
  readonly createdByRequestDigest: string;
  readonly initialMemoryRefs: readonly TopicNodeInitialMemoryRef[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TopicEdgeRecord {
  readonly edgeId: string;
  readonly parentNodeId: string;
  readonly childNodeId: string;
  /** The parent entry this child branched from (frozen); null only for a "from the start" edge. */
  readonly anchorEntryId: string | null;
  /** The parent's settled user-turn sequence at creation time. */
  readonly anchorSequence: number | null;
  /** Cross-node references: which parent memory entries this child inherited. */
  readonly memoryRefs: readonly TopicMemorySource[];
  readonly createdAt: string;
}

/**
 * Durable "session already reserved for this creation request" record. `reserveChatSession` generates
 * the session id itself and `openChatSession` refuses an unknown id, so a retry after a crash between
 * reservation and graph registration can only reuse the same session if the id is recorded first.
 */
export interface TopicNodeReservationRecord {
  readonly requestId: string;
  readonly topicId: string;
  readonly sessionId: string;
  readonly createdAt: string;
}

export interface TopicGraphState {
  readonly schemaVersion: typeof TOPIC_SCHEMA_VERSION;
  readonly longAgentId: string;
  readonly revision: number;
  readonly topics: readonly TopicRecord[];
  readonly nodes: readonly TopicNodeRecord[];
  readonly edges: readonly TopicEdgeRecord[];
  readonly reservations: readonly TopicNodeReservationRecord[];
}

export class TopicError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new TopicError(400, `主题${label}无效`);
  return value.trim();
}

function optionalText(value: unknown, label: string, max: number): string | null {
  return value === null || value === undefined ? null : text(value, label, max);
}

function identity(value: unknown, label: string, pattern: RegExp): string {
  const value_ = text(value, label, 200);
  if (!pattern.test(value_)) throw new TopicError(400, `主题${label}格式无效`);
  return value_;
}

export function topicIdOf(ownerLongAgentId: string, requestId: string): string {
  return `topic-${createHash("sha256").update(JSON.stringify([ownerLongAgentId, requestId])).digest("hex").slice(0, 32)}`;
}

export function topicNodeIdOf(topicId: string, sessionId: string): string {
  return `node-${createHash("sha256").update(JSON.stringify([topicId, sessionId])).digest("hex").slice(0, 32)}`;
}

function parseMemorySource(value: unknown, label: string): TopicMemorySource {
  if (!isRecord(value)) throw new TopicError(400, `主题${label}无效`);
  return {
    storageProjectId: text(value.storageProjectId, `${label}.storageProjectId`, 200),
    sessionId: text(value.sessionId, `${label}.sessionId`, 200),
    entryId: text(value.entryId, `${label}.entryId`, 200),
  };
}

function parseTopic(value: unknown): TopicRecord {
  if (!isRecord(value)) throw new TopicError(500, "主题记录无效");
  if (value.status !== "active" && value.status !== "archived") throw new TopicError(500, "主题状态无效");
  return {
    topicId: identity(value.topicId, "topicId", TOPIC_ID_PATTERN),
    ownerLongAgentId: text(value.ownerLongAgentId, "ownerLongAgentId", 120),
    title: text(value.title, "title", 200),
    purpose: text(value.purpose, "purpose", 2_000),
    status: value.status,
    rootSessionId: text(value.rootSessionId, "rootSessionId", 200),
    createdByRequestId: text(value.createdByRequestId, "createdByRequestId", 200),
    createdAt: text(value.createdAt, "createdAt", 64),
    updatedAt: text(value.updatedAt, "updatedAt", 64),
  };
}

function parseNode(value: unknown): TopicNodeRecord {
  if (!isRecord(value)) throw new TopicError(500, "主题节点无效");
  if (!["active", "archived", "removed"].includes(String(value.status))) throw new TopicError(500, "主题节点状态无效");
  if (value.createdBy !== "user" && value.createdBy !== "agent") throw new TopicError(500, "主题节点创建者无效");
  if (!Array.isArray(value.initialMemoryRefs)) throw new TopicError(500, "主题节点初始记忆引用无效");
  const initialMemoryRefs = value.initialMemoryRefs.map((entry) => {
    if (!isRecord(entry)) throw new TopicError(500, "主题节点初始记忆引用无效");
    return { entryId: text(entry.entryId, "initialMemoryRef.entryId", 200), source: parseMemorySource(entry.source, "initialMemoryRef.source") };
  });
  return {
    nodeId: identity(value.nodeId, "nodeId", NODE_ID_PATTERN),
    topicId: identity(value.topicId, "topicId", TOPIC_ID_PATTERN),
    sessionId: text(value.sessionId, "sessionId", 200),
    title: text(value.title, "title", 200),
    status: value.status as TopicNodeRecord["status"],
    frozenProjectContext: optionalText(value.frozenProjectContext, "frozenProjectContext", 200),
    createdBy: value.createdBy,
    createdByRequestId: text(value.createdByRequestId, "createdByRequestId", 200),
    createdByRequestDigest: text(value.createdByRequestDigest, "createdByRequestDigest", 200),
    initialMemoryRefs,
    createdAt: text(value.createdAt, "createdAt", 64),
    updatedAt: text(value.updatedAt, "updatedAt", 64),
  };
}

function parseReservation(value: unknown): TopicNodeReservationRecord {
  if (!isRecord(value)) throw new TopicError(500, "主题节点预留记录无效");
  return {
    requestId: text(value.requestId, "reservation.requestId", 200),
    topicId: identity(value.topicId, "reservation.topicId", TOPIC_ID_PATTERN),
    sessionId: text(value.sessionId, "reservation.sessionId", 200),
    createdAt: text(value.createdAt, "reservation.createdAt", 64),
  };
}

function parseEdge(value: unknown): TopicEdgeRecord {
  if (!isRecord(value)) throw new TopicError(500, "主题边无效");
  if (!Array.isArray(value.memoryRefs)) throw new TopicError(500, "主题边记忆引用无效");
  const anchorSequence = value.anchorSequence === null || value.anchorSequence === undefined ? null : Number(value.anchorSequence);
  if (anchorSequence !== null && (!Number.isSafeInteger(anchorSequence) || anchorSequence < 0)) throw new TopicError(500, "主题边锚点序号无效");
  return {
    edgeId: text(value.edgeId, "edgeId", 200),
    parentNodeId: identity(value.parentNodeId, "parentNodeId", NODE_ID_PATTERN),
    childNodeId: identity(value.childNodeId, "childNodeId", NODE_ID_PATTERN),
    anchorEntryId: optionalText(value.anchorEntryId, "anchorEntryId", 200),
    anchorSequence,
    memoryRefs: value.memoryRefs.map((entry) => parseMemorySource(entry, "edge.memoryRefs")),
    createdAt: text(value.createdAt, "createdAt", 64),
  };
}

export function topicGraphFile(chatHome: string, longAgentId: string): string {
  return resolve(longAgentConfigRoot(chatHome, longAgentId), "topics.json");
}

export async function readTopicGraph(chatHome: string, longAgentId: string): Promise<TopicGraphState> {
  const file = topicGraphFile(chatHome, longAgentId);
  await assertFileWithin(file, chatHome);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { schemaVersion: TOPIC_SCHEMA_VERSION, longAgentId, revision: 0, topics: [], nodes: [], edges: [], reservations: [] };
    throw error;
  }
  if (!isRecord(value) || value.schemaVersion !== TOPIC_SCHEMA_VERSION || !Number.isSafeInteger(value.revision)
    || !Array.isArray(value.topics) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)
    || !Array.isArray(value.reservations))
    throw new TopicError(500, "主题图存储格式无效");
  return {
    schemaVersion: TOPIC_SCHEMA_VERSION,
    longAgentId,
    revision: Number(value.revision),
    topics: value.topics.map(parseTopic),
    nodes: value.nodes.map(parseNode),
    edges: value.edges.map(parseEdge),
    reservations: value.reservations.map(parseReservation),
  };
}

type MutableTopic = { -readonly [K in keyof TopicRecord]: TopicRecord[K] };
type MutableNode = { -readonly [K in keyof TopicNodeRecord]: TopicNodeRecord[K] };
type MutableEdge = { -readonly [K in keyof TopicEdgeRecord]: TopicEdgeRecord[K] };
interface MutableTopicGraphState {
  schemaVersion: 1;
  longAgentId: string;
  revision: number;
  topics: MutableTopic[];
  nodes: MutableNode[];
  edges: MutableEdge[];
  reservations: TopicNodeReservationRecord[];
}

async function changeTopicGraph<T>(
  chatHome: string,
  longAgentId: string,
  change: (state: MutableTopicGraphState) => T | Promise<T>,
): Promise<T> {
  const file = topicGraphFile(chatHome, longAgentId);
  return withFileLock(file, async () => {
    const current = await readTopicGraph(chatHome, longAgentId);
    const state: MutableTopicGraphState = {
      schemaVersion: TOPIC_SCHEMA_VERSION,
      longAgentId,
      revision: current.revision,
      topics: current.topics.map((topic) => ({ ...topic })),
      nodes: current.nodes.map((node) => ({ ...node, initialMemoryRefs: [...node.initialMemoryRefs] })),
      edges: current.edges.map((edge) => ({ ...edge, memoryRefs: [...edge.memoryRefs] })),
      reservations: current.reservations.map((reservation) => ({ ...reservation })),
    };
    const result = await change(state);
    await assertFileWithin(file, chatHome);
    await atomicWriteJson(file, state);
    return result;
  });
}

function assertRevision(state: { revision: number }, expectedRevision: unknown): number {
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0)
    throw new TopicError(400, "主题图写入需要 expectedRevision（先读取当前 revision）");
  if (state.revision !== Number(expectedRevision))
    throw new TopicError(409, `主题图已被修改（当前 revision ${String(state.revision)}），请重新读取后重试`);
  return state.revision;
}

function snapshot(state: MutableTopicGraphState): TopicGraphState {
  return {
    schemaVersion: TOPIC_SCHEMA_VERSION,
    longAgentId: state.longAgentId,
    revision: state.revision,
    topics: state.topics.map((topic) => ({ ...topic })),
    nodes: state.nodes.map((node) => ({ ...node, initialMemoryRefs: [...node.initialMemoryRefs] })),
    edges: state.edges.map((edge) => ({ ...edge, memoryRefs: [...edge.memoryRefs] })),
    reservations: state.reservations.map((reservation) => ({ ...reservation })),
  };
}

/** Bounded retries: a different creation request may have bumped the graph revision concurrently. */
const TOPIC_GRAPH_CAS_ATTEMPTS = 5;

/**
 * Reserve the Chat session for one node-creation request, under a dedicated per-request lock:
 * concurrent retries of the SAME requestId serialize and allocate exactly one session, and a retry
 * after a crash reuses the recorded session instead of allocating a second one.
 */
export async function reserveTopicNodeSession(input: {
  readonly chatHome: string;
  readonly longAgentId: string;
  readonly topicId: unknown;
  readonly requestId: unknown;
  readonly allocateSessionId: () => Promise<string>;
  readonly now?: string;
}): Promise<{ sessionId: string; created: boolean; reservation: TopicNodeReservationRecord }> {
  const topicId = identity(input.topicId, "topicId", TOPIC_ID_PATTERN);
  const requestId = text(input.requestId, "requestId", 200);
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new TopicError(400, "主题requestId格式无效");
  const file = topicGraphFile(input.chatHome, input.longAgentId);
  return withFileLock(`${file}.request-${requestId}`, async () => {
    for (let attempt = 0; attempt < TOPIC_GRAPH_CAS_ATTEMPTS; attempt += 1) {
      const current = await readTopicGraph(input.chatHome, input.longAgentId);
      const existing = current.reservations.find((reservation) => reservation.requestId === requestId);
      if (existing !== undefined) {
        if (existing.topicId !== topicId) throw new TopicError(409, `该 requestId 已预留给另一个主题：${requestId}`);
        return { sessionId: existing.sessionId, created: false, reservation: { ...existing } };
      }
      const topic = current.topics.find((candidate) => candidate.topicId === topicId);
      if (topic === undefined) throw new TopicError(404, `找不到主题：${topicId}`);
      if (topic.ownerLongAgentId !== input.longAgentId) throw new TopicError(403, "主题不属于该 Long Agent");
      if (topic.status !== "active") throw new TopicError(409, "主题已归档，不能新建节点");
      const sessionId = await input.allocateSessionId();
      if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId))
        throw new TopicError(500, "会话预留返回了非法 session id");
      const reservation: TopicNodeReservationRecord = {
        requestId, topicId, sessionId, createdAt: input.now ?? new Date().toISOString(),
      };
      try {
        await changeTopicGraph(input.chatHome, input.longAgentId, (state) => {
          assertRevision(state, current.revision);
          const conflict = state.reservations.find((candidate) => candidate.requestId === requestId);
          if (conflict !== undefined) return null;
          state.reservations.push(reservation);
          state.revision += 1;
          return null;
        });
        return { sessionId, created: true, reservation };
      } catch (error) {
        // A concurrent unrelated graph write: re-read and decide again (the session id is recorded in
        // the next attempt only if this request still has no reservation).
        if (!(error instanceof TopicError) || error.statusCode !== 409) throw error;
      }
    }
    throw new TopicError(409, "主题图并发写入过多，预留未完成，请重试");
  });
}

/** Create a topic, or return the existing one for the same request id (retry-safe). */
export async function createTopic(input: {
  chatHome: string;
  longAgentId: string;
  title: unknown;
  purpose: unknown;
  requestId: unknown;
  rootSessionId: unknown;
  expectedRevision: unknown;
  now?: string;
}): Promise<{ topic: TopicRecord; graph: TopicGraphState; created: boolean }> {
  const requestId = text(input.requestId, "requestId", 200);
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new TopicError(400, "主题requestId格式无效");
  const title = text(input.title, "title", 200);
  const purpose = text(input.purpose, "purpose", 2_000);
  const rootSessionId = text(input.rootSessionId, "rootSessionId", 200);
  const topicId = topicIdOf(input.longAgentId, requestId);
  return changeTopicGraph(input.chatHome, input.longAgentId, (state) => {
    const existing = state.topics.find((topic) => topic.topicId === topicId);
    if (existing !== undefined) return { topic: { ...existing }, graph: snapshot(state), created: false };
    assertRevision(state, input.expectedRevision);
    if (state.topics.some((candidate) => candidate.rootSessionId === rootSessionId))
      throw new TopicError(409, `该根会话已属于另一个主题：${rootSessionId}`);
    const now = input.now ?? new Date().toISOString();
    const topic: TopicRecord = {
      topicId, ownerLongAgentId: input.longAgentId, title, purpose, status: "active", rootSessionId,
      createdByRequestId: requestId, createdAt: now, updatedAt: now,
    };
    state.topics.push(topic);
    state.revision += 1;
    return { topic: { ...topic }, graph: snapshot(state), created: true };
  });
}

interface NormalizedParentSpec {
  readonly parentNodeId: string;
  readonly anchorEntryId: string | null;
  readonly anchorSequence: number | null;
  readonly memoryRefs: readonly TopicMemorySource[];
}

function normalizeMemoryRefs(value: unknown, label: string): TopicMemorySource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TopicError(400, `${label}无效`);
  return value.map((entry) => parseMemorySource(entry, label));
}

function normalizeParentSpecs(inputs: readonly ParentEdgeSpec[]): NormalizedParentSpec[] {
  return inputs.map((parent) => {
    const anchorSequence = parent.anchorSequence === undefined || parent.anchorSequence === null ? null : Number(parent.anchorSequence);
    if (anchorSequence !== null && (!Number.isSafeInteger(anchorSequence) || anchorSequence < 0)) throw new TopicError(400, "锚点序号无效");
    return {
      parentNodeId: identity(parent.parentNodeId, "parentNodeId", NODE_ID_PATTERN),
      anchorEntryId: optionalText(parent.anchorEntryId, "anchorEntryId", 200),
      anchorSequence,
      memoryRefs: normalizeMemoryRefs(parent.memoryRefs, "边记忆引用"),
    };
  });
}

function sortCanonical<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((left, right) => (key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0));
}

function canonicalSource(ref: TopicMemorySource): string {
  return JSON.stringify([ref.storageProjectId, ref.sessionId, ref.entryId]);
}

function canonicalParent(parent: NormalizedParentSpec): string {
  return JSON.stringify([
    parent.parentNodeId, parent.anchorEntryId, parent.anchorSequence,
    sortCanonical(parent.memoryRefs, canonicalSource).map(canonicalSource),
  ]);
}

/** Canonical digest of one creation request; order-insensitive for the ref/parent collections. */
function nodeCreationDigest(spec: {
  topicId: string;
  sessionId: string;
  title: string;
  createdBy: "user" | "agent";
  frozenProjectContext: string | null;
  initialMemoryRefs: readonly TopicNodeInitialMemoryRef[];
  parents: readonly NormalizedParentSpec[];
}): string {
  const canonical = JSON.stringify([
    spec.topicId, spec.sessionId, spec.title, spec.createdBy, spec.frozenProjectContext,
    sortCanonical(spec.initialMemoryRefs, (ref) => `${ref.entryId}|${canonicalSource(ref.source)}`)
      .map((ref) => [ref.entryId, ref.source.storageProjectId, ref.source.sessionId, ref.source.entryId]),
    sortCanonical(spec.parents, canonicalParent).map(canonicalParent),
  ]);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** True when `child` can already reach `parent` (adding parent → child would create a cycle). */
function reaches(edges: readonly TopicEdgeRecord[], from: string, target: string): boolean {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of edges) if (edge.parentNodeId === current) queue.push(edge.childNodeId);
  }
  return false;
}

export interface CreateTopicNodeParentInput {
  readonly parentNodeId: unknown;
  readonly anchorEntryId?: unknown;
  readonly anchorSequence?: unknown;
  readonly memoryRefs?: unknown;
}

export interface CreateTopicNodeInput {
  readonly chatHome: string;
  readonly longAgentId: string;
  readonly topicId: unknown;
  readonly sessionId: unknown;
  readonly title: unknown;
  readonly createdBy: "user" | "agent";
  readonly frozenProjectContext?: unknown;
  readonly initialMemoryRefs?: unknown;
  readonly parents?: readonly CreateTopicNodeParentInput[];
  readonly requestId: unknown;
  readonly expectedRevision: unknown;
  readonly now?: string;
}

/**
 * Register a node (a Chat session in this agent home) in the graph, together with its parent edges.
 * Anti-cycle: an edge is refused when the child can already reach the parent (or equals it). The
 * caller owns session creation and the initial memory entries; this function only records the facts.
 */
export async function createTopicNode(input: CreateTopicNodeInput): Promise<{ node: TopicNodeRecord; graph: TopicGraphState; created: boolean }> {
  const topicId = identity(input.topicId, "topicId", TOPIC_ID_PATTERN);
  const sessionId = text(input.sessionId, "sessionId", 200);
  const title = text(input.title, "title", 200);
  const requestId = text(input.requestId, "requestId", 200);
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new TopicError(400, "主题requestId格式无效");
  const frozenProjectContext = optionalText(input.frozenProjectContext, "frozenProjectContext", 200);
  const rawRefs = input.initialMemoryRefs === undefined ? [] : input.initialMemoryRefs;
  if (!Array.isArray(rawRefs)) throw new TopicError(400, "主题节点初始记忆引用无效");
  const initialMemoryRefs: TopicNodeInitialMemoryRef[] = rawRefs.map((entry) => {
    if (!isRecord(entry)) throw new TopicError(400, "主题节点初始记忆引用无效");
    return { entryId: text(entry.entryId, "initialMemoryRef.entryId", 200), source: parseMemorySource(entry.source, "initialMemoryRef.source") };
  });
  const parentInputs = input.parents ?? [];
  const parents = normalizeParentSpecs(parentInputs);
  const digest = nodeCreationDigest({ topicId, sessionId, title, createdBy: input.createdBy, frozenProjectContext, initialMemoryRefs, parents });
  return changeTopicGraph(input.chatHome, input.longAgentId, (state) => {
    const nodeId = topicNodeIdOf(topicId, sessionId);
    // The request id is the retry identity for the whole four-step creation (session reservation,
    // summary, initial memory, graph registration): a retry with the same id returns the same node,
    // and the same id with different inputs is a conflict instead of a second node.
    // The reservation and the node record are cleaned/created in the SAME graph write, so a retry after
    // registration never allocates a second session.
    const dropStaleReservation = (): void => {
      const stale = state.reservations.filter((reservation) => reservation.requestId === requestId);
      if (stale.length === 0) return;
      state.reservations = state.reservations.filter((reservation) => reservation.requestId !== requestId);
      state.revision += 1;
    };
    const byRequest = state.nodes.find((node) => node.createdByRequestId === requestId);
    if (byRequest !== undefined) {
      if (byRequest.createdByRequestDigest === digest) {
        dropStaleReservation();
        return { node: { ...byRequest }, graph: snapshot(state), created: false };
      }
      throw new TopicError(409, `该 requestId 已用于不同的节点创建：${requestId}`);
    }
    const existing = state.nodes.find((node) => node.nodeId === nodeId);
    if (existing !== undefined) {
      // Same topic+session but a different creation request (title, anchors, initial sources, ...).
      if (existing.createdByRequestDigest === digest) {
        dropStaleReservation();
        return { node: { ...existing }, graph: snapshot(state), created: false };
      }
      throw new TopicError(409, `会话已属于某个主题节点，且创建请求不同：${sessionId}`);
    }
    const topic = state.topics.find((candidate) => candidate.topicId === topicId);
    if (topic === undefined) throw new TopicError(404, `找不到主题：${topicId}`);
    if (topic.ownerLongAgentId !== input.longAgentId) throw new TopicError(403, "主题不属于该 Long Agent");
    if (topic.status !== "active") throw new TopicError(409, "主题已归档，不能新建节点");
    if (state.nodes.some((node) => node.sessionId === sessionId)) throw new TopicError(409, `会话已属于某个主题节点：${sessionId}`);
    if (parentInputs.length === 0) {
      // The only parentless node is the topic's declared root; a second root would be unreachable from
      // `rootSessionId` and could permanently block the real root from registering.
      if (sessionId !== topic.rootSessionId)
        throw new TopicError(409, `无父节点只能是主题根会话：${topic.rootSessionId}`);
      if (state.nodes.some((node) => node.topicId === topicId && !state.edges.some((edge) => edge.childNodeId === node.nodeId)))
        throw new TopicError(409, "该主题已存在根节点");
    }
    assertRevision(state, input.expectedRevision);
    const now = input.now ?? new Date().toISOString();
    const edges: TopicEdgeRecord[] = [];
    for (const parent of parents) {
      if (edges.some((edge) => edge.parentNodeId === parent.parentNodeId))
        throw new TopicError(409, "同一父节点不能重复");
      edges.push(parseParentEdge(parent, { ...state, edges: [...state.edges, ...edges] } as MutableTopicGraphState, nodeId, topicId, now));
    }
    const node: TopicNodeRecord = {
      nodeId, topicId, sessionId, title, status: "active", frozenProjectContext,
      createdBy: input.createdBy, createdByRequestId: requestId, createdByRequestDigest: digest, initialMemoryRefs,
      createdAt: now, updatedAt: now,
    };
    state.nodes.push(node);
    state.edges.push(...edges);
    state.reservations = state.reservations.filter((reservation) => reservation.requestId !== requestId);
    state.revision += 1;
    return { node: { ...node }, graph: snapshot(state), created: true };
  });
}

interface ParentEdgeSpec {
  readonly parentNodeId: unknown;
  readonly anchorEntryId?: unknown;
  readonly anchorSequence?: unknown;
  readonly memoryRefs?: unknown;
}

/** Validate one normalized parent edge against the graph; `nodeId` must not already reach the parent. */
function parseParentEdge(spec: NormalizedParentSpec, state: MutableTopicGraphState, nodeId: string, topicId: string, now: string): TopicEdgeRecord {
  const { parentNodeId } = spec;
  if (parentNodeId === nodeId) throw new TopicError(409, "节点不能作为自己的父节点");
  const parent = state.nodes.find((node) => node.nodeId === parentNodeId);
  if (parent === undefined) throw new TopicError(404, `找不到父节点：${parentNodeId}`);
  // Both ends of an edge must live in the same topic tree; cross-tree reuse is recorded as a memory
  // source reference, never as a graph edge.
  if (parent.topicId !== topicId) throw new TopicError(409, "父节点属于另一个主题，不能跨树建边");
  // An archived/removed node refuses integration in both directions (it is read-only).
  if (parent.status !== "active") throw new TopicError(409, "父节点已归档或移除，不能作为整合来源");
  if (state.edges.some((edge) => edge.parentNodeId === parentNodeId && edge.childNodeId === nodeId))
    throw new TopicError(409, `该父边已存在：${parentNodeId}`);
  // An edge is refused when the child can already reach the parent: it would close a cycle.
  if (reaches(state.edges, nodeId, parentNodeId)) throw new TopicError(409, `该父节点会形成环：${parentNodeId}`);
  return {
    edgeId: `tedge-${randomUUID()}`,
    parentNodeId, childNodeId: nodeId,
    anchorEntryId: spec.anchorEntryId,
    anchorSequence: spec.anchorSequence,
    memoryRefs: [...spec.memoryRefs],
    createdAt: now,
  };
}

/**
 * Supplementary integration: add one parent edge to an EXISTING node (a new node cannot close a cycle
 * because it has no outgoing edges yet). This is the only operation the anti-cycle rule really guards.
 */
export async function addTopicNodeParent(input: ParentEdgeSpec & {
  readonly chatHome: string;
  readonly longAgentId: string;
  readonly childNodeId: unknown;
  readonly expectedRevision: unknown;
  readonly now?: string;
}): Promise<{ edge: TopicEdgeRecord; graph: TopicGraphState; created: boolean }> {
  const childNodeId = identity(input.childNodeId, "childNodeId", NODE_ID_PATTERN);
  return changeTopicGraph(input.chatHome, input.longAgentId, (state) => {
    const child = state.nodes.find((node) => node.nodeId === childNodeId);
    if (child === undefined) throw new TopicError(404, `找不到子节点：${childNodeId}`);
    if (child.status !== "active") throw new TopicError(409, "节点已归档或移除，不能接受新的整合");
    const normalized = normalizeParentSpecs([input])[0]!;
    const existing = state.edges.find((edge) => edge.parentNodeId === normalized.parentNodeId && edge.childNodeId === childNodeId);
    if (existing !== undefined) return { edge: { ...existing }, graph: snapshot(state), created: false };
    assertRevision(state, input.expectedRevision);
    const now = input.now ?? new Date().toISOString();
    const edge = parseParentEdge(normalized, state, childNodeId, child.topicId, now);
    state.edges.push(edge);
    state.revision += 1;
    return { edge: { ...edge }, graph: snapshot(state), created: true };
  });
}

/** Mark the node that owns a removed session (edges are kept so provenance survives). */
export async function markTopicNodeRemoved(input: {
  chatHome: string;
  longAgentId: string;
  sessionId: string;
}): Promise<{ node: TopicNodeRecord; graph: TopicGraphState } | null> {
  return changeTopicGraph(input.chatHome, input.longAgentId, (state) => {
    const node = state.nodes.find((candidate) => candidate.sessionId === input.sessionId);
    if (node === undefined) return null;
    node.status = "removed";
    node.updatedAt = new Date().toISOString();
    state.revision += 1;
    return { node: { ...node }, graph: snapshot(state) };
  });
}

/**
 * Topic-level archive/restore. Archiving stops new nodes (and therefore new reservations) while the
 * tree stays readable for provenance; it does not touch node status.
 */
export async function updateTopicStatus(input: {
  chatHome: string;
  longAgentId: string;
  topicId: string;
  status: "active" | "archived";
  expectedRevision: unknown;
}): Promise<TopicRecord> {
  return changeTopicGraph(input.chatHome, input.longAgentId, (state) => {
    const topic = state.topics.find((candidate) => candidate.topicId === input.topicId);
    if (topic === undefined) throw new TopicError(404, `找不到主题：${input.topicId}`);
    assertRevision(state, input.expectedRevision);
    topic.status = input.status;
    topic.updatedAt = new Date().toISOString();
    state.revision += 1;
    return { ...topic };
  });
}

/** Owner-facing status change. `removed` is terminal: a normal update must never resurrect it. */
export async function updateTopicNodeStatus(input: {
  chatHome: string;
  longAgentId: string;
  nodeId: string;
  status: "active" | "archived";
  expectedRevision: unknown;
}): Promise<TopicNodeRecord> {
  return changeTopicGraph(input.chatHome, input.longAgentId, (state) => {
    const node = state.nodes.find((candidate) => candidate.nodeId === input.nodeId);
    if (node === undefined) throw new TopicError(404, `找不到主题节点：${input.nodeId}`);
    if (node.status === "removed") throw new TopicError(409, "节点已移除，不能改回可用状态");
    assertRevision(state, input.expectedRevision);
    node.status = input.status;
    node.updatedAt = new Date().toISOString();
    state.revision += 1;
    return { ...node };
  });
}

export function findTopicNodeBySession(graph: TopicGraphState, sessionId: string): TopicNodeRecord | null {
  return graph.nodes.find((node) => node.sessionId === sessionId) ?? null;
}

export function findTopic(graph: TopicGraphState, topicId: string): TopicRecord | null {
  return graph.topics.find((topic) => topic.topicId === topicId) ?? null;
}

export type TopicRequester = { readonly kind: "user" } | { readonly kind: "agent"; readonly longAgentId: string };
export type TopicCapability = "read" | "relay" | "write";

export interface TopicAuthorization {
  /** True when this session is a topic node, so the caller must use this decision. */
  readonly applicable: boolean;
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly node: TopicNodeRecord | null;
  readonly topic: TopicRecord | null;
}

/**
 * Shared authorization for every entry that touches a topic node's session (node API, memory API,
 * generic session read/write, Run start). A session that is not a topic node is `applicable: false`,
 * and the caller keeps its existing contract.
 *
 * - read: any Long Agent may read another tree read-only (integration needs cross-tree reuse);
 * - relay: only the Long Agent that owns the topic tree;
 * - write: only the agent home that owns the session (the local user keeps its own rights);
 * `removed` nodes refuse relay and write (they stay readable for provenance).
 */
export function authorizeTopicSession(input: {
  readonly graph: TopicGraphState;
  readonly requester: TopicRequester;
  readonly sessionId: string;
  readonly capability: TopicCapability;
}): TopicAuthorization {
  const node = findTopicNodeBySession(input.graph, input.sessionId);
  if (node === null) return { applicable: false, allowed: false, reason: null, node: null, topic: null };
  const topic = findTopic(input.graph, node.topicId);
  if (topic === null) return { applicable: true, allowed: false, reason: "主题节点缺少所属主题", node, topic: null };
  if (input.requester.kind === "user") {
    if (node.status === "removed" && input.capability !== "read")
      return { applicable: true, allowed: false, reason: "节点已移除，只能读取", node, topic };
    if (node.status === "archived" && input.capability === "relay")
      return { applicable: true, allowed: false, reason: "节点已归档，不能代传", node, topic };
    return { applicable: true, allowed: true, reason: null, node, topic };
  }
  const requester = input.requester.longAgentId;
  if (input.capability === "read") return { applicable: true, allowed: true, reason: null, node, topic };
  if (node.status === "removed")
    return { applicable: true, allowed: false, reason: "节点已移除", node, topic };
  // Relay targets a live conversation; an archived node is read-only for everyone.
  if (input.capability === "relay" && node.status !== "active")
    return { applicable: true, allowed: false, reason: "节点已归档，不能代传", node, topic };
  if (input.capability === "relay" && topic.ownerLongAgentId !== requester)
    return { applicable: true, allowed: false, reason: "只能代传自己创建的主题树", node, topic };
  if (input.capability === "write" && input.graph.longAgentId !== requester)
    return { applicable: true, allowed: false, reason: "只能写自己名下会话的记忆", node, topic };
  return { applicable: true, allowed: true, reason: null, node, topic };
}
