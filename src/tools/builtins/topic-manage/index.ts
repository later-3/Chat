import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { appendChatUserMessage } from "../../../workflows/session-conversation.js";
import { openChatSession } from "../../../chat-session.js";
import { resolveProjectContext } from "../../../projects/registry.js";
import { readSessionMemory } from "../../../long-agents/session-memory.js";
import {
  addTopicNodeParent,
  authorizeTopicSession,
  createTopic,
  createTopicNodeWithSession,
  readTopicGraph,
  updateTopicNodeStatus,
  withTopicGraphRevision,
} from "../../../long-agents/topics.js";
import type { ChatToolProvider } from "../../framework.js";
import { defineChatSystemTool } from "../../framework.js";
import manifest from "./tool.json" with { type: "json" };

export const TOPIC_RELAY_CUSTOM_TYPE = "chat.topic-relay";

function result(details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

function text(value: unknown, label: string, max = 4_000): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new Error(`${label}无效`);
  return value.trim();
}

function optionalText(value: unknown, label: string, max = 4_000): string | null {
  return value === undefined || value === null ? null : text(value, label, max);
}

function entryText(content: unknown, limit = 600): string {
  if (typeof content === "string") return content.slice(0, limit);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const value = block as { type?: unknown; text?: unknown };
    if (value.type === "text" && typeof value.text === "string") parts.push(value.text);
  }
  return parts.join("\n").slice(0, limit);
}

/**
 * Topic management for a Long Agent's own theme trees.
 *
 * Identity is the trusted `toolContext.longAgentId`, never a tool argument. Every read of another
 * agent's tree goes through the shared `authorizeTopicSession` decision (cross-tree reads are allowed;
 * relay and writes are limited to the caller's own tree/home), and every write goes through the
 * already validated domain services, so this tool adds no source, anchor or idempotency logic of its
 * own. Sources are addressed as session-memory entries `{storageProjectId, sessionId, entryId}`.
 */
export const TOPIC_MANAGE_TOOL_PROVIDER: ChatToolProvider = defineChatSystemTool(
  manifest,
  (context) => defineTool({
    name: manifest.name,
    label: manifest.label,
    description: manifest.description,
    executionMode: "sequential",
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("read_graph"), Type.Literal("read_node"), Type.Literal("read_memory"), Type.Literal("read_fulltext"),
        Type.Literal("create_topic"), Type.Literal("create_node"), Type.Literal("add_parent"),
        Type.Literal("update_node_status"), Type.Literal("relay"),
      ]),
      topicId: Type.Optional(Type.String({ description: "read_graph(可选过滤)/read_node/create_node/add_parent/relay：主题 id" })),
      nodeId: Type.Optional(Type.String({ description: "read_node/add_parent/update_node_status/relay：节点 id" })),
      targetNodeId: Type.Optional(Type.String({ description: "relay：接收节点 id" })),
      requestId: Type.Optional(Type.String({ description: "create_topic/create_node/relay：幂等请求 id" })),
      title: Type.Optional(Type.String({ description: "create_topic/create_node：标题" })),
      purpose: Type.Optional(Type.String({ description: "create_topic：主题目的" })),
      integrationSummary: Type.Optional(Type.String({ description: "create_node：整合摘要（进入子节点上下文）" })),
      memoryContent: Type.Optional(Type.String({ description: "create_node：初始 background 会话记忆内容" })),
      source: Type.Optional(Type.Object({
        storageProjectId: Type.String(), sessionId: Type.String(), entryId: Type.String(),
      }, { description: "create_node/add_parent：来源会话记忆地址" })),
      sourceSessionId: Type.Optional(Type.String({ description: "read_memory/read_fulltext：要读取的会话 id" })),
      sourceProjectId: Type.Optional(Type.String({ description: "read_memory/read_fulltext：该会话的存储项目（默认本 agent home）" })),
      parentNodeId: Type.Optional(Type.String({ description: "add_parent：父节点 id" })),
      parents: Type.Optional(Type.Array(Type.Object({
        nodeId: Type.String(),
        anchorEntryId: Type.Optional(Type.String()),
        anchorSequence: Type.Optional(Type.Number()),
      }), { description: "create_node：父边列表；给出锚点时必须同时给 anchorEntryId 与 anchorSequence" })),
      anchorEntryId: Type.Optional(Type.String({ description: "add_parent：父会话已 settled 的用户 entry" })),
      anchorSequence: Type.Optional(Type.Number({ description: "add_parent：该锚点在父会话的分叉序号" })),
      status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("archived")], { description: "update_node_status" })),
      text: Type.Optional(Type.String({ description: "relay：要代传的内容" })),
      limit: Type.Optional(Type.Number({ description: "read_fulltext：返回最近条数（默认 20，最大 50）" })),
    }),
    async execute(_toolCallId, params) {
      if (context.purpose !== "execution") throw new Error("检查模式不能访问主题");
      const longAgentId = context.longAgentId;
      if (longAgentId === undefined) throw new Error("topic_manage 只服务于 Long Agent 身份的执行上下文");
      const chatHome = context.chatHome;
      const record = params as Record<string, unknown>;
      const operation = String(record.operation);

      /** Reads of a session that may belong to another agent's tree go through the shared decision. */
      const requireReadable = async (storageProjectId: string, sessionId: string): Promise<void> => {
        // Session memory only exists for Long Agent homes; a plain Project session has no topic graph,
        // so `applicable:false` there is not an allow.
        const project = await resolveProjectContext(storageProjectId, chatHome);
        if (project.kind !== "agent") throw new Error("会话记忆只存在于 Long Agent 归属的会话；普通项目会话请用其自身工具读取");
        const graph = await readTopicGraph(chatHome, storageProjectId);
        const decision = authorizeTopicSession({ graph, requester: { kind: "agent", longAgentId }, sessionId, capability: "read" });
        if (decision.applicable && !decision.allowed) throw new Error(decision.reason ?? "没有读取该会话的权限");
      };

      if (operation === "read_graph") {
        const graph = await readTopicGraph(chatHome, longAgentId);
        const topicId = optionalText(record.topicId, "topicId");
        const topics = graph.topics.filter((topic) => topicId === null || topic.topicId === topicId);
        return result({
          operation, revision: graph.revision,
          topics: topics.map((topic) => ({
            topicId: topic.topicId, title: topic.title, purpose: topic.purpose, status: topic.status,
            rootSessionId: topic.rootSessionId, createdAt: topic.createdAt,
            nodes: graph.nodes.filter((node) => node.topicId === topic.topicId)
              .map((node) => ({ nodeId: node.nodeId, sessionId: node.sessionId, title: node.title, status: node.status,
                initialMemoryRefs: node.initialMemoryRefs,
                parents: graph.edges.filter((edge) => edge.childNodeId === node.nodeId)
                  .map((edge) => ({ edgeId: edge.edgeId, parentNodeId: edge.parentNodeId, anchorEntryId: edge.anchorEntryId, anchorSequence: edge.anchorSequence, memoryRefs: edge.memoryRefs })) })),
          })),
        });
      }

      if (operation === "read_node") {
        const nodeId = text(record.nodeId, "nodeId");
        const graph = await readTopicGraph(chatHome, longAgentId);
        const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId);
        if (node === undefined) throw new Error(`找不到主题节点：${nodeId}`);
        return result({
          operation, revision: graph.revision,
          node: { ...node, topic: graph.topics.find((topic) => topic.topicId === node.topicId)?.title ?? null },
          parents: graph.edges.filter((edge) => edge.childNodeId === nodeId),
          children: graph.edges.filter((edge) => edge.parentNodeId === nodeId).map((edge) => edge.childNodeId),
        });
      }

      if (operation === "read_memory") {
        const sessionId = text(record.sourceSessionId, "sourceSessionId");
        const storageProjectId = optionalText(record.sourceProjectId, "sourceProjectId") ?? longAgentId;
        await requireReadable(storageProjectId, sessionId);
        const memory = await readSessionMemory(chatHome, storageProjectId, sessionId);
        return result({
          operation, storageProjectId, sessionId, revision: memory.revision, orphan: memory.orphan,
          entries: memory.entries.map((entry) => ({ ...entry, source: { storageProjectId, sessionId, entryId: entry.entryId } })),
        });
      }

      if (operation === "read_fulltext") {
        const sessionId = text(record.sourceSessionId, "sourceSessionId");
        const storageProjectId = optionalText(record.sourceProjectId, "sourceProjectId") ?? longAgentId;
        await requireReadable(storageProjectId, sessionId);
        const limit = Number.isSafeInteger(record.limit) ? Math.min(Math.max(Number(record.limit), 1), 50) : 20;
        const session = await openChatSession({ chatHome, projectId: storageProjectId, sessionId });
        const entries = session.manager.getBranch().slice(-limit).map((entry) => {
          const value = entry as { id: string; parentId?: string | null; type: string; message?: unknown; customType?: unknown };
          const message = (value.type === "message" ? value.message : undefined) as { role?: unknown; content?: unknown } | undefined;
          return { entryId: value.id, parentId: value.parentId ?? null, kind: value.type,
            role: typeof message?.role === "string" ? message.role : null, customType: typeof value.customType === "string" ? value.customType : null,
            text: message === undefined ? "" : entryText(message.content) };
        });
        return result({ operation, storageProjectId, sessionId, entries });
      }

      if (operation === "create_topic") {
        const requestId = text(record.requestId, "requestId", 200);
        const title = text(record.title, "title", 200);
        const purpose = text(record.purpose, "purpose", 2_000);
        const created = await withTopicGraphRevision(chatHome, longAgentId, (expectedRevision) => createTopic({
          chatHome, longAgentId, title, purpose, requestId, expectedRevision,
        }));
        return result({ operation, created: created.created, topic: created.topic });
      }

      if (operation === "create_node") {
        const topicId = text(record.topicId, "topicId", 200);
        const requestId = text(record.requestId, "requestId", 200);
        const title = text(record.title, "title", 200);
        const source = record.source === undefined ? null : record.source as { storageProjectId?: unknown; sessionId?: unknown; entryId?: unknown };
        const sourceRef = source === null ? null : { storageProjectId: text(source.storageProjectId, "source.storageProjectId", 200),
          sessionId: text(source.sessionId, "source.sessionId", 200), entryId: text(source.entryId, "source.entryId", 200) };
        const parentInputs = Array.isArray(record.parents) ? record.parents as readonly Record<string, unknown>[] : [];
        const integrationSummary = optionalText(record.integrationSummary, "integrationSummary", 20_000);
        const memoryContent = optionalText(record.memoryContent, "memoryContent", 4_000);
        const created = await createTopicNodeWithSession({
          chatHome, longAgentId, topicId, requestId, title, createdBy: "agent",
          ...(integrationSummary === null ? {} : { integrationSummary }),
          ...(memoryContent === null ? {} : { initialMemory: { content: memoryContent, originEntryId: null } }),
          ...(sourceRef === null ? {} : { source: sourceRef }),
          parents: parentInputs.map((parent) => {
            const parentNodeId = text(parent.nodeId, "parent.nodeId", 200);
            const anchorEntryId = optionalText(parent.anchorEntryId, "parent.anchorEntryId", 200);
            const anchorSequence = parent.anchorSequence === undefined || parent.anchorSequence === null ? null : Number(parent.anchorSequence);
            // Anchors are frozen entry+sequence pairs; the domain service verifies them in the parent lock.
            if (anchorEntryId === null && anchorSequence !== null) throw new Error("父边锚点必须同时提供 anchorEntryId 与 anchorSequence");
            return { parentNodeId,
              ...(anchorEntryId === null ? {} : { anchorEntryId, anchorSequence }),
              ...(sourceRef === null ? {} : { memoryRefs: [sourceRef] }) };
          }),
        });
        return result({ operation, created: created.created, node: created.node, sessionId: created.sessionId,
          summaryEntryId: created.summaryEntryId, memoryEntryId: created.memoryEntryId });
      }

      if (operation === "add_parent") {
        const childNodeId = text(record.nodeId, "nodeId", 200);
        const parentNodeId = text(record.parentNodeId, "parentNodeId", 200);
        const anchorEntryId = optionalText(record.anchorEntryId, "anchorEntryId", 200);
        const anchorSequence = record.anchorSequence === undefined || record.anchorSequence === null ? null : Number(record.anchorSequence);
        if (anchorEntryId === null || anchorSequence === null) throw new Error("补边必须同时提供 anchorEntryId 与 anchorSequence");
        const source = record.source as { storageProjectId?: unknown; sessionId?: unknown; entryId?: unknown } | undefined;
        const added = await withTopicGraphRevision(chatHome, longAgentId, (expectedRevision) => addTopicNodeParent({
          chatHome, longAgentId, childNodeId, parentNodeId, anchorEntryId, anchorSequence, expectedRevision,
          ...(source === undefined ? {} : { memoryRefs: [{ storageProjectId: text(source.storageProjectId, "source.storageProjectId", 200),
            sessionId: text(source.sessionId, "source.sessionId", 200), entryId: text(source.entryId, "source.entryId", 200) }] }),
        }));
        return result({ operation, created: added.created, edge: added.edge });
      }

      if (operation === "update_node_status") {
        const nodeId = text(record.nodeId, "nodeId", 200);
        const status = record.status;
        if (status !== "active" && status !== "archived") throw new Error("status 必须是 active 或 archived");
        const node = await withTopicGraphRevision(chatHome, longAgentId, (expectedRevision) => updateTopicNodeStatus({
          chatHome, longAgentId, nodeId, status, expectedRevision,
        }));
        return result({ operation, node });
      }

      // relay: a real user message with a durable relay marker. Triggering the node round belongs to the
      // node session API / round workflow, not to this tool.
      const nodeId = text(record.nodeId ?? record.targetNodeId, "targetNodeId", 200);
      const relayText = text(record.text, "text", 20_000);
      const requestId = text(record.requestId, "requestId", 200);
      const graph = await readTopicGraph(chatHome, longAgentId);
      const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId);
      if (node === undefined) throw new Error(`找不到主题节点：${nodeId}`);
      const decision = authorizeTopicSession({ graph, requester: { kind: "agent", longAgentId }, sessionId: node.sessionId, capability: "relay" });
      if (!decision.applicable || !decision.allowed) throw new Error(decision.reason ?? "只能代传自己名下主题树的节点");
      const session = await openChatSession({ chatHome, projectId: longAgentId, sessionId: node.sessionId });
      const already = session.manager.getBranch().some((entry) => {
        const value = entry as { type?: string; customType?: string; data?: unknown };
        return value.type === "custom" && value.customType === TOPIC_RELAY_CUSTOM_TYPE
          && typeof value.data === "object" && value.data !== null && (value.data as { requestId?: unknown }).requestId === requestId;
      });
      if (already) return result({ operation, created: false, nodeId, sessionId: node.sessionId });
      const entryId = appendChatUserMessage(session.manager, relayText);
      session.manager.appendCustomEntry(TOPIC_RELAY_CUSTOM_TYPE, {
        requestId, relayedByLongAgentId: longAgentId, source: "relay", userEntryId: entryId,
      });
      session.manager.flush();
      return result({ operation, created: true, nodeId, sessionId: node.sessionId, userEntryId: entryId });
    },
  }),
);
