import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertFileWithin, atomicWriteJson, withFileLock } from "../persistence/versioned-file.js";
import { ensureChatSessionWithId, openChatSession } from "../chat-session.js";
import { appendChatUserMessage } from "../workflows/session-conversation.js";
import { chatSessionOperationKey, withChatSessionOperationLock } from "../session-operation-lock.js";
import { TopicAnchorError, requireTopicAnchor } from "./topic-anchor.js";
import { longAgentConfigRoot } from "./storage.js";
import { readSessionMemory, writeSessionMemoryEntry } from "./session-memory.js";
import { resolveProjectContext } from "../projects/registry.js";
import { listActiveSessionFiles } from "../session-files.js";
import { readInactiveChatSessionState } from "../removed-session-index.js";

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
/** The one request-id shape shared by topic/node creation and the integration entry. */
export function isTopicRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}
/** Bounded graph CAS attempts: concurrent node creations bump the revision under their own locks. */
const TOPIC_GRAPH_CAS_ATTEMPTS = 5;

/**
 * Where one initial memory entry came from: the exact durable address of a SESSION MEMORY entry
 * (`smem-...`) in `<storageProjectId>`'s agent home, not a Pi transcript entry id and not a bare id.
 */
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
  /** 「会话记忆」switch for this node; absent on an older graph means "on". */
  readonly sessionMemory: "on" | "off";
  readonly createdByRequestId: string;
  /**
   * Immutable digest of the creation request (topic/session/title/creator/context, initial memory
   * sources and the full parent-edge spec). Retry idempotency compares THIS, never the node's current
   * inbound edges, which are mutable through supplementary integration.
   */
  readonly createdByRequestDigest: string | null;
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

export interface TopicGraphState {
  readonly schemaVersion: typeof TOPIC_SCHEMA_VERSION;
  readonly longAgentId: string;
  readonly revision: number;
  readonly topics: readonly TopicRecord[];
  readonly nodes: readonly TopicNodeRecord[];
  readonly edges: readonly TopicEdgeRecord[];
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

/**
 * The node session id is DERIVED from (topicId, requestId), never allocated. A retry recomputes the
 * same id, so "session created but the graph write failed" has no window and needs no reservation
 * record: the retry reopens exactly that session. Pi accepts an explicit id (`newSession({ id })`).
 */
export function topicNodeSessionIdOf(topicId: string, requestId: string): string {
  return `sess-${createHash("sha256").update(JSON.stringify([topicId, requestId])).digest("hex").slice(0, 32)}`;
}

/** The root session of a topic is the root node's session, derived from the topic's own request id. */
export function topicRootSessionIdOf(ownerLongAgentId: string, requestId: string): string {
  return topicNodeSessionIdOf(topicIdOf(ownerLongAgentId, requestId), requestId);
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
    // A node written before the switch existed keeps its memory capability (default on).
    sessionMemory: value.sessionMemory === "off" ? "off" : "on",
    createdByRequestId: text(value.createdByRequestId, "createdByRequestId", 200),
    // A node registered before the digest existed: null means "a retry cannot be judged" (fail-closed).
    createdByRequestDigest: value.createdByRequestDigest === undefined || value.createdByRequestDigest === null
      ? null
      : text(value.createdByRequestDigest, "createdByRequestDigest", 200),
    initialMemoryRefs,
    createdAt: text(value.createdAt, "createdAt", 64),
    updatedAt: text(value.updatedAt, "updatedAt", 64),
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
      return { schemaVersion: TOPIC_SCHEMA_VERSION, longAgentId, revision: 0, topics: [], nodes: [], edges: [] };
    throw error;
  }
  // Tolerant of a v1 file written by an intermediate revision: a `reservations` array (the withdrawn
  // reservation table) is simply ignored, so an existing graph never fails to load.
  if (!isRecord(value) || value.schemaVersion !== TOPIC_SCHEMA_VERSION || !Number.isSafeInteger(value.revision)
    || !Array.isArray(value.topics) || !Array.isArray(value.nodes) || !Array.isArray(value.edges))
    throw new TopicError(500, "主题图存储格式无效");
  return {
    schemaVersion: TOPIC_SCHEMA_VERSION,
    longAgentId,
    revision: Number(value.revision),
    topics: value.topics.map(parseTopic),
    nodes: value.nodes.map(parseNode),
    edges: value.edges.map(parseEdge),
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

function snapshot(state: {
  schemaVersion: 1;
  longAgentId: string;
  revision: number;
  topics: readonly TopicRecord[];
  nodes: readonly TopicNodeRecord[];
  edges: readonly TopicEdgeRecord[];
}): TopicGraphState {
  return {
    schemaVersion: TOPIC_SCHEMA_VERSION,
    longAgentId: state.longAgentId,
    revision: state.revision,
    topics: state.topics.map((topic) => ({ ...topic })),
    nodes: state.nodes.map((node) => ({ ...node, initialMemoryRefs: [...node.initialMemoryRefs] })),
    edges: state.edges.map((edge) => ({ ...edge, memoryRefs: [...edge.memoryRefs] })),
  };
}

/** Create a topic, or return the existing one for the same request id (retry-safe). */
export async function createTopic(input: {
  chatHome: string;
  longAgentId: string;
  title: unknown;
  purpose: unknown;
  requestId: unknown;
  expectedRevision: unknown;
  now?: string;
}): Promise<{ topic: TopicRecord; graph: TopicGraphState; created: boolean }> {
  const requestId = text(input.requestId, "requestId", 200);
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new TopicError(400, "主题requestId格式无效");
  const title = text(input.title, "title", 200);
  const purpose = text(input.purpose, "purpose", 2_000);
  // Derived, not supplied: the root session id is a pure function of (owner, requestId), which is what
  // lets a brand-new topic's root session be created before the topic record exists.
  const rootSessionId = topicRootSessionIdOf(input.longAgentId, requestId);
  const topicId = topicIdOf(input.longAgentId, requestId);
  return changeTopicGraph(input.chatHome, input.longAgentId, (state) => {
    const existing = state.topics.find((topic) => topic.topicId === topicId);
    if (existing !== undefined) {
      // Same request id, different content: this is not the request that created the topic.
      if (existing.title !== title || existing.purpose !== purpose)
        throw new TopicError(409, `该 requestId 已用于不同的主题内容：${requestId}`);
      return { topic: { ...existing }, graph: snapshot(state), created: false };
    }
    assertRevision(state, input.expectedRevision);
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
  requestFingerprint: string | null;
}): string {
  const canonical = JSON.stringify([
    spec.topicId, spec.sessionId, spec.title, spec.createdBy, spec.frozenProjectContext, spec.requestFingerprint,
    sortCanonical(spec.initialMemoryRefs, (ref) => `${ref.entryId}|${canonicalSource(ref.source)}`)
      .map((ref) => [ref.entryId, ref.source.storageProjectId, ref.source.sessionId, ref.source.entryId]),
    sortCanonical(spec.parents, canonicalParent).map(canonicalParent),
  ]);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** Idempotency for a supplementary edge: only an IDENTICAL spec is a replay. */
function sameParentEdgeSpec(edge: TopicEdgeRecord, spec: NormalizedParentSpec): boolean {
  if (edge.anchorEntryId !== spec.anchorEntryId || edge.anchorSequence !== spec.anchorSequence) return false;
  const existing = sortCanonical(edge.memoryRefs, canonicalSource).map(canonicalSource);
  const requested = sortCanonical(spec.memoryRefs, canonicalSource).map(canonicalSource);
  return JSON.stringify(existing) === JSON.stringify(requested);
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
  readonly title: unknown;
  readonly createdBy: "user" | "agent";
  readonly frozenProjectContext?: unknown;
  /** 「会话记忆」switch; default on. */
  readonly sessionMemory?: unknown;
  readonly initialMemoryRefs?: unknown;
  readonly parents?: readonly CreateTopicNodeParentInput[];
  readonly requestId: unknown;
  /**
   * Optional orchestration-level fingerprint (integration summary text, bootstrap memory content,
   * sources) folded into the creation digest, so a replay with the same request id but different
   * orchestration inputs is a conflict instead of a silent success.
   */
  readonly requestFingerprint?: unknown;
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
  const title = text(input.title, "title", 200);
  const requestId = text(input.requestId, "requestId", 200);
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new TopicError(400, "主题requestId格式无效");
  // Derived: a caller cannot register an arbitrary session under a request id, so "the session was
  // registered as a different session" is impossible by construction.
  const sessionId = topicNodeSessionIdOf(topicId, requestId);
  const frozenProjectContext = optionalText(input.frozenProjectContext, "frozenProjectContext", 200);
  if (input.sessionMemory !== undefined && input.sessionMemory !== "on" && input.sessionMemory !== "off")
    throw new TopicError(400, "节点会话记忆开关无效");
  const rawRefs = input.initialMemoryRefs === undefined ? [] : input.initialMemoryRefs;
  if (!Array.isArray(rawRefs)) throw new TopicError(400, "主题节点初始记忆引用无效");
  const initialMemoryRefs: TopicNodeInitialMemoryRef[] = rawRefs.map((entry) => {
    if (!isRecord(entry)) throw new TopicError(400, "主题节点初始记忆引用无效");
    return { entryId: text(entry.entryId, "initialMemoryRef.entryId", 200), source: parseMemorySource(entry.source, "initialMemoryRef.source") };
  });
  const parentInputs = input.parents ?? [];
  const parents = normalizeParentSpecs(parentInputs);
  const requestFingerprint = input.requestFingerprint === undefined || input.requestFingerprint === null
    ? null
    : text(input.requestFingerprint, "requestFingerprint", 200);
  const digest = nodeCreationDigest({ topicId, sessionId, title, createdBy: input.createdBy, frozenProjectContext, initialMemoryRefs, parents, requestFingerprint });
  const nodeId = topicNodeIdOf(topicId, sessionId);
  // Source validation runs OUTSIDE the graph lock: a source guard must never recover a pending
  // lifecycle operation while the graph lock is held (that recovery converges the topic graph and would
  // re-enter this lock). A replay of an already registered node skips it, exactly as before.
  const preflight = await readTopicGraph(input.chatHome, input.longAgentId);
  if (!preflight.nodes.some((node) => node.nodeId === nodeId || node.createdByRequestId === requestId)) {
    await requireTopicSources({ chatHome: input.chatHome, sources: [
      ...initialMemoryRefs.map((ref) => ref.source),
      ...parents.flatMap((parent) => parent.memoryRefs),
    ] });
  }
  return changeTopicGraph(input.chatHome, input.longAgentId, async (state) => {
    // The request id is the retry identity for the whole four-step creation (session reservation,
    // summary, initial memory, graph registration): a retry with the same id returns the same node,
    // and the same id with different inputs is a conflict instead of a second node.
    const byRequest = state.nodes.find((node) => node.createdByRequestId === requestId);
    if (byRequest !== undefined) {
      if (byRequest.createdByRequestDigest === digest) return { node: { ...byRequest }, graph: snapshot(state), created: false };
      if (byRequest.createdByRequestDigest === null)
        throw new TopicError(409, `节点登记早于创建摘要，无法判定是否为同一请求：${sessionId}`);
      throw new TopicError(409, `该 requestId 已用于不同的节点创建：${requestId}`);
    }
    const existing = state.nodes.find((node) => node.nodeId === nodeId);
    if (existing !== undefined) {
      // Same topic+session but a different creation request (title, anchors, initial sources, ...).
      if (existing.createdByRequestDigest === digest) return { node: { ...existing }, graph: snapshot(state), created: false };
      if (existing.createdByRequestDigest === null)
        throw new TopicError(409, `节点登记早于创建摘要，无法判定是否为同一请求：${sessionId}`);
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
      sessionMemory: input.sessionMemory === "off" ? "off" : "on",
      createdBy: input.createdBy, createdByRequestId: requestId, createdByRequestDigest: digest, initialMemoryRefs,
      createdAt: now, updatedAt: now,
    };
    state.nodes.push(node);
    state.edges.push(...edges);
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
  const normalized = normalizeParentSpecs([input])[0]!;
  const existingEdge = (
    edge: TopicEdgeRecord,
    state: { schemaVersion: 1; longAgentId: string; revision: number; topics: readonly TopicRecord[]; nodes: readonly TopicNodeRecord[]; edges: readonly TopicEdgeRecord[] },
  ): { edge: TopicEdgeRecord; graph: TopicGraphState; created: boolean } => {
    if (!sameParentEdgeSpec(edge, normalized))
      throw new TopicError(409, `该父边已存在且规格不同（锚点或记忆引用不一致）：${normalized.parentNodeId}`);
    return { edge: { ...edge }, graph: snapshot(state), created: false };
  };
  // Pre-flight OUTSIDE the graph lock (the orchestration uses session-lock -> graph-lock order, and
  // this path must not invert it): only an identical edge is a replay, and a NEW edge needs a settled
  // anchor verified inside the parent's session lock.
  const preflightGraph = await readTopicGraph(input.chatHome, input.longAgentId);
  const preflightChild = preflightGraph.nodes.find((node) => node.nodeId === childNodeId);
  if (preflightChild === undefined) throw new TopicError(404, `找不到子节点：${childNodeId}`);
  const preflightExisting = preflightGraph.edges.find((edge) => edge.parentNodeId === normalized.parentNodeId && edge.childNodeId === childNodeId);
  if (preflightExisting !== undefined) return existingEdge(preflightExisting, preflightGraph);
  await verifyParentAnchors({ chatHome: input.chatHome, longAgentId: input.longAgentId, graph: preflightGraph, parents: [input] });
  await requireTopicSources({ chatHome: input.chatHome, sources: normalized.memoryRefs });
  return changeTopicGraph(input.chatHome, input.longAgentId, async (state) => {
    const child = state.nodes.find((node) => node.nodeId === childNodeId);
    if (child === undefined) throw new TopicError(404, `找不到子节点：${childNodeId}`);
    if (child.status !== "active") throw new TopicError(409, "节点已归档或移除，不能接受新的整合");
    const existing = state.edges.find((edge) => edge.parentNodeId === normalized.parentNodeId && edge.childNodeId === childNodeId);
    if (existing !== undefined) return existingEdge(existing, state);
    assertRevision(state, input.expectedRevision);
    const now = input.now ?? new Date().toISOString();
    const edge = parseParentEdge(normalized, state, childNodeId, child.topicId, now);
    state.edges.push(edge);
    state.revision += 1;
    return { edge: { ...edge }, graph: snapshot(state), created: true };
  });
}

/**
 * Mirrors a Session lifecycle change onto its topic node. This is the ONLY writer allowed to leave the
 * `removed` state: it reflects what happened to the session file (the user/agent-facing
 * `updateTopicNodeStatus` keeps `removed` terminal). Edges are always kept so provenance survives.
 * Not a topic node -> no-op (ordinary project sessions and non-topic agent sessions are unaffected).
 */
export async function applyTopicNodeSessionLifecycle(input: {
  chatHome: string;
  longAgentId: string;
  sessionId: string;
  state: "removed" | "active";
}): Promise<{ node: TopicNodeRecord; graph: TopicGraphState } | null> {
  return changeTopicGraph(input.chatHome, input.longAgentId, (state) => {
    const node = state.nodes.find((candidate) => candidate.sessionId === input.sessionId);
    if (node === undefined) return null;
    if (node.status === input.state) return { node: { ...node }, graph: snapshot(state) };
    node.status = input.state;
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

/**
 * 「会话记忆」switch for one node. Turning it off means the next rounds run as ordinary agent turns:
 * no read Skill/tool is assembled and no writer stage runs (no node type changes).
 */
export async function setTopicNodeSessionMemory(input: {
  chatHome: string;
  longAgentId: string;
  nodeId: string;
  enabled: boolean;
  expectedRevision: unknown;
}): Promise<TopicNodeRecord> {
  return changeTopicGraph(input.chatHome, input.longAgentId, (state) => {
    const node = state.nodes.find((candidate) => candidate.nodeId === input.nodeId);
    if (node === undefined) throw new TopicError(404, `找不到主题节点：${input.nodeId}`);
    if (node.status === "removed") throw new TopicError(409, "节点已移除，不能修改会话记忆开关");
    const next = input.enabled ? "on" : "off";
    if (node.sessionMemory === next) return { ...node };
    assertRevision(state, input.expectedRevision);
    node.sessionMemory = next;
    node.updatedAt = new Date().toISOString();
    state.revision += 1;
    return { ...node };
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
  // Status changes take the TARGET SESSION's operation lock before the graph lock (session -> graph, the
  // same order as creation and relay), so archiving and a relayed append are mutually exclusive and a
  // node cannot be archived between a relay's status re-check and its append.
  const current = await readTopicGraph(input.chatHome, input.longAgentId);
  const node = current.nodes.find((candidate) => candidate.nodeId === input.nodeId);
  if (node === undefined) throw new TopicError(404, `找不到主题节点：${input.nodeId}`);
  return withChatSessionOperationLock(chatSessionOperationKey(input.longAgentId, node.sessionId), async () =>
    changeTopicGraph(input.chatHome, input.longAgentId, (state) => {
      const target = state.nodes.find((candidate) => candidate.nodeId === input.nodeId);
      if (target === undefined) throw new TopicError(404, `找不到主题节点：${input.nodeId}`);
      if (target.status === "removed") throw new TopicError(409, "节点已移除，不能改回可用状态");
      assertRevision(state, input.expectedRevision);
      target.status = input.status;
      target.updatedAt = new Date().toISOString();
      state.revision += 1;
      return { ...target };
    }));
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

/**
 * Node-creation orchestration: session -> integration summary -> initial session memory -> graph
 * registration, all sharing one `requestId`.
 *
 * Every step is replayable on its own: the session id is derived, the summary is deduplicated by the
 * request marker, the initial memory entry is adopted when an identical bootstrap entry already exists,
 * and the graph registration is request-idempotent (creation digest). The whole flow is serialized on a
 * request-scoped file lock — NOT on the session operation lock, which `ensureChatSessionWithId` already
 * takes internally and which is not re-entrant.
 */
export const TOPIC_INTEGRATION_SUMMARY_CUSTOM_TYPE = "chat.topic-integration-summary";
export const TOPIC_RELAY_CUSTOM_TYPE = "chat.topic-relay";

export interface CreateTopicNodeWithSessionInput {
  readonly chatHome: string;
  readonly longAgentId: string;
  readonly topicId: unknown;
  readonly requestId: unknown;
  readonly title: unknown;
  readonly createdBy: "user" | "agent";
  readonly frozenProjectContext?: unknown;
  /** 「会话记忆」switch for the new node; default on. */
  readonly sessionMemory?: unknown;
  /** Integration product text, appended as a CustomMessage so it enters the child's context. */
  readonly integrationSummary?: unknown;
  /**
   * Provenance list: one entry per source, so a node built from several sessions records ALL of them.
   * `content` overrides the shared bootstrap text for that source.
   */
  readonly sources?: readonly { readonly source: unknown; readonly content?: unknown }[] | undefined;
  /** Shared bootstrap text; used for a source without its own `content`. */
  readonly initialMemory?: { readonly content: unknown; readonly originEntryId?: unknown } | undefined;
  /** Legacy single-source convenience; equivalent to `sources: [{ source, content }]`. */
  readonly source?: TopicMemorySource | null;
  readonly parents?: readonly CreateTopicNodeParentInput[];
  readonly now?: string;
}

export interface TopicNodeCreationResult {
  readonly node: TopicNodeRecord;
  readonly sessionId: string;
  readonly created: boolean;
  readonly summaryEntryId: string | null;
  /** First bootstrap entry (kept for single-source callers). */
  readonly memoryEntryId: string | null;
  readonly memoryEntryIds: readonly string[];
  readonly graph: TopicGraphState;
}

function messageTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n");
}

function memoryEntryIdForRevision(state: { revision: number; entries: readonly { entryId: string }[] }): string | null {
  const prefix = `smem-${String(state.revision).padStart(4, "0")}-`;
  return state.entries.find((entry) => entry.entryId.startsWith(prefix))?.entryId ?? null;
}

/**
 * Resolves one memory source address before it is recorded. A `TopicMemorySource` addresses a SESSION
 * MEMORY entry (`smem-...`), not a Pi transcript entry: full-text Pi addresses are a different
 * namespace and stay where they belong (an edge's `anchorEntryId`).
 *
 * Range: only Long Agent homes are valid sources (the topic contract's cross-agent/cross-tree READ of
 * session memory). A plain Project session has no topic graph, so `authorizeTopicSession` cannot judge
 * it — `applicable: false` is NOT an allow; such sources must go through that project's own explicit
 * authorization, which this domain service does not have, so they are refused.
 */
async function requireTopicMemorySource(input: {
  chatHome: string;
  source: TopicMemorySource;
}): Promise<void> {
  const { source } = input;
  let context;
  try {
    context = await resolveProjectContext(source.storageProjectId, input.chatHome);
  } catch {
    throw new TopicError(404, `来源项目不存在：${source.storageProjectId}`);
  }
  if (context.kind !== "agent") throw new TopicError(403, "来源必须是 Long Agent 归属的会话记忆，普通项目会话需走其自身授权");
  // A removed source is readable provenance but no longer an integration source (taskbook 3#9).
  const active = (await listActiveSessionFiles(context)).some((candidate) => candidate.id === source.sessionId);
  if (!active) {
    const inactive = await readInactiveChatSessionState(context, source.sessionId);
    if (inactive === "pending")
      throw new TopicError(409, `来源会话的生命周期操作尚未完成，请稍后重试：${source.sessionId}`);
    if (inactive === "removed") throw new TopicError(409, `来源会话已移除，不能作为整合来源：${source.sessionId}`);
    throw new TopicError(404, `来源会话记忆不存在或不可读：${source.storageProjectId}/${source.sessionId}`);
  }
  let memory;
  try {
    memory = await readSessionMemory(input.chatHome, source.storageProjectId, source.sessionId);
  } catch {
    throw new TopicError(404, `来源会话记忆不存在或不可读：${source.storageProjectId}/${source.sessionId}`);
  }
  const entry = memory.entries.find((candidate) => candidate.entryId === source.entryId);
  if (entry === undefined) throw new TopicError(404, `来源会话记忆条目不存在：${source.entryId}`);
  if (entry.status !== "active") throw new TopicError(409, `来源会话记忆条目已被推翻：${source.entryId}`);
  // An archived topic node is read-only provenance: it may not feed new integration (taskbook 3#9).
  const graph = await readTopicGraph(input.chatHome, source.storageProjectId);
  const node = graph.nodes.find((candidate) => candidate.sessionId === source.sessionId);
  if (node !== undefined && node.status !== "active")
    throw new TopicError(409, `来源主题节点已归档或移除，不能作为整合来源：${node.nodeId}`);
}

/** Every recorded source address is resolved through the same gate, whatever carried it here. */
async function requireTopicSources(input: {
  chatHome: string;
  sources: readonly TopicMemorySource[];
}): Promise<void> {
  const seen = new Set<string>();
  for (const source of input.sources) {
    const key = JSON.stringify([source.storageProjectId, source.sessionId, source.entryId]);
    if (seen.has(key)) continue;
    seen.add(key);
    await requireTopicMemorySource({ chatHome: input.chatHome, source });
  }
}

/** Canonical fingerprint of the orchestration inputs; folded into the node creation digest. */
function topicCreationFingerprint(spec: {
  title: string;
  createdBy: "user" | "agent";
  frozenProjectContext: string | null;
  summary: string | null;
  memory: { content: string; originEntryId: string | null } | null;
  sources: readonly { source: TopicMemorySource; content: string }[];
  parents: readonly NormalizedParentSpec[];
}): string {
  const canonical = JSON.stringify([
    spec.title, spec.createdBy, spec.frozenProjectContext, spec.summary,
    spec.memory === null ? null : [spec.memory.content, spec.memory.originEntryId],
    sortCanonical(spec.sources, (candidate) => `${canonicalSource(candidate.source)}|${candidate.content}`)
      .map((candidate) => [canonicalSource(candidate.source), candidate.content]),
    sortCanonical(spec.parents, canonicalParent).map(canonicalParent),
  ]);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** Anchors are verified against the PARENT session while its operation lock is held. */
async function verifyParentAnchors(input: {
  chatHome: string;
  longAgentId: string;
  graph: TopicGraphState;
  parents: readonly CreateTopicNodeParentInput[];
}): Promise<void> {
  for (const parent of input.parents) {
    const parentNode = input.graph.nodes.find((node) => node.nodeId === parent.parentNodeId);
    if (parentNode === undefined) continue; // createTopicNode reports the missing parent
    await withChatSessionOperationLock(chatSessionOperationKey(input.longAgentId, parentNode.sessionId), async () => {
      let session;
      try {
        session = await openChatSession({ chatHome: input.chatHome, projectId: input.longAgentId, sessionId: parentNode.sessionId });
      } catch (error) {
        if (parent.anchorEntryId === undefined || parent.anchorEntryId === null) return;
        throw error;
      }
      try {
        requireTopicAnchor(session.manager, {
          anchorEntryId: parent.anchorEntryId ?? null,
          anchorSequence: parent.anchorSequence ?? null,
        });
      } catch (error) {
        if (error instanceof TopicAnchorError) throw new TopicError(error.statusCode, error.message);
        throw error;
      }
    });
  }
}

export async function createTopicNodeWithSession(input: CreateTopicNodeWithSessionInput): Promise<TopicNodeCreationResult> {
  const chatHome = input.chatHome;
  const longAgentId = input.longAgentId;
  const topicId = identity(input.topicId, "topicId", TOPIC_ID_PATTERN);
  const requestId = text(input.requestId, "requestId", 200);
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new TopicError(400, "主题requestId格式无效");
  const title = text(input.title, "title", 200);
  const sessionId = topicNodeSessionIdOf(topicId, requestId);
  const parents = input.parents ?? [];
  const summary = input.integrationSummary === undefined || input.integrationSummary === null
    ? null
    : text(input.integrationSummary, "integrationSummary", 20_000);
  const memory = input.initialMemory === undefined || input.initialMemory === null
    ? null
    : { content: text(input.initialMemory.content, "initialMemory.content", 4_000),
        originEntryId: optionalText(input.initialMemory.originEntryId, "initialMemory.originEntryId", 200) };
  const rawSources = input.sources ?? (input.source === undefined || input.source === null ? [] : [{ source: input.source }]);
  if (!Array.isArray(rawSources)) throw new TopicError(400, "主题来源列表无效");
  // Each source gets its own bootstrap entry (when contents differ), and every (entry, source) pair is
  // recorded in the graph, so multi-session integration stays fully traceable.
  const sources = rawSources.map((candidate) => {
    if (!isRecord(candidate)) throw new TopicError(400, "主题来源列表无效");
    const parsed = parseMemorySource(candidate.source, "source");
    const override = candidate.content === undefined || candidate.content === null ? null : text(candidate.content, "source.content", 4_000);
    const content = override ?? memory?.content ?? null;
    if (content === null) throw new TopicError(400, "初始记忆必须带来源地址与内容");
    return { source: parsed, content };
  });
  if (memory !== null && sources.length === 0) throw new TopicError(400, "初始记忆必须带来源地址");
  const frozenProjectContext = optionalText(input.frozenProjectContext, "frozenProjectContext", 200);
  if (input.sessionMemory !== undefined && input.sessionMemory !== "on" && input.sessionMemory !== "off")
    throw new TopicError(400, "节点会话记忆开关无效");
  // The creation digest covers the orchestration inputs too, so a replay with a changed title, summary,
  // anchor or bootstrap memory is a conflict rather than a silent success.
  const fingerprint = topicCreationFingerprint({
    title, createdBy: input.createdBy, frozenProjectContext, summary, memory, sources, parents: normalizeParentSpecs(parents),
  });
  const graphFile = topicGraphFile(chatHome, longAgentId);
  return withFileLock(`${graphFile}.node-request-${requestId}`, async () => {
    const current = await readTopicGraph(chatHome, longAgentId);
    const registered = current.nodes.find((node) => node.createdByRequestId === requestId);
    let ensuredSummaryEntryId: string | null = null;
    if (registered === undefined) {
      // Sources only have to be readable for the FIRST registration: once the node exists, an identical
      // replay must return it even if a source session was removed in the meantime.
      await requireTopicSources({ chatHome, sources: sources.map((candidate) => candidate.source) });
      await verifyParentAnchors({ chatHome, longAgentId, graph: current, parents });
      const ensured = await ensureChatSessionWithId({ chatHome, projectId: longAgentId }, sessionId, title);
      // The session lock is taken AFTER ensureChatSessionWithId released it (not re-entrant).
      await withChatSessionOperationLock(chatSessionOperationKey(longAgentId, sessionId), async () => {
        if (summary !== null) {
          const existing = ensured.session.manager.getEntries().find((entry) => entry.type === "custom_message"
            && entry.customType === TOPIC_INTEGRATION_SUMMARY_CUSTOM_TYPE
            && isRecord(entry.details) && entry.details.requestId === requestId);
          if (existing !== undefined) {
            // Same request id, different summary text: this request is not the one that wrote it.
            const details: Record<string, unknown> = isRecord((existing as { details?: unknown }).details)
              ? (existing as unknown as { details: Record<string, unknown> }).details : {};
            if (details.requestFingerprint !== fingerprint)
              throw new TopicError(409, `该 requestId 已写入不同的整合摘要：${requestId}`);
            ensuredSummaryEntryId = existing.id;
          } else {
            ensuredSummaryEntryId = ensured.session.manager.appendCustomMessageEntry(
              TOPIC_INTEGRATION_SUMMARY_CUSTOM_TYPE, summary, false, { requestId, topicId, sessionId, requestFingerprint: fingerprint });
            ensured.session.manager.flush();
          }
        }
        if (sources.length > 0) {
          // One entry per distinct bootstrap content. The WHOLE request is frozen by its first entry
          // (writeRequestFingerprint), so an interrupted request is completed with the same content and
          // a retry that changed the request is a conflict instead of a second, partially mixed write.
          const contents = [...new Set(sources.map((candidate) => candidate.content))];
          for (const content of contents) {
            const state = await readSessionMemory(chatHome, longAgentId, sessionId);
            const linked = state.entries.find((entry) => entry.writeRequestId === requestId && entry.content === content);
            if (linked !== undefined) {
              if (linked.purpose !== "background" || linked.author !== input.createdBy
                || linked.writeRequestFingerprint !== fingerprint
                || (memory?.originEntryId ?? null) !== linked.originEntryId)
                throw new TopicError(409, `该 requestId 已写入不同的初始记忆：${requestId}`);
              continue;
            }
            const written = await writeSessionMemoryEntry({ chatHome, longAgentId, sessionId, operation: "write",
              purpose: "background", author: input.createdBy, content, writeRequestId: requestId,
              writeRequestFingerprint: fingerprint,
              originEntryId: memory?.originEntryId ?? null, expectedRevision: state.revision,
              ...(input.now === undefined ? {} : { now: input.now }) });
            if (memoryEntryIdForRevision(written) === null) throw new TopicError(500, "初始会话记忆写入未返回条目");
          }
        }
      });
    }
    // Registration retries only on a graph revision conflict: the durable writes above are replayable,
    // so a fresh revision is the whole fix. On the registered path this call is also the identity
    // check, because the creation digest covers the orchestration fingerprint.
    for (let attempt = 0; ; attempt += 1) {
      const graph = await readTopicGraph(chatHome, longAgentId);
      const requestEntries = (await readSessionMemory(chatHome, longAgentId,
        graph.nodes.find((node) => node.createdByRequestId === requestId)?.sessionId ?? sessionId))
        .entries.filter((entry) => entry.writeRequestId === requestId);
      const initialMemoryRefs: TopicNodeInitialMemoryRef[] = sources.flatMap((candidate) => {
        const entry = requestEntries.find((value) => value.content === candidate.content);
        return entry === undefined ? [] : [{ entryId: entry.entryId, source: candidate.source }];
      });
      try {
        const registeredNode = await createTopicNode({
          chatHome, longAgentId, topicId, title, createdBy: input.createdBy, requestId, expectedRevision: graph.revision,
          ...(input.sessionMemory === undefined ? {} : { sessionMemory: input.sessionMemory }),
          initialMemoryRefs, parents, requestFingerprint: fingerprint,
          ...(frozenProjectContext === null ? {} : { frozenProjectContext }),
          ...(input.now === undefined ? {} : { now: input.now }),
        });
        return { node: registeredNode.node, sessionId: registeredNode.node.sessionId, created: registeredNode.created,
          summaryEntryId: ensuredSummaryEntryId,
          memoryEntryId: initialMemoryRefs[0]?.entryId ?? null,
          memoryEntryIds: initialMemoryRefs.map((ref) => ref.entryId), graph: registeredNode.graph };
      } catch (error) {
        const retryable = error instanceof TopicError && error.statusCode === 409 && attempt < TOPIC_GRAPH_CAS_ATTEMPTS
          && (error.message.includes("revision") || error.message.includes("已修改"));
        if (!retryable) throw error;
      }
    }
  });
}

/**
 * Runs a graph mutation that needs the current revision, retrying ONLY on a revision conflict. Callers
 * that write through a domain primitive (create a topic, add an edge, change a status) do not hold the
 * graph lock, so a concurrent writer can bump the revision between read and write.
 */
export async function withTopicGraphRevision<T>(
  chatHome: string,
  longAgentId: string,
  operation: (expectedRevision: number) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const graph = await readTopicGraph(chatHome, longAgentId);
    try {
      return await operation(graph.revision);
    } catch (error) {
      const retryable = error instanceof TopicError && error.statusCode === 409 && attempt < TOPIC_GRAPH_CAS_ATTEMPTS
        && (error.message.includes("revision") || error.message.includes("已修改"));
      if (!retryable) throw error;
    }
  }
}

/**
 * Relay: hand content to one node of the same Long Agent's tree, as a REAL user message.
 *
 * ONE native user message is appended, carrying its own durable request association in a Chat-owned
 * field (`message.chatTopicRelay`), which Pi round-trips verbatim (`parseSessionEntryLine` is a plain
 * JSON.parse). That gives three properties at once: there is no "message written but association
 * missing" window; recovery matches the association EXACTLY instead of guessing from the text (an
 * unrelated user message with the same text is never claimed); and the entry is a real user message,
 * so a later node round can settle and fork from it.
 *
 * The append happens inside the node session's operation lock with the node status and authorization
 * re-checked next to it, and status changes take the same lock (see updateTopicNodeStatus), so an
 * archived node can never receive a relayed message.
 */
export async function relayTopicNodeMessage(input: {
  readonly chatHome: string;
  readonly longAgentId: string;
  readonly nodeId: unknown;
  readonly requestId: unknown;
  readonly text: unknown;
}): Promise<{ readonly nodeId: string; readonly sessionId: string; readonly entryId: string; readonly created: boolean }> {
  const nodeId = identity(input.nodeId, "nodeId", NODE_ID_PATTERN);
  const requestId = text(input.requestId, "requestId", 200);
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new TopicError(400, "主题requestId格式无效");
  const body = text(input.text, "text", 20_000);
  const textDigest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  const graph = await readTopicGraph(input.chatHome, input.longAgentId);
  const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (node === undefined) throw new TopicError(404, `找不到主题节点：${nodeId}`);
  const requireRelayable = (current: TopicGraphState): void => {
    const target = current.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (target === undefined) throw new TopicError(404, `找不到主题节点：${nodeId}`);
    const decision = authorizeTopicSession({ graph: current, requester: { kind: "agent", longAgentId: input.longAgentId },
      sessionId: target.sessionId, capability: "relay" });
    if (!decision.applicable || !decision.allowed) throw new TopicError(403, decision.reason ?? "只能代传自己名下主题树的节点");
  };
  requireRelayable(graph);
  return withChatSessionOperationLock(chatSessionOperationKey(input.longAgentId, node.sessionId), async () => {
    // Re-check next to the append: an archived node must not receive a relayed message.
    requireRelayable(await readTopicGraph(input.chatHome, input.longAgentId));
    const session = await openChatSession({ chatHome: input.chatHome, projectId: input.longAgentId, sessionId: node.sessionId });
    // Dedupe over the WHOLE session file, not just the current branch: an intra-session branch switch
    // must not let the same request append a second relayed message.
    const existing = session.manager.getEntries().find((entry) => {
      const message = (entry as { type?: string; message?: unknown }).message;
      if ((entry as { type?: string }).type !== "message" || !isRecord(message)) return false;
      return relayAssociationOf(message)?.requestId === requestId;
    });
    if (existing !== undefined) {
      const association = relayAssociationOf((existing as unknown as { message: Record<string, unknown> }).message)!;
      if (association.targetNodeId !== nodeId || association.textDigest !== textDigest)
        throw new TopicError(409, `该 requestId 已用于不同的代传内容或节点：${requestId}`);
      const onCurrentBranch = session.manager.getBranch().some((entry) => (entry as { id?: unknown }).id === (existing as { id: string }).id);
      // The message exists but the conversation moved on: appending again would duplicate the request,
      // and silently reporting success would hide that the current branch never received it.
      if (!onCurrentBranch)
        throw new TopicError(409, `该 requestId 的代传消息不在当前分支，不能重复追加：${requestId}`);
      return { nodeId, sessionId: node.sessionId, entryId: (existing as { id: string }).id, created: false };
    }
    const entryId = session.manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: body }],
      timestamp: Date.now(),
      chatTopicRelay: { requestId, targetNodeId: nodeId, relayedByLongAgentId: input.longAgentId, source: "relay", textDigest },
    } as never);
    session.manager.flush();
    return { nodeId, sessionId: node.sessionId, entryId, created: true };
  });
}

/** Reads the Chat-owned relay association off a native user message, if present. */
export function relayAssociationOf(message: Record<string, unknown>): { requestId: string; targetNodeId: string; textDigest: string } | null {
  const value = message.chatTopicRelay;
  if (!isRecord(value)) return null;
  const requestId = typeof value.requestId === "string" ? value.requestId : null;
  const targetNodeId = typeof value.targetNodeId === "string" ? value.targetNodeId : null;
  const textDigest = typeof value.textDigest === "string" ? value.textDigest : null;
  return requestId === null || targetNodeId === null || textDigest === null ? null : { requestId, targetNodeId, textDigest };
}
